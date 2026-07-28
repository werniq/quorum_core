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
import { SqliteN8nConnectorRepositories } from "../../src/infrastructure/db/repositories/sqlite-n8n-connector-repositories.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import { createIngestPolledEvidenceHandler } from "../../src/infrastructure/ingestion/ingest-polled-evidence.js";
import { createN8nPollingAdapter } from "../../src/infrastructure/n8n/poll-workflow.js";
import { normalizeN8nExecution } from "../../src/domain/n8n/normalize-execution.js";
import { suggestCadenceFromN8nSchedule } from "../../src/domain/n8n/schedule-suggestion.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";
const API_KEY = "n8n-test-api-key-value-xyz";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-n8n-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function seedPollWorkflow(
  sqlite: BetterSqliteDatabase.Database,
  options?: { contractActive?: boolean },
) {
  const core = new SqliteCoreRepositories(sqlite);
  const connectors = new SqliteN8nConnectorRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const clock = new FixedClock(new Date("2026-07-18T12:00:00.000Z"));
  const now = clock.now().toISOString();
  const workflowId = createId();

  const connector = connectors.createConnector(tenant.id, {
    name: "Prod n8n",
    baseUrl: "https://n8n.example.com",
    encryptedApiKey: encryptCredentialSecret(API_KEY, KEK),
    nowIso: now,
  });

  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "Invoices",
    externalWorkflowId: "wf-ext-1",
    description: null,
    monitoringMethod: "poll",
    isActive: true,
    monitoringStartedAt: now,
  });
  connectors.bindWorkflowConnector(tenant.id, workflowId, connector.id);

  core.createWorkflowContract(tenant.id, {
    id: createId(),
    workflowId,
    name: "Heartbeat",
    businessPurpose: "Invoice sync",
    cadenceType: "event_driven",
    cadenceValue: "event",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: null,
    allowedLatenessMinutes: 0,
    maxQuietWindowMinutes: 60,
    initialGraceMinutes: 0,
    emptyResultPolicy: "allowed",
    countLessSuccessAllowed: true,
    notificationBackoffMinutes: 240,
    evidenceLevel: "basic",
    schemaVersion: 1,
    isActive: options?.contractActive ?? true,
    activatedAt: options?.contractActive === false ? null : now,
  });

  const ingestPolledEvidence = createIngestPolledEvidenceHandler({
    sqlite,
    clock,
    getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
  });

  function createAdapter(fetchImpl: typeof fetch) {
    return createN8nPollingAdapter({
      sqlite,
      clock,
      kek: KEK,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      ingestPolledEvidence,
      httpOptions: {
        connectTimeoutMs: 1_000,
        readTimeoutMs: 1_000,
        maxResponseBytes: 65_536,
        maxRedirects: 2,
        resolveAddresses: async () => ["203.0.113.50"],
        fetchImpl,
      },
    });
  }

  return {
    tenant,
    workflowId,
    connector,
    connectors,
    clock,
    createAdapter,
    ingestPolledEvidence,
  };
}

describe("normalizeN8nExecution", () => {
  it("maps finished executions into the push-compatible evidence command", () => {
    const ok = normalizeN8nExecution({
      id: 42,
      finished: true,
      status: "success",
      stoppedAt: "2026-07-18T11:00:00.000Z",
      itemsProcessed: 3,
    });
    expect(ok).toMatchObject({
      ok: true,
      evidence: {
        evidenceStatus: "success",
        externalExecutionRef: "42",
        idempotencyKey: "n8n:execution:42",
        itemsProcessed: 3,
      },
    });

    const failed = normalizeN8nExecution({
      id: "99",
      finished: true,
      status: "error",
      stoppedAt: "2026-07-18T11:05:00.000Z",
    });
    expect(failed).toMatchObject({
      ok: true,
      evidence: {
        evidenceStatus: "failure",
        idempotencyKey: "n8n:execution:99",
      },
    });

    expect(
      normalizeN8nExecution({
        id: 1,
        finished: false,
        status: "running",
        startedAt: "2026-07-18T11:00:00.000Z",
      }),
    ).toEqual({ ok: false, code: "NOT_FINISHED" });
  });
});

describe("schedule suggestions", () => {
  it("never auto-activates and always requires explicit confirmation", () => {
    const suggestion = suggestCadenceFromN8nSchedule({
      cronExpression: "0 * * * *",
      timezone: "Europe/Warsaw",
    });
    expect(suggestion.requiresExplicitConfirmation).toBe(true);
    expect(suggestion.confirmationFields).toContain("empty_result_policy");
    expect(suggestion.cadenceValue).toBe("0 * * * *");
  });
});

describe("n8n polling adapter", () => {
  it("validates connectivity and exposes health without leaking secrets", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    const adapter = seeded.createAdapter(async (input) => {
      const url = String(input);
      expect(url).toContain("https://n8n.example.com/api/v1/workflows");
      return new Response(JSON.stringify({ data: [{ id: "1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await adapter.validateConnectivity({
      tenantId: seeded.tenant.id,
      connectorId: seeded.connector.id,
    });
    expect(result.status).toBe("healthy");
    const health = adapter.getHealthView(seeded.tenant.id, seeded.connector.id);
    expect(health?.health).toBe("healthy");
    expect(JSON.stringify(health)).not.toContain(API_KEY);
    expect(JSON.stringify(health)).not.toContain(KEK);
  });

  it("records auth failures as connector health without writing workflow evidence", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    const adapter = seeded.createAdapter(
      async () =>
        new Response(JSON.stringify({ message: `bad key ${API_KEY}` }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await adapter.validateConnectivity({
      tenantId: seeded.tenant.id,
      connectorId: seeded.connector.id,
    });
    expect(result).toMatchObject({
      status: "connector_error",
      health: "auth_failed",
    });
    const health = adapter.getHealthView(seeded.tenant.id, seeded.connector.id);
    expect(health?.health).toBe("auth_failed");
    expect(health?.lastErrorSummary).not.toContain(API_KEY);
    expect(
      (
        sqlite.prepare(`SELECT COUNT(*) AS c FROM heartbeat_events`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("polls executions into durable evidence and avoids duplicates after restart", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    const payload = {
      data: [
        {
          id: 2,
          finished: true,
          status: "success",
          stoppedAt: "2026-07-18T11:10:00.000Z",
          workflowId: "wf-ext-1",
        },
        {
          id: 1,
          finished: true,
          status: "error",
          stoppedAt: "2026-07-18T11:00:00.000Z",
          workflowId: "wf-ext-1",
        },
      ],
    };
    const adapter = seeded.createAdapter(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const first = await adapter.pollWorkflow({
      tenantId: seeded.tenant.id,
      workflowId: seeded.workflowId,
    });
    expect(first).toEqual({
      status: "polled",
      ingested: 2,
      skipped: 0,
      replays: 0,
    });

    const events = sqlite
      .prepare(
        `SELECT status, idempotency_key FROM heartbeat_events
         WHERE workflow_id = ? ORDER BY executed_at`,
      )
      .all(seeded.workflowId) as Array<{
      status: string;
      idempotency_key: string;
    }>;
    expect(events).toEqual([
      { status: "failure", idempotency_key: "n8n:execution:1" },
      { status: "success", idempotency_key: "n8n:execution:2" },
    ]);

    const checkpoint = seeded.connectors.getCheckpoint(
      seeded.tenant.id,
      seeded.workflowId,
    );
    expect(checkpoint?.lastSeenExecutionId).toBe("2");

    const second = await adapter.pollWorkflow({
      tenantId: seeded.tenant.id,
      workflowId: seeded.workflowId,
    });
    expect(second).toEqual({
      status: "polled",
      ingested: 0,
      skipped: 0,
      replays: 0,
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ?`,
          )
          .get(seeded.workflowId) as { c: number }
      ).c,
    ).toBe(2);
  });

  it("does not silently activate inactive contracts while polling", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite, { contractActive: false });
    const adapter = seeded.createAdapter(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 7,
                finished: true,
                status: "success",
                stoppedAt: "2026-07-18T11:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await adapter.pollWorkflow({
      tenantId: seeded.tenant.id,
      workflowId: seeded.workflowId,
    });
    expect(result.status).toBe("contract_inactive");
    expect(
      (
        sqlite.prepare(`SELECT COUNT(*) AS c FROM heartbeat_events`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    const contract = sqlite
      .prepare(
        `SELECT is_active, activated_at FROM workflow_contracts WHERE workflow_id = ?`,
      )
      .get(seeded.workflowId) as {
      is_active: number;
      activated_at: string | null;
    };
    expect(contract.is_active).toBe(0);
    expect(contract.activated_at).toBeNull();
  });

  it("treats polling failures as connector evidence, not workflow success", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    const adapter = seeded.createAdapter(
      async () => new Response("upstream down", { status: 503 }),
    );

    const result = await adapter.pollWorkflow({
      tenantId: seeded.tenant.id,
      workflowId: seeded.workflowId,
    });
    expect(result.status).toBe("connector_error");
    expect(
      (
        sqlite.prepare(`SELECT COUNT(*) AS c FROM heartbeat_events`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    const incident = sqlite
      .prepare(
        `SELECT incident_type, summary FROM incidents WHERE tenant_id = ?`,
      )
      .get(seeded.tenant.id) as { incident_type: string; summary: string };
    expect(incident.incident_type).toBe("connector_unavailable");
    expect(incident.summary).not.toContain(API_KEY);
  });

  it("resolves connector_unavailable incidents after polling recovers", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    let calls = 0;
    const adapter = seeded.createAdapter(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("upstream down", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 9,
              finished: true,
              status: "success",
              stoppedAt: "2026-07-18T11:30:00.000Z",
              workflowId: "wf-ext-1",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const failed = await adapter.pollWorkflow({
      tenantId: seeded.tenant.id,
      workflowId: seeded.workflowId,
    });
    expect(failed.status).toBe("connector_error");
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents WHERE tenant_id = ? AND incident_type = 'connector_unavailable'`,
          )
          .get(seeded.tenant.id) as { status: string }
      ).status,
    ).toBe("open");

    const recovered = await adapter.pollWorkflow({
      tenantId: seeded.tenant.id,
      workflowId: seeded.workflowId,
    });
    expect(recovered.status).toBe("polled");
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents WHERE tenant_id = ? AND incident_type = 'connector_unavailable'`,
          )
          .get(seeded.tenant.id) as { status: string }
      ).status,
    ).toBe("resolved");
    expect(
      (
        sqlite
          .prepare(`SELECT health FROM n8n_connectors WHERE id = ?`)
          .get(seeded.connector.id) as { health: string }
      ).health,
    ).toBe("healthy");
  });
});
