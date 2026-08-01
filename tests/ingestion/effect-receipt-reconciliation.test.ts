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
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import {
  buildHeartbeatSigningPayload,
  sha256Hex,
  signHeartbeatHmacSha256,
} from "../../src/infrastructure/security/heartbeat-hmac.js";
import { createIngestHeartbeatHandler } from "../../src/infrastructure/ingestion/ingest-heartbeat.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { queryContractCatalog } from "../../src/infrastructure/catalog/query-catalog.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";
const SECRET = "workflow-hmac-secret";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-effect-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch {
        // ignore
      }
    }
  }
});

function seed(sqlite: BetterSqliteDatabase.Database, enabled: boolean) {
  const core = new SqliteCoreRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const now = new Date("2026-07-18T08:00:00.000Z").toISOString();
  const workflowId = createId();
  const keyId = "hk_effect";
  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "Effect sync",
    externalWorkflowId: "n8n-effect",
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: now,
  });
  core.createWorkflowContract(tenant.id, {
    id: createId(),
    workflowId,
    name: "HB",
    businessPurpose: "sync",
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
    isActive: true,
    activatedAt: now,
  });
  if (enabled) {
    sqlite
      .prepare(
        `UPDATE workflow_contracts SET effect_reconciliation_enabled = 1
         WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .run(tenant.id, workflowId);
  }
  core.createCredential(tenant.id, {
    id: createId(),
    workflowId,
    keyId,
    encryptedSecretOrVerificationMaterial: encryptCredentialSecret(SECRET, KEK),
    status: "active",
    rotatedFromId: null,
    revokedAt: null,
  });
  const clock = new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
  const ingest = createIngestHeartbeatHandler({
    sqlite,
    env: loadEnv({
      NODE_ENV: "test",
      QUORUM_CREDENTIAL_KEK: KEK,
      HEARTBEAT_RATE_LIMIT_PER_MINUTE: "60",
      HEARTBEAT_RATE_LIMIT_BURST: "20",
    }),
    clock,
    getSchemaReadiness: () => ({
      status: "ready",
      appliedMigrations: ["0020_effect_receipt_reconciliation"],
    }),
  });
  return { tenant, workflowId, keyId, ingest, clock };
}

function ingestOk(
  ingest: ReturnType<typeof createIngestHeartbeatHandler>,
  workflowId: string,
  keyId: string,
  idempotencyKey: string,
  body: object,
) {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const timestampSeconds = String(
    Math.floor(new Date("2026-07-18T08:00:00.000Z").getTime() / 1000),
  );
  const pathName = `/api/v1/workflows/${workflowId}/heartbeats`;
  const signature = signHeartbeatHmacSha256(
    SECRET,
    buildHeartbeatSigningPayload({
      method: "POST",
      path: pathName,
      timestampSeconds,
      idempotencyKey,
      bodySha256Hex: sha256Hex(rawBody),
    }),
  );
  expect(
    ingest({
      workflowId,
      method: "POST",
      path: pathName,
      keyId,
      timestampSeconds,
      idempotencyKey,
      signatureHex: signature,
      rawBody,
    }),
  ).toMatchObject({ status: "accepted" });
}

describe("effect receipt reconciliation ingest", () => {
  it("keeps receipts inert when reconciliation is not configured", () => {
    const sqlite = openDb();
    const { tenant, workflowId, keyId, ingest, clock } = seed(sqlite, false);

    ingestOk(ingest, workflowId, keyId, "noop-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: { receipt: { expectedCount: 2, writtenCount: 1 } },
    });

    expect(
      sqlite
        .prepare(
          `SELECT id FROM incidents WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
        )
        .get(workflowId),
    ).toBeUndefined();

    const row = queryContractCatalog({
      sqlite,
      clock,
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    }).find((r) => r.workflowId === workflowId);
    expect(row?.dimensions.reconciliation).toBe("not_configured");
  });

  it("accepts workflows with no receipt data when enabled", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seed(sqlite, true);
    ingestOk(ingest, workflowId, keyId, "none-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 2,
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT last_effect_reconciliation_status AS s FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { s: string }
      ).s,
    ).toBe("not_evaluated");
    expect(
      sqlite
        .prepare(
          `SELECT id FROM incidents WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
        )
        .get(workflowId),
    ).toBeUndefined();
  });

  it("does not fail on partial or malformed receipt fields", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seed(sqlite, true);
    ingestOk(ingest, workflowId, keyId, "partial-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: { receipt: { expectedCount: 5, writtenCount: "nope" } },
    });
    expect(
      sqlite
        .prepare(
          `SELECT id FROM incidents WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
        )
        .get(workflowId),
    ).toBeUndefined();
  });

  it("keeps an open mismatch open through missing, partial, and malformed receipts", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seed(sqlite, true);

    ingestOk(ingest, workflowId, keyId, "open-mis", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: { receipt: { expectedCount: 5, writtenCount: 3 } },
    });
    const open = sqlite
      .prepare(
        `SELECT id, status FROM incidents
         WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
      )
      .get(workflowId) as { id: string; status: string };
    expect(open.status).toBe("open");

    ingestOk(ingest, workflowId, keyId, "missing-receipt", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:01:00Z",
      status: "success",
      itemsProcessed: 2,
    });
    ingestOk(ingest, workflowId, keyId, "partial-receipt", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:02:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: { receipt: { expectedCount: 5 } },
    });
    ingestOk(ingest, workflowId, keyId, "malformed-receipt", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:03:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: { receipt: { expectedCount: 5, writtenCount: "bad" } },
    });

    const stillOpen = sqlite
      .prepare(
        `SELECT id, status FROM incidents
         WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
      )
      .get(workflowId) as { id: string; status: string };
    expect(stillOpen.id).toBe(open.id);
    expect(stillOpen.status).toBe("open");

    ingestOk(ingest, workflowId, keyId, "matching-receipt", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:04:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: { receipt: { expectedCount: 5, writtenCount: 5 } },
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents
             WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("resolved");
  });

  it("opens one mismatch incident, updates on repeat, and recovers on match", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seed(sqlite, true);

    ingestOk(ingest, workflowId, keyId, "mis-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: {
        receipt: {
          inputBatchId: "b1",
          expectedCount: 5,
          writtenCount: 3,
          destinationName: "crm",
        },
      },
    });
    const first = sqlite
      .prepare(
        `SELECT id, status FROM incidents
         WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
      )
      .get(workflowId) as { id: string; status: string };
    expect(first.status).toBe("open");

    ingestOk(ingest, workflowId, keyId, "mis-2", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:05:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: { receipt: { expectedCount: 5, writtenCount: 2 } },
    });
    const second = sqlite
      .prepare(
        `SELECT id, status FROM incidents
         WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
      )
      .get(workflowId) as { id: string; status: string };
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("open");
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM incidents
             WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
          )
          .get(workflowId) as { n: number }
      ).n,
    ).toBe(1);

    ingestOk(ingest, workflowId, keyId, "ok-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:10:00Z",
      status: "success",
      itemsProcessed: 2,
      metadata: { receipt: { expectedCount: 5, writtenCount: 5 } },
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents
             WHERE workflow_id = ? AND incident_type = 'effect_count_mismatch'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("resolved");
    expect(
      (
        sqlite
          .prepare(
            `SELECT last_effect_reconciliation_status AS s FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { s: string }
      ).s,
    ).toBe("passed");
  });
});
