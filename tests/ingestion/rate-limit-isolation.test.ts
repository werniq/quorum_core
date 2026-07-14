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
import { EmergencyRateLimitTracker } from "../../src/domain/ingestion/rate-limit.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-rl-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function seedTenantWorkflow(
  sqlite: BetterSqliteDatabase.Database,
  options: {
    tenantId?: string;
    secret: string;
    keyId: string;
    rateEnv: Record<string, string>;
    clock: FixedClock;
  },
) {
  const core = new SqliteCoreRepositories(sqlite);
  const tenantId = options.tenantId ?? core.ensureSelfHostedTenant().id;
  const workflowId = createId();
  const now = options.clock.now().toISOString();
  core.createWorkflow(tenantId, {
    id: workflowId,
    clientId: null,
    name: "W",
    externalWorkflowId: createId(),
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: now,
  });
  core.createWorkflowContract(tenantId, {
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
  core.createCredential(tenantId, {
    id: createId(),
    workflowId,
    keyId: options.keyId,
    encryptedSecretOrVerificationMaterial: encryptCredentialSecret(
      options.secret,
      KEK,
    ),
    status: "active",
    rotatedFromId: null,
    revokedAt: null,
  });

  const env = loadEnv({
    NODE_ENV: "test",
    QUORUM_CREDENTIAL_KEK: KEK,
    ...options.rateEnv,
  });
  const ingest = createIngestHeartbeatHandler({
    sqlite,
    env,
    clock: options.clock,
    getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
  });
  return { tenantId, workflowId, ingest };
}

function post(
  ingest: ReturnType<typeof createIngestHeartbeatHandler>,
  input: {
    workflowId: string;
    secret: string;
    keyId: string;
    idempotencyKey: string;
    clock: FixedClock;
  },
) {
  const rawBody = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      executedAt: input.clock.now().toISOString(),
      status: "success",
      itemsProcessed: 1,
    }),
    "utf8",
  );
  const timestampSeconds = String(
    Math.floor(input.clock.now().getTime() / 1000),
  );
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
  return ingest({
    workflowId: input.workflowId,
    method: "POST",
    path: pathName,
    keyId: input.keyId,
    timestampSeconds,
    idempotencyKey: input.idempotencyKey,
    signatureHex: signature,
    rawBody,
  });
}

describe("rate-limit isolation", () => {
  it("accepts within allowance, rejects over limit without evidence writes, and isolates workflows", () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
    const rateEnv = {
      HEARTBEAT_RATE_LIMIT_PER_MINUTE: "1",
      HEARTBEAT_RATE_LIMIT_BURST: "0",
      HEARTBEAT_SUSTAINED_REJECTION_THRESHOLD: "1",
    };
    const a = seedTenantWorkflow(sqlite, {
      secret: "sa",
      keyId: "ka",
      rateEnv,
      clock,
    });
    const b = seedTenantWorkflow(sqlite, {
      tenantId: a.tenantId,
      secret: "sb",
      keyId: "kb",
      rateEnv,
      clock,
    });

    expect(
      post(a.ingest, {
        workflowId: a.workflowId,
        secret: "sa",
        keyId: "ka",
        idempotencyKey: "a1",
        clock,
      }).status,
    ).toBe("accepted");
    expect(
      post(a.ingest, {
        workflowId: a.workflowId,
        secret: "sa",
        keyId: "ka",
        idempotencyKey: "a2",
        clock,
      }).status,
    ).toBe("rate_limited");

    const eventsA = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ?`,
      )
      .get(a.workflowId) as { c: number };
    expect(eventsA.c).toBe(1);

    expect(
      post(b.ingest, {
        workflowId: b.workflowId,
        secret: "sb",
        keyId: "kb",
        idempotencyKey: "b1",
        clock,
      }).status,
    ).toBe("accepted");

    const warning = sqlite
      .prepare(
        `SELECT evidence_summary_code FROM workflow_states WHERE workflow_id = ?`,
      )
      .get(a.workflowId) as { evidence_summary_code: string } | undefined;
    expect(warning?.evidence_summary_code).toBe(
      "sustained_ingestion_rejections",
    );
  });

  it("isolates workflow exhaustion and recovers after the window", () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
    const rateEnv = {
      HEARTBEAT_RATE_LIMIT_PER_MINUTE: "1",
      HEARTBEAT_RATE_LIMIT_BURST: "0",
    };
    const tenantA = seedTenantWorkflow(sqlite, {
      secret: "ta",
      keyId: "ka",
      rateEnv,
      clock,
    });
    const tenantB = seedTenantWorkflow(sqlite, {
      secret: "tb",
      keyId: "kb",
      rateEnv,
      clock,
    });

    expect(
      post(tenantA.ingest, {
        workflowId: tenantA.workflowId,
        secret: "ta",
        keyId: "ka",
        idempotencyKey: "1",
        clock,
      }).status,
    ).toBe("accepted");
    expect(
      post(tenantA.ingest, {
        workflowId: tenantA.workflowId,
        secret: "ta",
        keyId: "ka",
        idempotencyKey: "2",
        clock,
      }).status,
    ).toBe("rate_limited");
    expect(
      post(tenantB.ingest, {
        workflowId: tenantB.workflowId,
        secret: "tb",
        keyId: "kb",
        idempotencyKey: "1",
        clock,
      }).status,
    ).toBe("accepted");

    const later = new FixedClock(new Date("2026-07-18T08:01:01.000Z"));
    const recovered = createIngestHeartbeatHandler({
      sqlite,
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_CREDENTIAL_KEK: KEK,
        ...rateEnv,
      }),
      clock: later,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    expect(
      post(recovered, {
        workflowId: tenantA.workflowId,
        secret: "ta",
        keyId: "ka",
        idempotencyKey: "3",
        clock: later,
      }).status,
    ).toBe("accepted");
  });

  it("applies burst configuration and emergency tracker isolation", () => {
    const tracker = new EmergencyRateLimitTracker(60_000);
    expect(
      tracker.tryConsume({
        tenantId: "t1",
        tenantLimit: 1,
        globalLimit: null,
        nowMs: 1_000,
      }),
    ).toBe(true);
    expect(
      tracker.tryConsume({
        tenantId: "t1",
        tenantLimit: 1,
        globalLimit: null,
        nowMs: 1_100,
      }),
    ).toBe(false);
    expect(
      tracker.tryConsume({
        tenantId: "t2",
        tenantLimit: 1,
        globalLimit: null,
        nowMs: 1_100,
      }),
    ).toBe(true);

    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
    const seeded = seedTenantWorkflow(sqlite, {
      secret: "burst",
      keyId: "kb",
      rateEnv: {
        HEARTBEAT_RATE_LIMIT_PER_MINUTE: "1",
        HEARTBEAT_RATE_LIMIT_BURST: "1",
      },
      clock,
    });
    expect(
      post(seeded.ingest, {
        workflowId: seeded.workflowId,
        secret: "burst",
        keyId: "kb",
        idempotencyKey: "1",
        clock,
      }).status,
    ).toBe("accepted");
    expect(
      post(seeded.ingest, {
        workflowId: seeded.workflowId,
        secret: "burst",
        keyId: "kb",
        idempotencyKey: "2",
        clock,
      }).status,
    ).toBe("accepted");
    expect(
      post(seeded.ingest, {
        workflowId: seeded.workflowId,
        secret: "burst",
        keyId: "kb",
        idempotencyKey: "3",
        clock,
      }).status,
    ).toBe("rate_limited");
  });
});
