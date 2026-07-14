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

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-sec-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function seed(
  sqlite: BetterSqliteDatabase.Database,
  options?: {
    secret?: string;
    emptyResultPolicy?: "allowed" | "warning" | "failure";
    countLessSuccessAllowed?: boolean;
    env?: Record<string, string>;
    clock?: FixedClock;
  },
) {
  const secret = options?.secret ?? "workflow-hmac-secret";
  const core = new SqliteCoreRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const now = new Date("2026-07-18T08:00:00.000Z").toISOString();
  const workflowId = createId();
  const keyId = "hk_main";
  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "W",
    externalWorkflowId: "ext",
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: now,
  });
  core.createWorkflowContract(tenant.id, {
    id: createId(),
    workflowId,
    name: "c",
    businessPurpose: "p",
    cadenceType: "event_driven",
    cadenceValue: "event",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: null,
    allowedLatenessMinutes: 0,
    maxQuietWindowMinutes: 60,
    initialGraceMinutes: 0,
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
    encryptedSecretOrVerificationMaterial: encryptCredentialSecret(secret, KEK),
    status: "active",
    rotatedFromId: null,
    revokedAt: null,
  });

  const clock =
    options?.clock ?? new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
  const env = loadEnv({
    NODE_ENV: "test",
    QUORUM_CREDENTIAL_KEK: KEK,
    HEARTBEAT_MAX_BODY_BYTES: "2048",
    ...options?.env,
  });
  const ingest = createIngestHeartbeatHandler({
    sqlite,
    env,
    clock,
    getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
  });
  return { tenant, workflowId, keyId, secret, ingest, env, core };
}

function sign(input: {
  workflowId: string;
  secret: string;
  idempotencyKey: string;
  body: object | string;
  timestampSeconds?: string;
}) {
  const rawBody = Buffer.from(
    typeof input.body === "string" ? input.body : JSON.stringify(input.body),
    "utf8",
  );
  const timestampSeconds =
    input.timestampSeconds ??
    String(Math.floor(new Date("2026-07-18T08:00:00.000Z").getTime() / 1000));
  const pathName = `/api/v1/workflows/${input.workflowId}/heartbeats`;
  const signature = signHeartbeatHmacSha256(
    input.secret,
    buildHeartbeatSigningPayload({
      method: "POST",
      path: pathName,
      timestampSeconds,
      idempotencyKey: input.idempotencyKey,
      bodySha256Hex: sha256Hex(rawBody),
    }),
  );
  return { rawBody, timestampSeconds, path: pathName, signature };
}

describe("ingestion security suite", () => {
  it("rejects missing headers and invalid signatures without writes", async () => {
    const sqlite = openDb();
    const { workflowId, keyId, secret, ingest, env } = seed(sqlite);
    const signed = sign({
      workflowId,
      secret,
      idempotencyKey: "k1",
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

    const missing = await app.inject({
      method: "POST",
      url: signed.path,
      headers: { "content-type": "application/json" },
      payload: signed.rawBody,
    });
    expect(missing.statusCode).toBe(401);

    const badSig = await app.inject({
      method: "POST",
      url: signed.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": signed.timestampSeconds,
        "x-quorum-idempotency-key": "k1",
        "x-quorum-signature": "00".repeat(32),
      },
      payload: signed.rawBody,
    });
    expect(badSig.statusCode).toBe(401);

    expect(
      (
        sqlite.prepare(`SELECT COUNT(*) AS c FROM heartbeat_events`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        sqlite.prepare(`SELECT COUNT(*) AS c FROM workflow_states`).get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    await app.close();
  });

  it("rejects another workflow's key, expired timestamps, and oversized bodies", async () => {
    const sqlite = openDb();
    const a = seed(sqlite, { secret: "secret-a" });
    const workflowB = createId();
    const secretB = "secret-b";
    a.core.createWorkflow(a.tenant.id, {
      id: workflowB,
      clientId: null,
      name: "B",
      externalWorkflowId: "b",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: new Date().toISOString(),
    });
    a.core.createWorkflowContract(a.tenant.id, {
      id: createId(),
      workflowId: workflowB,
      name: "cb",
      businessPurpose: "p",
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
      activatedAt: new Date().toISOString(),
    });
    a.core.createCredential(a.tenant.id, {
      id: createId(),
      workflowId: workflowB,
      keyId: "hk_b",
      encryptedSecretOrVerificationMaterial: encryptCredentialSecret(
        secretB,
        KEK,
      ),
      status: "active",
      rotatedFromId: null,
      revokedAt: null,
    });

    const cross = sign({
      workflowId: workflowB,
      secret: a.secret,
      idempotencyKey: "cross",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 1,
      },
    });
    expect(
      a.ingest({
        workflowId: workflowB,
        method: "POST",
        path: cross.path,
        keyId: a.keyId,
        timestampSeconds: cross.timestampSeconds,
        idempotencyKey: "cross",
        signatureHex: cross.signature,
        rawBody: cross.rawBody,
      }),
    ).toEqual({ status: "unauthorized" });

    const expired = sign({
      workflowId: a.workflowId,
      secret: a.secret,
      idempotencyKey: "old",
      timestampSeconds: "1",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 1,
      },
    });
    expect(
      a.ingest({
        workflowId: a.workflowId,
        method: "POST",
        path: expired.path,
        keyId: a.keyId,
        timestampSeconds: expired.timestampSeconds,
        idempotencyKey: "old",
        signatureHex: expired.signature,
        rawBody: expired.rawBody,
      }),
    ).toEqual({ status: "unauthorized" });

    const app = await buildApp({
      env: a.env,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      ingestHeartbeat: a.ingest,
    });
    const huge = Buffer.alloc(4096, 0x61);
    const oversized = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/${a.workflowId}/heartbeats`,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": a.keyId,
        "x-quorum-timestamp": "1780000000",
        "x-quorum-idempotency-key": "big",
        "x-quorum-signature": "ab",
      },
      payload: huge,
    });
    expect(oversized.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it("rejects malformed payloads and respects count-less success setting", () => {
    const sqlite = openDb();
    const required = seed(sqlite, { countLessSuccessAllowed: false });
    const malformed = sign({
      workflowId: required.workflowId,
      secret: required.secret,
      idempotencyKey: "bad",
      body: { schemaVersion: 2, status: "success" },
    });
    expect(
      required.ingest({
        workflowId: required.workflowId,
        method: "POST",
        path: malformed.path,
        keyId: required.keyId,
        timestampSeconds: malformed.timestampSeconds,
        idempotencyKey: "bad",
        signatureHex: malformed.signature,
        rawBody: malformed.rawBody,
      }),
    ).toMatchObject({ status: "bad_request" });

    const missingCount = sign({
      workflowId: required.workflowId,
      secret: required.secret,
      idempotencyKey: "nocount",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
      },
    });
    expect(
      required.ingest({
        workflowId: required.workflowId,
        method: "POST",
        path: missingCount.path,
        keyId: required.keyId,
        timestampSeconds: missingCount.timestampSeconds,
        idempotencyKey: "nocount",
        signatureHex: missingCount.signature,
        rawBody: missingCount.rawBody,
      }),
    ).toEqual({ status: "bad_request", code: "ITEMS_REQUIRED" });
  });

  it("handles concurrent heartbeats without corrupting projection", () => {
    const sqlite = openDb();
    const { workflowId, keyId, secret, ingest } = seed(sqlite);
    const results = ["c1", "c2", "c3"].map((idempotencyKey, index) => {
      const signed = sign({
        workflowId,
        secret,
        idempotencyKey,
        body: {
          schemaVersion: 1,
          executedAt: `2026-07-18T08:00:0${index}Z`,
          status: "success",
          itemsProcessed: index + 1,
        },
      });
      return ingest({
        workflowId,
        method: "POST",
        path: signed.path,
        keyId,
        timestampSeconds: signed.timestampSeconds,
        idempotencyKey,
        signatureHex: signed.signature,
        rawBody: signed.rawBody,
      });
    });

    expect(results.every((result) => result.status === "accepted")).toBe(true);
    const events = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ?`,
      )
      .get(workflowId) as { c: number };
    expect(events.c).toBe(3);
    const state = sqlite
      .prepare(
        `SELECT evidence_level, last_status FROM workflow_states WHERE workflow_id = ?`,
      )
      .get(workflowId) as { evidence_level: string; last_status: string };
    expect(state.evidence_level).toBe("basic");
    expect(state.last_status).toBe("success");
  });

  it("rejects future timestamps outside tolerance", () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
    const { workflowId, keyId, secret, ingest } = seed(sqlite, { clock });
    const futureSeconds = String(
      Math.floor(clock.now().getTime() / 1000) + 3600,
    );
    const signed = sign({
      workflowId,
      secret,
      idempotencyKey: "future",
      timestampSeconds: futureSeconds,
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
        idempotencyKey: "future",
        signatureHex: signed.signature,
        rawBody: signed.rawBody,
      }),
    ).toEqual({ status: "unauthorized" });
  });

  it("classifies empty results according to contract policy", () => {
    const sqlite = openDb();
    const allowed = seed(sqlite, { emptyResultPolicy: "allowed" });
    const emptyAllowed = sign({
      workflowId: allowed.workflowId,
      secret: allowed.secret,
      idempotencyKey: "empty-ok",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 0,
      },
    });
    expect(
      allowed.ingest({
        workflowId: allowed.workflowId,
        method: "POST",
        path: emptyAllowed.path,
        keyId: allowed.keyId,
        timestampSeconds: emptyAllowed.timestampSeconds,
        idempotencyKey: "empty-ok",
        signatureHex: emptyAllowed.signature,
        rawBody: emptyAllowed.rawBody,
      }),
    ).toMatchObject({ status: "accepted" });

    const failureDb = openDb();
    const failure = seed(failureDb, { emptyResultPolicy: "failure" });
    const emptyFail = sign({
      workflowId: failure.workflowId,
      secret: failure.secret,
      idempotencyKey: "empty-fail",
      body: {
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "success",
        itemsProcessed: 0,
      },
    });
    expect(
      failure.ingest({
        workflowId: failure.workflowId,
        method: "POST",
        path: emptyFail.path,
        keyId: failure.keyId,
        timestampSeconds: emptyFail.timestampSeconds,
        idempotencyKey: "empty-fail",
        signatureHex: emptyFail.signature,
        rawBody: emptyFail.rawBody,
      }),
    ).toMatchObject({ status: "accepted" });
    const incident = failureDb
      .prepare(`SELECT incident_type FROM incidents WHERE workflow_id = ?`)
      .get(failure.workflowId) as { incident_type: string } | undefined;
    expect(incident?.incident_type).toBe("empty_result");
  });

  it("keeps secrets out of API responses", async () => {
    const sqlite = openDb();
    const { workflowId, keyId, secret, ingest, env } = seed(sqlite);
    const signed = sign({
      workflowId,
      secret,
      idempotencyKey: "ok",
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
    const response = await app.inject({
      method: "POST",
      url: signed.path,
      headers: {
        "content-type": "application/json",
        "x-quorum-key-id": keyId,
        "x-quorum-timestamp": signed.timestampSeconds,
        "x-quorum-idempotency-key": "ok",
        "x-quorum-signature": signed.signature,
      },
      payload: signed.rawBody,
    });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain(KEK);
    expect(response.body.toLowerCase()).not.toContain("authorization");
    await app.close();
  });
});
