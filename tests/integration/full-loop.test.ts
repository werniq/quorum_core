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
import { buildApp } from "../../src/infrastructure/http/app.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";
const SECRET = "full-loop-hmac-secret-value";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-loop-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

describe("full-loop heartbeat assurance", () => {
  it("runs contract registration through overdue, delivery failure, recovery, and catalog authority", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);

    // 1. tenant + client
    const tenant = core.ensureSelfHostedTenant();
    const clientId = createId();
    core.createClient(tenant.id, {
      id: clientId,
      name: "Acme",
      slug: "acme",
      status: "protected",
      protectionStartedAt: "2026-07-18T08:00:00.000Z",
    });

    // 2. fixed-rate 5-minute contract
    const workflowId = createId();
    const anchor = "2026-07-18T08:00:00.000Z";
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId,
      name: "Invoice sync",
      externalWorkflowId: "n8n-inv",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: anchor,
    });
    core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId,
      name: "Invoice heartbeat",
      businessPurpose: "Sync invoices every five minutes",
      cadenceType: "interval",
      cadenceValue: "5",
      intervalMode: "fixed_rate",
      scheduleAnchorAt: anchor,
      timezone: null,
      allowedLatenessMinutes: 1,
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

    // 3. credential + alert channel
    const keyId = "hk_main";
    core.createCredential(tenant.id, {
      id: createId(),
      workflowId,
      keyId,
      encryptedSecretOrVerificationMaterial: encryptCredentialSecret(
        SECRET,
        KEK,
      ),
      status: "active",
      rotatedFromId: null,
      revokedAt: null,
    });
    const channelId = createId();
    alerting.createAlertChannel(tenant.id, {
      id: channelId,
      name: "Ops webhook",
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

    const env = loadEnv({
      NODE_ENV: "test",
      QUORUM_CREDENTIAL_KEK: KEK,
      PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    });

    // 4. signed non-empty success at 08:00
    let clock = new FixedClock(new Date("2026-07-18T08:00:30.000Z"));
    const ingest = createIngestHeartbeatHandler({
      sqlite,
      env,
      clock,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:20.000Z",
        status: "success",
        itemsProcessed: 4,
      }),
      "utf8",
    );
    const ts = String(Math.floor(clock.now().getTime() / 1000));
    const pathName = `/api/v1/workflows/${workflowId}/heartbeats`;
    const signature = signHeartbeatHmacSha256(
      SECRET,
      buildHeartbeatSigningPayload({
        method: "POST",
        path: pathName,
        timestampSeconds: ts,
        idempotencyKey: "exec-ok-1",
        bodySha256Hex: sha256Hex(body),
      }),
    );
    expect(
      ingest({
        workflowId,
        method: "POST",
        path: pathName,
        keyId,
        timestampSeconds: ts,
        idempotencyKey: "exec-ok-1",
        signatureHex: signature,
        rawBody: body,
      }).status,
    ).toBe("accepted");

    // 5. catalog healthy + basic + destination unverified
    let catalog = queryContractCatalog({
      sqlite,
      clock,
      tenantId: tenant.id,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });
    expect(catalog[0]).toMatchObject({
      health: "healthy",
      evidenceLevel: "basic",
    });
    expect(catalog[0]?.unverifiedDimensions).toContain(
      "destination_delivery_not_checked",
    );

    // 6-7. advance past next slot (08:05) + lateness (08:06) and run watcher
    clock = new FixedClock(new Date("2026-07-18T08:06:01.000Z"));
    const watcher = createWatcher({
      sqlite,
      clock,
      claimOwner: "full-loop",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    const tick = watcher.runTick(tenant.id);
    expect(tick.openedSilentAbsence).toBe(1);

    // 8. one silent-absence + one opened outbox
    const incident = alerting.getUnresolvedIncident(
      tenant.id,
      "workflow",
      workflowId,
      "silent_absence",
    );
    expect(incident).not.toBeNull();
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM notification_outbox
             WHERE incident_id = ? AND event_type = 'opened'`,
          )
          .get(incident!.id) as { c: number }
      ).c,
    ).toBe(1);

    // 9-10. webhook 500 through retry exhaustion; incident remains; channel failing
    let webhookMode: "fail" | "ok" = "fail";
    const processor = createOutboxProcessor({
      sqlite,
      clock,
      kek: KEK,
      claimOwner: "full-loop-outbox",
      claimTtlMs: 30_000,
      maxAttempts: 2,
      retryBaseMs: 1,
      deliveryTimeoutMs: 100,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      edition: "self_hosted",
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      providers: {
        deliverWebhook: async () => {
          if (webhookMode === "fail") {
            return {
              ok: false,
              errorCode: "webhook_non_2xx",
              errorMessage: "http_500",
              responseStatusCode: 500,
            };
          }
          return {
            ok: true,
            externalMessageId: "m1",
            externalThreadId: "t1",
            responseStatusCode: 200,
          };
        },
        deliverSmtp: async () => ({
          ok: false,
          errorCode: "unused",
          errorMessage: "unused",
          responseStatusCode: null,
        }),
      },
    });
    await processor.processBatch();
    clock = new FixedClock(new Date("2026-07-18T08:06:05.000Z"));
    await createOutboxProcessor({
      sqlite,
      clock,
      kek: KEK,
      claimOwner: "full-loop-outbox",
      claimTtlMs: 30_000,
      maxAttempts: 2,
      retryBaseMs: 1,
      deliveryTimeoutMs: 100,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      edition: "self_hosted",
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      providers: {
        deliverWebhook: async () => ({
          ok: false,
          errorCode: "webhook_non_2xx",
          errorMessage: "http_500",
          responseStatusCode: 500,
        }),
        deliverSmtp: async () => ({
          ok: false,
          errorCode: "unused",
          errorMessage: "unused",
          responseStatusCode: null,
        }),
      },
    }).processBatch();

    expect(alerting.getIncident(tenant.id, incident!.id)?.status).toBe("open");
    expect(
      alerting.getAlertChannelState(tenant.id, channelId)?.currentHealth,
    ).toBe("failing");

    // 11. catalog exposes both contract incident and delivery failure
    catalog = queryContractCatalog({
      sqlite,
      clock,
      tenantId: tenant.id,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });
    expect(catalog[0]?.activeIncident?.type).toBe("silent_absence");
    expect(catalog[0]?.alertChannelHealth).toBe("failing");
    expect(catalog[0]?.health).toBe("overdue");

    // 12. restore webhook + channel test → healthy channel
    webhookMode = "ok";
    const app = await buildApp({
      env,
      clock,
      sqlite,
      processOutbox: createOutboxProcessor({
        sqlite,
        clock,
        kek: KEK,
        claimOwner: "full-loop-outbox",
        claimTtlMs: 30_000,
        maxAttempts: 2,
        retryBaseMs: 1,
        deliveryTimeoutMs: 100,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        edition: "self_hosted",
        getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
        providers: {
          deliverWebhook: async () => ({
            ok: true,
            externalMessageId: "test-1",
            externalThreadId: "t1",
            responseStatusCode: 200,
          }),
          deliverSmtp: async () => ({
            ok: false,
            errorCode: "unused",
            errorMessage: "unused",
            responseStatusCode: null,
          }),
        },
      }),
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      getWatcherHealth: () => ({
        lastSuccessAt: clock.now().toISOString(),
        staleAfterMs: 180_000,
        nowMs: clock.now().getTime(),
      }),
    });
    const testResponse = await app.inject({
      method: "POST",
      url: `/api/v1/alert-channels/${channelId}/test`,
      headers: { "x-quorum-tenant-id": tenant.id },
    });
    expect(testResponse.statusCode).toBe(200);
    expect(
      alerting.getAlertChannelState(tenant.id, channelId)?.currentHealth,
    ).toBe("healthy");

    // 13. beyond backoff and past deadline → same incident re-notifies
    alerting.markIncidentNotified(
      tenant.id,
      incident!.id,
      "2026-07-18T08:06:01.000Z",
    );
    clock = new FixedClock(new Date("2026-07-18T08:41:30.000Z"));
    const renotify = createWatcher({
      sqlite,
      clock,
      claimOwner: "full-loop",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    }).runTick(tenant.id);
    expect(renotify.renotifications).toBe(1);
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM notification_outbox
             WHERE incident_id = ? AND event_type = 'renotification'`,
          )
          .get(incident!.id) as { c: number }
      ).c,
    ).toBe(1);

    // 14. acceptable success resolves same incident
    const recoverBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: "2026-07-18T08:41:30.000Z",
        status: "success",
        itemsProcessed: 2,
      }),
      "utf8",
    );
    const recoverTs = String(Math.floor(clock.now().getTime() / 1000));
    const recoverSig = signHeartbeatHmacSha256(
      SECRET,
      buildHeartbeatSigningPayload({
        method: "POST",
        path: pathName,
        timestampSeconds: recoverTs,
        idempotencyKey: "exec-ok-2",
        bodySha256Hex: sha256Hex(recoverBody),
      }),
    );
    const recoverIngest = createIngestHeartbeatHandler({
      sqlite,
      env,
      clock,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    expect(
      recoverIngest({
        workflowId,
        method: "POST",
        path: pathName,
        keyId,
        timestampSeconds: recoverTs,
        idempotencyKey: "exec-ok-2",
        signatureHex: recoverSig,
        rawBody: recoverBody,
      }).status,
    ).toBe("accepted");
    expect(alerting.getIncident(tenant.id, incident!.id)?.status).toBe(
      "resolved",
    );

    // Watcher should show healthy for current slot after success at 08:40
    // Slot N for 5-min from 08:00: at 08:40 → expected 08:40, covered by success
    createWatcher({
      sqlite,
      clock,
      claimOwner: "full-loop",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    }).runTick(tenant.id);

    // 15. catalog healthy/basic again
    catalog = queryContractCatalog({
      sqlite,
      clock,
      tenantId: tenant.id,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });
    expect(catalog[0]?.health).toBe("healthy");
    expect(catalog[0]?.evidenceLevel).toBe("basic");
    expect(catalog[0]?.activeIncident).toBeNull();
    expect(catalog[0]?.alertChannelHealth).toBe("healthy");

    await app.close();
  });
});
