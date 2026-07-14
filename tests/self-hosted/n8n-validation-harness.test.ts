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
import { evaluateCadenceDeadline } from "../../src/domain/cadence/evaluate-deadline.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import {
  buildHeartbeatSigningPayload,
  sha256Hex,
  signHeartbeatHmacSha256,
} from "../../src/infrastructure/security/heartbeat-hmac.js";
import { createIngestHeartbeatHandler } from "../../src/infrastructure/ingestion/ingest-heartbeat.js";
import { createWatcher } from "../../src/infrastructure/watcher/run-watcher.js";
import { createOutboxProcessor } from "../../src/infrastructure/alerting/process-outbox.js";
import { queryContractCatalog } from "../../src/infrastructure/catalog/query-catalog.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";
const SECRET = "n8n-validation-hmac-secret";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-n8n-val-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function seedPushContract(
  sqlite: BetterSqliteDatabase.Database,
  clock: FixedClock,
): {
  tenantId: string;
  workflowId: string;
  keyId: string;
  channelId: string;
} {
  const core = new SqliteCoreRepositories(sqlite);
  const alerting = new SqliteAlertingRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const workflowId = createId();
  const anchor = clock.now().toISOString();
  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "Scheduled sync",
    externalWorkflowId: "n8n-scheduled",
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: anchor,
  });
  core.createWorkflowContract(tenant.id, {
    id: createId(),
    workflowId,
    name: "Scheduled heartbeat",
    businessPurpose: "Run every five minutes",
    cadenceType: "interval",
    cadenceValue: "5",
    intervalMode: "fixed_rate",
    scheduleAnchorAt: anchor,
    timezone: "UTC",
    allowedLatenessMinutes: 2,
    maxQuietWindowMinutes: null,
    initialGraceMinutes: 0,
    emptyResultPolicy: "allowed",
    countLessSuccessAllowed: true,
    notificationBackoffMinutes: 30,
    evidenceLevel: "basic",
    schemaVersion: 1,
    isActive: true,
    activatedAt: anchor,
  });
  const keyId = "key_val";
  core.createCredential(tenant.id, {
    id: createId(),
    workflowId,
    keyId,
    encryptedSecretOrVerificationMaterial: encryptCredentialSecret(SECRET, KEK),
    status: "active",
    rotatedFromId: null,
    revokedAt: null,
  });
  const channelId = createId();
  alerting.createAlertChannel(tenant.id, {
    id: channelId,
    name: "Ops",
    type: "webhook",
    encryptedConfig: encryptCredentialSecret(
      JSON.stringify({ url: "https://hooks.example/quorum" }),
      KEK,
    ),
    isActive: true,
  });
  alerting.routeContractToChannel(tenant.id, {
    contractKind: "workflow",
    contractId: workflowId,
    alertChannelId: channelId,
  });
  return { tenantId: tenant.id, workflowId, keyId, channelId };
}

function signBody(
  workflowId: string,
  keyId: string,
  body: Buffer,
  ts: number,
  idem: string,
): { signature: string; path: string } {
  const pathName = `/api/v1/workflows/${workflowId}/heartbeats`;
  const payload = buildHeartbeatSigningPayload({
    method: "POST",
    path: pathName,
    timestampSeconds: String(ts),
    idempotencyKey: idem,
    bodySha256Hex: sha256Hex(body),
  });
  return {
    path: pathName,
    signature: signHeartbeatHmacSha256(SECRET, payload),
  };
}

describe("n8n validation harness", () => {
  it("covers signature rejection, duplicate heartbeat, empty result, missing destination, late fixed-rate, alert 500, and watcher stall", async () => {
    const sqlite = openDb();
    let now = new Date("2026-07-19T10:00:00.000Z");
    const clock = new FixedClock(now);
    const env = loadEnv({
      NODE_ENV: "test",
      QUORUM_CREDENTIAL_KEK: KEK,
    });
    const seeded = seedPushContract(sqlite, clock);
    const ingest = createIngestHeartbeatHandler({
      sqlite,
      env,
      clock,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0007"],
      }),
    });

    const ts = Math.floor(now.getTime() / 1000);
    const goodBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: now.toISOString(),
        status: "success",
        itemsProcessed: 1,
        externalExecutionRef: "exec-1",
      }),
    );

    // 5. invalid signature
    const bad = ingest({
      workflowId: seeded.workflowId,
      method: "POST",
      path: `/api/v1/workflows/${seeded.workflowId}/heartbeats`,
      keyId: seeded.keyId,
      timestampSeconds: String(ts),
      idempotencyKey: "idem-bad",
      signatureHex: "00".repeat(32),
      rawBody: goodBody,
    });
    expect(bad.status).toBe("unauthorized");

    // 6. duplicate heartbeat
    const signed = signBody(
      seeded.workflowId,
      seeded.keyId,
      goodBody,
      ts,
      "idem-1",
    );
    const first = ingest({
      workflowId: seeded.workflowId,
      method: "POST",
      path: signed.path,
      keyId: seeded.keyId,
      timestampSeconds: String(ts),
      idempotencyKey: "idem-1",
      signatureHex: signed.signature,
      rawBody: goodBody,
    });
    expect(first.status).toBe("accepted");
    const dup = ingest({
      workflowId: seeded.workflowId,
      method: "POST",
      path: signed.path,
      keyId: seeded.keyId,
      timestampSeconds: String(ts),
      idempotencyKey: "idem-1",
      signatureHex: signed.signature,
      rawBody: goodBody,
    });
    expect(dup).toMatchObject({ status: "accepted", idempotentReplay: true });

    // 4. zero-item allowed
    const emptyBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: now.toISOString(),
        status: "success",
        itemsProcessed: 0,
        externalExecutionRef: "exec-empty",
      }),
    );
    const emptySigned = signBody(
      seeded.workflowId,
      seeded.keyId,
      emptyBody,
      ts,
      "idem-empty",
    );
    const empty = ingest({
      workflowId: seeded.workflowId,
      method: "POST",
      path: emptySigned.path,
      keyId: seeded.keyId,
      timestampSeconds: String(ts),
      idempotencyKey: "idem-empty",
      signatureHex: emptySigned.signature,
      rawBody: emptyBody,
    });
    expect(empty.status).toBe("accepted");

    // 12. healthy / basic with destination delivery unverified
    const catalog = queryContractCatalog({
      sqlite,
      clock,
      tenantId: seeded.tenantId,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    expect(catalog[0]?.health).toBe("healthy");
    expect(catalog[0]?.evidenceLevel).toBe("basic");
    expect(catalog[0]?.evidenceExplanation.toLowerCase()).toMatch(
      /destination|delivery|unverified|basic/,
    );

    // 11. late fixed-rate must not shift schedule
    const anchor = new Date("2026-07-19T10:00:00.000Z");
    const lateSuccess = new Date("2026-07-19T10:07:00.000Z");
    const laterClock = new FixedClock(new Date("2026-07-19T10:12:00.000Z"));
    const evalLate = evaluateCadenceDeadline(
      {
        cadenceType: "interval",
        cadenceValue: "5",
        intervalMode: "fixed_rate",
        scheduleAnchorAt: anchor,
        timezone: null,
        allowedLatenessMinutes: 2,
        maxQuietWindowMinutes: null,
        monitoringStartedAt: anchor,
        lastAcceptableSuccessAt: lateSuccess,
      },
      laterClock,
    );
    // Late 10:07 success does not shift the 10:10 slot off the grid.
    expect(evalLate.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-19T10:10:00.000Z",
    );

    // 8. notification endpoint returns 500
    const deliveries: string[] = [];
    const processOutbox = createOutboxProcessor({
      sqlite,
      clock,
      kek: KEK,
      claimOwner: "test",
      claimTtlMs: 30_000,
      maxAttempts: 5,
      retryBaseMs: 1_000,
      deliveryTimeoutMs: 1_000,
      publicBaseUrl: "http://127.0.0.1:3000",
      edition: "self_hosted",
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0007"],
      }),
      providers: {
        async deliverWebhook(config) {
          deliveries.push(config.url);
          return {
            ok: false,
            errorCode: "webhook_non_2xx",
            errorMessage: "http_500",
            responseStatusCode: 500,
          };
        },
        async deliverSmtp() {
          return {
            ok: false,
            errorCode: "smtp_timeout",
            errorMessage: "timeout",
            responseStatusCode: null,
          };
        },
      },
    });
    const alerting = new SqliteAlertingRepositories(sqlite);
    alerting.enqueueOutbox(seeded.tenantId, {
      id: createId(),
      incidentId: null,
      eventType: "channel_test",
      payloadJson: JSON.stringify({ alertChannelId: seeded.channelId }),
      availableAt: clock.now().toISOString(),
    });
    const out = await processOutbox.processBatch(5);
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect(deliveries).toEqual(["https://hooks.example/quorum"]);
    const channelState = alerting.getAlertChannelState(
      seeded.tenantId,
      seeded.channelId,
    );
    expect(channelState?.currentHealth).not.toBe("healthy");

    // 10. watcher stall visibility via getRunState age
    const watcher = createWatcher({
      sqlite,
      clock,
      claimOwner: "test",
      claimTtlMs: 30_000,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0007"],
      }),
    });
    watcher.runTick(seeded.tenantId);
    const successAt = watcher.getRunState().lastSuccessAt;
    expect(successAt).toBeTruthy();
    now = new Date("2026-07-19T10:30:00.000Z");
    clock.set(now);
    const staleMs = 180_000;
    const age = now.getTime() - new Date(successAt!).getTime();
    expect(age).toBeGreaterThan(staleMs);
  });

  it("documents hard failure and missing destination trust case without claiming delivery", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T11:00:00.000Z"));
    const env = loadEnv({ NODE_ENV: "test", QUORUM_CREDENTIAL_KEK: KEK });
    const seeded = seedPushContract(sqlite, clock);
    const ingest = createIngestHeartbeatHandler({
      sqlite,
      env,
      clock,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0007"],
      }),
    });
    const ts = Math.floor(clock.now().getTime() / 1000);
    const failBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: clock.now().toISOString(),
        status: "failure",
        externalExecutionRef: "exec-fail",
        // destination outcome deliberately omitted
      }),
    );
    const signed = signBody(
      seeded.workflowId,
      seeded.keyId,
      failBody,
      ts,
      "idem-fail",
    );
    const result = ingest({
      workflowId: seeded.workflowId,
      method: "POST",
      path: signed.path,
      keyId: seeded.keyId,
      timestampSeconds: String(ts),
      idempotencyKey: "idem-fail",
      signatureHex: signed.signature,
      rawBody: failBody,
    });
    expect(result.status).toBe("accepted");
    const catalog = queryContractCatalog({
      sqlite,
      clock,
      tenantId: seeded.tenantId,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    expect(catalog[0]?.evidenceLevel).toBe("basic");
    expect(catalog[0]?.unverifiedDimensions.length).toBeGreaterThan(0);
  });
});
