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
  isTimestampWithinTolerance,
  sha256Hex,
  signHeartbeatHmacSha256,
  verifyHeartbeatSignature,
} from "../../src/infrastructure/security/heartbeat-hmac.js";
import { createIngestHeartbeatHandler } from "../../src/infrastructure/ingestion/ingest-heartbeat.js";
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
    `quorum-hmac-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function seed(
  sqlite: BetterSqliteDatabase.Database,
  options?: { status?: "active" | "revoked" },
) {
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
    emptyResultPolicy: "allowed",
    countLessSuccessAllowed: true,
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
    status: options?.status ?? "active",
    rotatedFromId: null,
    revokedAt: options?.status === "revoked" ? now : null,
  });
  const clock = new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
  const env = loadEnv({
    NODE_ENV: "test",
    QUORUM_CREDENTIAL_KEK: KEK,
  });
  const ingest = createIngestHeartbeatHandler({
    sqlite,
    env,
    clock,
    getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
  });
  return { workflowId, keyId, ingest, clock };
}

function signedCommand(input: {
  workflowId: string;
  keyId: string;
  secret?: string;
  signatureOverride?: string;
  timestampSeconds?: string;
  body?: object;
}) {
  const rawBody = Buffer.from(
    JSON.stringify(
      input.body ?? {
        status: "success",
        executedAt: "2026-07-18T08:00:00.000Z",
        itemsProcessed: 1,
      },
    ),
    "utf8",
  );
  const timestampSeconds =
    input.timestampSeconds ??
    String(Math.floor(new Date("2026-07-18T08:00:00.000Z").getTime() / 1000));
  const pathName = `/api/v1/workflows/${input.workflowId}/heartbeats`;
  const idempotencyKey = createId();
  const secret = input.secret ?? SECRET;
  const expected = signHeartbeatHmacSha256(
    secret,
    [
      "POST",
      pathName,
      timestampSeconds,
      idempotencyKey,
      sha256Hex(rawBody),
    ].join("\n"),
  );
  return {
    workflowId: input.workflowId,
    method: "POST",
    path: pathName,
    keyId: input.keyId,
    timestampSeconds,
    idempotencyKey,
    signatureHex: input.signatureOverride ?? expected,
    rawBody,
  };
}

describe("heartbeat HMAC guards", () => {
  it("verifyHeartbeatSignature rejects wrong signature", () => {
    const rawBody = Buffer.from('{"status":"success"}', "utf8");
    const ok = verifyHeartbeatSignature({
      secret: SECRET,
      method: "POST",
      path: "/api/v1/workflows/w/heartbeats",
      timestampSeconds: "1720000000",
      idempotencyKey: "idem-1",
      rawBody,
      providedSignatureHex: "00".repeat(32),
    });
    expect(ok).toBe(false);

    const goodSig = signHeartbeatHmacSha256(
      SECRET,
      [
        "POST",
        "/api/v1/workflows/w/heartbeats",
        "1720000000",
        "idem-1",
        sha256Hex(rawBody),
      ].join("\n"),
    );
    expect(
      verifyHeartbeatSignature({
        secret: SECRET,
        method: "POST",
        path: "/api/v1/workflows/w/heartbeats",
        timestampSeconds: "1720000000",
        idempotencyKey: "idem-1",
        rawBody,
        providedSignatureHex: goodSig,
      }),
    ).toBe(true);
  });

  it("isTimestampWithinTolerance rejects stale and future timestamps", () => {
    const nowSeconds = 1_720_000_000;
    expect(
      isTimestampWithinTolerance({
        timestampSeconds: nowSeconds,
        nowSeconds,
        toleranceSeconds: 300,
      }),
    ).toBe(true);
    expect(
      isTimestampWithinTolerance({
        timestampSeconds: nowSeconds - 301,
        nowSeconds,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
    expect(
      isTimestampWithinTolerance({
        timestampSeconds: nowSeconds + 301,
        nowSeconds,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it("ingestHeartbeat rejects bad signatures via real verifyHeartbeatSignature", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seed(sqlite);
    const result = ingest(
      signedCommand({
        workflowId,
        keyId,
        signatureOverride: "deadbeef".repeat(8),
      }),
    );
    expect(result.status).toBe("unauthorized");
  });

  it("ingestHeartbeat rejects revoked credentials", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seed(sqlite, { status: "revoked" });
    const result = ingest(signedCommand({ workflowId, keyId }));
    expect(result.status).toBe("unauthorized");
  });

  it("ingestHeartbeat rejects stale timestamps", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seed(sqlite);
    const stale = String(
      Math.floor(new Date("2026-07-18T08:00:00.000Z").getTime() / 1000) -
        10_000,
    );
    const result = ingest(
      signedCommand({ workflowId, keyId, timestampSeconds: stale }),
    );
    expect(result.status).toBe("unauthorized");
  });
});
