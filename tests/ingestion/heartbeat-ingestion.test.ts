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
import { buildApp } from "../../src/infrastructure/http/app.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";
const SECRET = "workflow-hmac-secret";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-ingest-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function seedWorkflow(
  sqlite: BetterSqliteDatabase.Database,
  options?: {
    emptyResultPolicy?: "allowed" | "warning" | "failure";
    countLessSuccessAllowed?: boolean;
    rateLimitEnv?: Record<string, string>;
  },
) {
  const core = new SqliteCoreRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const now = new Date("2026-07-18T08:00:00.000Z").toISOString();
  const workflowId = createId();
  const keyId = "hk_test";
  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "Invoices",
    externalWorkflowId: "n8n-1",
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
    initialGraceMinutes: 10,
    emptyResultPolicy: options?.emptyResultPolicy ?? "allowed",
    countLessSuccessAllowed: options?.countLessSuccessAllowed ?? true,
    notificationBackoffMinutes: 240,
    evidenceLevel: "basic",
    schemaVersion: 1,
    isActive: true,
    activatedAt: now,
  });
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
  const env = loadEnv({
    NODE_ENV: "test",
    QUORUM_CREDENTIAL_KEK: KEK,
    HEARTBEAT_RATE_LIMIT_PER_MINUTE: "60",
    HEARTBEAT_RATE_LIMIT_BURST: "20",
    ...options?.rateLimitEnv,
  });
  const ingest = createIngestHeartbeatHandler({
    sqlite,
    env,
    clock,
    getSchemaReadiness: () => ({
      status: "ready",
      appliedMigrations: ["0004_incidents_alerting_outbox"],
    }),
  });

  return { tenant, workflowId, keyId, ingest, env, clock };
}

function signedRequest(input: {
  workflowId: string;
  keyId: string;
  idempotencyKey: string;
  body: object;
  timestampSeconds?: string;
}) {
  const rawBody = Buffer.from(JSON.stringify(input.body), "utf8");
  const timestampSeconds =
    input.timestampSeconds ??
    String(Math.floor(new Date("2026-07-18T08:00:00.000Z").getTime() / 1000));
  const path = `/api/v1/workflows/${input.workflowId}/heartbeats`;
  const signature = signHeartbeatHmacSha256(
    SECRET,
    buildHeartbeatSigningPayload({
      method: "POST",
      path,
      timestampSeconds,
      idempotencyKey: input.idempotencyKey,
      bodySha256Hex: sha256Hex(rawBody),
    }),
  );
  return { rawBody, timestampSeconds, path, signature };
}

describe("secure heartbeat ingestion", () => {
  it("accepts a signed heartbeat and keeps evidence basic", async () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest, env } = seedWorkflow(sqlite);
    const signed = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "exec-1",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 12,
        externalExecutionRef: "n8n-execution-123",
        metadata: { environment: "production" },
      },
    });

    const app = await buildApp({
      env,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: [],
      }),
      ingestHeartbeat: ingest,
    });

    const response = await app.inject({
      method: "POST",
      url: signed.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": signed.timestampSeconds,
        "x-quorum-idempotency-key": "exec-1",
        "x-quorum-signature": signed.signature,
      },
      payload: signed.rawBody,
    });

    expect(response.statusCode).toBe(202);
    const state = sqlite
      .prepare(
        `SELECT current_health, evidence_level, evidence_summary_code
         FROM workflow_states WHERE workflow_id = ?`,
      )
      .get(workflowId) as {
      current_health: string;
      evidence_level: string;
      evidence_summary_code: string;
    };
    expect(state.evidence_level).toBe("basic");
    expect(state.current_health).toBe("healthy");
    await app.close();
  });

  it("returns idempotent 202 for identical replay and 409 for conflicting body", async () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest, env } = seedWorkflow(sqlite);
    const body = {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 1,
    };
    const first = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "same-key",
      body,
    });
    const app = await buildApp({
      env,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      ingestHeartbeat: ingest,
    });

    const ok = await app.inject({
      method: "POST",
      url: first.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": first.timestampSeconds,
        "x-quorum-idempotency-key": "same-key",
        "x-quorum-signature": first.signature,
      },
      payload: first.rawBody,
    });
    expect(ok.statusCode).toBe(202);

    const replay = await app.inject({
      method: "POST",
      url: first.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": first.timestampSeconds,
        "x-quorum-idempotency-key": "same-key",
        "x-quorum-signature": first.signature,
      },
      payload: first.rawBody,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ idempotentReplay: true });

    const conflict = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "same-key",
      body: { ...body, itemsProcessed: 9 },
    });
    const conflictResponse = await app.inject({
      method: "POST",
      url: conflict.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": conflict.timestampSeconds,
        "x-quorum-idempotency-key": "same-key",
        "x-quorum-signature": conflict.signature,
      },
      payload: conflict.rawBody,
    });
    expect(conflictResponse.statusCode).toBe(409);
    await app.close();
  });

  it("rejects bad signatures with 401 and unknown workflows with 404", async () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest, env } = seedWorkflow(sqlite);
    const signed = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "x",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 1,
      },
    });
    const app = await buildApp({
      env,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      ingestHeartbeat: ingest,
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: signed.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": signed.timestampSeconds,
        "x-quorum-idempotency-key": "x",
        "x-quorum-signature": "deadbeef",
      },
      payload: signed.rawBody,
    });
    expect(unauthorized.statusCode).toBe(401);

    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/${createId()}/heartbeats`,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": signed.timestampSeconds,
        "x-quorum-idempotency-key": "y",
        "x-quorum-signature": signed.signature,
      },
      payload: signed.rawBody,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "NOT_FOUND" } });
    await app.close();
  });

  it("returns 409 CONTRACT_NOT_ACTIVE for inactive workflow or missing active contract", async () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest, env } = seedWorkflow(sqlite);
    const signed = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "inactive-1",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 1,
      },
    });
    const app = await buildApp({
      env,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      ingestHeartbeat: ingest,
    });

    sqlite.prepare(`UPDATE workflows SET is_active = 0 WHERE id = ?`).run(workflowId);
    const inactive = await app.inject({
      method: "POST",
      url: signed.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": signed.timestampSeconds,
        "x-quorum-idempotency-key": "inactive-1",
        "x-quorum-signature": signed.signature,
      },
      payload: signed.rawBody,
    });
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json()).toMatchObject({
      error: {
        code: "CONTRACT_NOT_ACTIVE",
        message: expect.stringContaining("activate monitoring"),
      },
    });

    sqlite.prepare(`UPDATE workflows SET is_active = 1 WHERE id = ?`).run(workflowId);
    sqlite
      .prepare(`UPDATE workflow_contracts SET is_active = 0 WHERE workflow_id = ?`)
      .run(workflowId);
    const noContract = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "no-contract-1",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 1,
      },
    });
    const missingContract = await app.inject({
      method: "POST",
      url: noContract.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": noContract.timestampSeconds,
        "x-quorum-idempotency-key": "no-contract-1",
        "x-quorum-signature": noContract.signature,
      },
      payload: noContract.rawBody,
    });
    expect(missingContract.statusCode).toBe(409);
    expect(missingContract.json()).toMatchObject({
      error: { code: "CONTRACT_NOT_ACTIVE" },
    });
    await app.close();
  });

  it("rate-limits without creating heartbeat events", async () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest, env } = seedWorkflow(sqlite, {
      rateLimitEnv: {
        HEARTBEAT_RATE_LIMIT_PER_MINUTE: "1",
        HEARTBEAT_RATE_LIMIT_BURST: "0",
      },
    });
    const app = await buildApp({
      env,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      ingestHeartbeat: ingest,
    });

    for (const key of ["a", "b"]) {
      const signed = signedRequest({
        workflowId,
        keyId,
        idempotencyKey: key,
        body: {
          schemaVersion: 1,
          executedAt: "2026-07-18T08:00:00Z",
          status: "success",
          itemsProcessed: 1,
        },
      });
      const response = await app.inject({
        method: "POST",
        url: signed.path,
        headers: {
          "content-type": "application/json",
          "x-quorum-key-id": keyId,
          "x-quorum-timestamp": signed.timestampSeconds,
          "x-quorum-idempotency-key": key,
          "x-quorum-signature": signed.signature,
        },
        payload: signed.rawBody,
      });
      if (key === "a") {
        expect(response.statusCode).toBe(202);
      } else {
        expect(response.statusCode).toBe(429);
      }
    }

    const count = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ?`,
      )
      .get(workflowId) as { c: number };
    expect(count.c).toBe(1);
    await app.close();
  });

  it("opens hard_failure incidents and resolves them on later success", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seedWorkflow(sqlite, {
      emptyResultPolicy: "failure",
    });

    const failure = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "fail-1",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "failure",
      },
    });
    expect(
      ingest({
        workflowId,
        method: "POST",
        path: failure.path,
        keyId,
        timestampSeconds: failure.timestampSeconds,
        idempotencyKey: "fail-1",
        signatureHex: failure.signature,
        rawBody: failure.rawBody,
      }),
    ).toMatchObject({ status: "accepted" });

    const open = sqlite
      .prepare(
        `SELECT status, incident_type FROM incidents WHERE workflow_id = ?`,
      )
      .get(workflowId) as { status: string; incident_type: string };
    expect(open).toEqual({ status: "open", incident_type: "hard_failure" });

    const success = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "ok-1",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:01:00Z",
        status: "success",
        itemsProcessed: 2,
      },
    });
    expect(
      ingest({
        workflowId,
        method: "POST",
        path: success.path,
        keyId,
        timestampSeconds: success.timestampSeconds,
        idempotencyKey: "ok-1",
        signatureHex: success.signature,
        rawBody: success.rawBody,
      }),
    ).toMatchObject({ status: "accepted" });

    const resolved = sqlite
      .prepare(
        `SELECT status FROM incidents WHERE workflow_id = ? AND incident_type = 'hard_failure'`,
      )
      .get(workflowId) as { status: string };
    expect(resolved.status).toBe("resolved");

    const outbox = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM notification_outbox WHERE event_type IN ('opened', 'resolved')`,
      )
      .get() as { c: number };
    expect(outbox.c).toBeGreaterThanOrEqual(2);
  });

  it("rejects revoked credentials", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest, tenant } = seedWorkflow(sqlite);
    sqlite
      .prepare(
        `UPDATE workflow_credentials SET status = 'revoked', revoked_at = ?
         WHERE tenant_id = ? AND workflow_id = ? AND key_id = ?`,
      )
      .run(new Date().toISOString(), tenant.id, workflowId, keyId);

    const signed = signedRequest({
      workflowId,
      keyId,
      idempotencyKey: "revoked",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 1,
      },
    });
    expect(
      ingest({
        workflowId,
        method: "POST",
        path: signed.path,
        keyId,
        timestampSeconds: signed.timestampSeconds,
        idempotencyKey: "revoked",
        signatureHex: signed.signature,
        rawBody: signed.rawBody,
      }),
    ).toEqual({ status: "unauthorized" });
  });
});
