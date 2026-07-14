import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { SqliteAlertingRepositories } from "../../src/infrastructure/db/repositories/sqlite-alerting-repositories.js";
import { SqliteVolumeRepositories } from "../../src/infrastructure/db/repositories/sqlite-volume-repositories.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { createWatcher } from "../../src/infrastructure/watcher/run-watcher.js";
import { runVolumeEvaluatorTick } from "../../src/infrastructure/volume/run-volume-evaluator.js";
import { queryContractCatalog } from "../../src/infrastructure/catalog/query-catalog.js";
import {
  evaluationDeadline,
  computeVolumeWindow,
} from "../../src/domain/volume/compute-window.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-vol-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  const { sqlite } = openSqliteDatabase(filePath);
  openConnections.push(sqlite);
  migrateSqliteToLatest(sqlite);
  return sqlite;
}

afterEach(() => {
  while (openConnections.length > 0) {
    try {
      openConnections.pop()?.close();
    } catch {
      // ignore
    }
  }
  for (const filePath of tempFiles.splice(0, tempFiles.length)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        const candidate = `${filePath}${suffix}`;
        if (fs.existsSync(candidate)) {
          fs.unlinkSync(candidate);
        }
      } catch {
        // ignore
      }
    }
  }
});

function insertHeartbeat(
  sqlite: BetterSqliteDatabase.Database,
  input: {
    tenantId: string;
    workflowId: string;
    executedAt: string;
    itemsProcessed: number | null;
    idempotencyKey: string;
    status?: "success" | "failure" | "empty_result";
  },
): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO heartbeat_events (
         id, tenant_id, workflow_id, received_at, executed_at, status,
         items_processed, external_execution_ref, idempotency_key,
         payload_schema_version, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'exec', ?, 1, '{}', ?)`,
    )
    .run(
      createId(),
      input.tenantId,
      input.workflowId,
      input.executedAt,
      input.executedAt,
      input.status ?? "success",
      input.itemsProcessed,
      input.idempotencyKey,
      now,
    );
}

function seedVolumeContract(sqlite: BetterSqliteDatabase.Database) {
  const core = new SqliteCoreRepositories(sqlite);
  const volume = new SqliteVolumeRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const workflowId = createId();
  const contractId = createId();
  const activatedAt = "2026-03-01T00:00:00.000Z";
  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "Volume workflow",
    externalWorkflowId: createId(),
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: activatedAt,
  });
  core.createWorkflowContract(tenant.id, {
    id: contractId,
    workflowId,
    name: "Volume contract",
    businessPurpose: "Daily volume check",
    cadenceType: "event_driven",
    cadenceValue: "event",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: "UTC",
    allowedLatenessMinutes: 0,
    maxQuietWindowMinutes: 120,
    initialGraceMinutes: 0,
    emptyResultPolicy: "allowed",
    countLessSuccessAllowed: true,
    notificationBackoffMinutes: 60,
    evidenceLevel: "basic",
    schemaVersion: 1,
    isActive: true,
    activatedAt,
  });
  const rule = volume.createVolumeRule(tenant.id, {
    id: createId(),
    workflowContractId: contractId,
    minimumCount: 5,
    maximumCount: 20,
    windowType: "daily",
    timezone: "UTC",
    weekStartsOn: 1,
    evaluationGraceMinutes: 0,
    violationSeverity: "warning",
    activatedAt,
  });
  return { tenant, workflowId, contractId, rule, core };
}

function volumeDeps(
  sqlite: BetterSqliteDatabase.Database,
  clock: FixedClock,
  claimOwner: string,
) {
  const volume = new SqliteVolumeRepositories(sqlite);
  const alerting = new SqliteAlertingRepositories(sqlite);
  return {
    volume,
    alerting,
    clock: () => clock.now(),
    claimOwner,
    listContractsForRule: (rule: { workflowContractId: string }) => {
      const row = sqlite
        .prepare(
          `SELECT c.is_active AS contract_active, w.id AS workflow_id,
                  w.client_id, w.is_active AS workflow_active, c.tenant_id
           FROM workflow_contracts c
           JOIN workflows w ON w.id = c.workflow_id AND w.tenant_id = c.tenant_id
           WHERE c.id = ?`,
        )
        .get(rule.workflowContractId) as
        | {
            contract_active: number;
            workflow_id: string;
            client_id: string | null;
            workflow_active: number;
            tenant_id: string;
          }
        | undefined;
      if (!row || !row.contract_active || !row.workflow_active) {
        return null;
      }
      return {
        workflowId: row.workflow_id,
        clientId: row.client_id,
        contractActive: true,
      };
    },
  };
}

describe("volume evaluator integration", () => {
  it("finalizes within-band evaluation and shows Collecting in catalog before deadline", () => {
    const sqlite = openDb();
    const { tenant, workflowId, contractId } = seedVolumeContract(sqlite);
    insertHeartbeat(sqlite, {
      tenantId: tenant.id,
      workflowId,
      executedAt: "2026-03-15T10:00:00.000Z",
      itemsProcessed: 8,
      idempotencyKey: "hb-1",
    });
    const duringWindow = new FixedClock(new Date("2026-03-15T18:00:00.000Z"));
    const catalogDuring = queryContractCatalog({
      sqlite,
      clock: duringWindow,
      tenantId: tenant.id,
      publicBaseUrl: "http://localhost:3000",
    });
    const rowDuring = catalogDuring.find((r) => r.contractId === contractId);
    expect(rowDuring?.volumeSummary?.status).toBe("Collecting");

    const deadline = evaluationDeadline(
      computeVolumeWindow("daily", "UTC", new Date("2026-03-15T18:00:00.000Z"))
        .windowEnd,
      0,
    );
    const clock = new FixedClock(deadline);
    runVolumeEvaluatorTick(tenant.id, volumeDeps(sqlite, clock, "worker-a"));

    const evaluation = sqlite
      .prepare(
        `SELECT result, total_items, is_finalized FROM volume_band_evaluations
         WHERE tenant_id = ? AND workflow_contract_id = ?`,
      )
      .get(tenant.id, contractId) as {
      result: string;
      total_items: number;
      is_finalized: number;
    };
    expect(evaluation.result).toBe("within_band");
    expect(evaluation.total_items).toBe(8);
    expect(evaluation.is_finalized).toBe(1);

    const catalogAfter = queryContractCatalog({
      sqlite,
      clock,
      tenantId: tenant.id,
      publicBaseUrl: "http://localhost:3000",
    });
    expect(
      catalogAfter.find((r) => r.contractId === contractId)?.volumeSummary
        ?.status,
    ).toBe("Within band");
    expect(
      catalogAfter.find((r) => r.contractId === contractId)?.volumeSummary
        ?.evidenceLevel,
    ).toBe("basic");
  });

  it("opens distinct volume incidents without suppressing cadence incidents", () => {
    const sqlite = openDb();
    const { tenant, workflowId, rule } = seedVolumeContract(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      clientId: null,
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "Cadence silent absence",
      observedAt: "2026-03-15T00:00:00.000Z",
    });

    const deadline = evaluationDeadline(
      computeVolumeWindow("daily", "UTC", new Date("2026-03-15T18:00:00.000Z"))
        .windowEnd,
      0,
    );
    const clock = new FixedClock(deadline);
    runVolumeEvaluatorTick(tenant.id, volumeDeps(sqlite, clock, "worker-a"));

    const incidents = sqlite
      .prepare(
        `SELECT incident_type FROM incidents
         WHERE tenant_id = ? AND workflow_id = ? AND status = 'open'`,
      )
      .all(tenant.id, workflowId) as Array<{ incident_type: string }>;
    expect(incidents.map((i) => i.incident_type).sort()).toEqual([
      "silent_absence",
      "volume_below_minimum",
    ]);

    const low = alerting.getUnresolvedVolumeIncident(
      tenant.id,
      workflowId,
      rule.id,
      computeVolumeWindow(
        "daily",
        "UTC",
        new Date("2026-03-15T18:00:00.000Z"),
      ).windowStart.toISOString(),
      "volume_below_minimum",
    );
    expect(low).not.toBeNull();
  });

  it("prevents duplicate evaluation claims from a second worker", () => {
    const sqlite = openDb();
    const { tenant } = seedVolumeContract(sqlite);
    const clock = new FixedClock(
      evaluationDeadline(
        computeVolumeWindow(
          "daily",
          "UTC",
          new Date("2026-03-15T18:00:00.000Z"),
        ).windowEnd,
        0,
      ),
    );
    const first = runVolumeEvaluatorTick(
      tenant.id,
      volumeDeps(sqlite, clock, "worker-a"),
    );
    const second = runVolumeEvaluatorTick(
      tenant.id,
      volumeDeps(sqlite, clock, "worker-b"),
    );
    expect(first.evaluationsUpserted).toBeGreaterThanOrEqual(1);
    expect(second.evaluationsUpserted).toBe(0);
  });

  it("persists finalized evaluations across watcher restart", () => {
    const sqlite = openDb();
    const { tenant, workflowId, contractId } = seedVolumeContract(sqlite);
    insertHeartbeat(sqlite, {
      tenantId: tenant.id,
      workflowId,
      executedAt: "2026-03-15T11:00:00.000Z",
      itemsProcessed: 10,
      idempotencyKey: "hb-restart",
    });
    const deadline = evaluationDeadline(
      computeVolumeWindow("daily", "UTC", new Date("2026-03-15T18:00:00.000Z"))
        .windowEnd,
      0,
    );
    const clock = new FixedClock(deadline);
    const watcher = createWatcher({
      sqlite,
      clock,
      claimOwner: "watcher-1",
      claimTtlMs: 30_000,
      getSchemaReadiness: () => ({
        status: "ready" as const,
        appliedMigrations: [],
      }),
    });
    watcher.runTick(tenant.id);
    const before = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM volume_band_evaluations
         WHERE tenant_id = ? AND workflow_contract_id = ? AND is_finalized = 1`,
      )
      .get(tenant.id, contractId) as { c: number };
    expect(before.c).toBe(1);

    const watcher2 = createWatcher({
      sqlite,
      clock,
      claimOwner: "watcher-2",
      claimTtlMs: 30_000,
      getSchemaReadiness: () => ({
        status: "ready" as const,
        appliedMigrations: [],
      }),
    });
    watcher2.runTick(tenant.id);
    const after = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM volume_band_evaluations
         WHERE tenant_id = ? AND workflow_contract_id = ? AND is_finalized = 1`,
      )
      .get(tenant.id, contractId) as { c: number };
    expect(after.c).toBe(1);
  });

  it("ignores duplicate heartbeat idempotency keys for volume totals", () => {
    const sqlite = openDb();
    const { tenant, workflowId } = seedVolumeContract(sqlite);
    insertHeartbeat(sqlite, {
      tenantId: tenant.id,
      workflowId,
      executedAt: "2026-03-15T09:00:00.000Z",
      itemsProcessed: 6,
      idempotencyKey: "dup-key",
    });
    expect(() =>
      insertHeartbeat(sqlite, {
        tenantId: tenant.id,
        workflowId,
        executedAt: "2026-03-15T09:30:00.000Z",
        itemsProcessed: 99,
        idempotencyKey: "dup-key",
      }),
    ).toThrow();

    const deadline = evaluationDeadline(
      computeVolumeWindow("daily", "UTC", new Date("2026-03-15T18:00:00.000Z"))
        .windowEnd,
      0,
    );
    runVolumeEvaluatorTick(
      tenant.id,
      volumeDeps(sqlite, new FixedClock(deadline), "worker-a"),
    );
    const row = sqlite
      .prepare(
        `SELECT total_items FROM volume_band_evaluations WHERE tenant_id = ?`,
      )
      .get(tenant.id) as { total_items: number };
    expect(row.total_items).toBe(6);
  });
});
