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
import { createWatcher } from "../../src/infrastructure/watcher/run-watcher.js";
import { createOutboxProcessor } from "../../src/infrastructure/alerting/process-outbox.js";
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import { queryContractCatalog } from "../../src/infrastructure/catalog/query-catalog.js";
import { createIngestHeartbeatHandler } from "../../src/infrastructure/ingestion/ingest-heartbeat.js";
import {
  buildHeartbeatSigningPayload,
  sha256Hex,
  signHeartbeatHmacSha256,
} from "../../src/infrastructure/security/heartbeat-hmac.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-t09-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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
  options?: {
    backoffMinutes?: number;
    clientId?: string | null;
    tenantId?: string;
    monitoringStartedAt?: string;
    maxQuiet?: number;
  },
) {
  const core = new SqliteCoreRepositories(sqlite);
  const alerting = new SqliteAlertingRepositories(sqlite);
  const tenant = options?.tenantId
    ? { id: options.tenantId }
    : core.ensureSelfHostedTenant();
  if (options?.tenantId) {
    // ensure exists for saas-style second tenant tests
  }
  const workflowId = createId();
  const now = options?.monitoringStartedAt ?? "2026-07-18T08:00:00.000Z";
  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: options?.clientId ?? null,
    name: "W",
    externalWorkflowId: createId(),
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: now,
  });
  core.createWorkflowContract(tenant.id, {
    id: createId(),
    workflowId,
    name: "C",
    businessPurpose: "Purpose",
    cadenceType: "event_driven",
    cadenceValue: "event",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: null,
    allowedLatenessMinutes: 0,
    maxQuietWindowMinutes: options?.maxQuiet ?? 30,
    initialGraceMinutes: 0,
    emptyResultPolicy: "allowed",
    countLessSuccessAllowed: true,
    notificationBackoffMinutes: options?.backoffMinutes ?? 60,
    evidenceLevel: "basic",
    schemaVersion: 1,
    isActive: true,
    activatedAt: now,
  });
  return { tenant, workflowId, core, alerting };
}

describe("incident suite", () => {
  it("opens hard failure immediately and resolves only that incident on recovery", () => {
    const sqlite = openDb();
    const { tenant, workflowId, alerting, core } = seed(sqlite);
    const keyId = "k1";
    const secret = "secret-value-abcdefghijklmnop";
    core.createCredential(tenant.id, {
      id: createId(),
      workflowId,
      keyId,
      encryptedSecretOrVerificationMaterial: encryptCredentialSecret(
        secret,
        KEK,
      ),
      status: "active",
      rotatedFromId: null,
      revokedAt: null,
    });

    const empty = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "empty_result",
      severity: "warning",
      summary: "empty",
      observedAt: "2026-07-18T08:00:00.000Z",
    });

    const clock = new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
    const ingest = createIngestHeartbeatHandler({
      sqlite,
      env: loadEnv({ NODE_ENV: "test", QUORUM_CREDENTIAL_KEK: KEK }),
      clock,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });

    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: "2026-07-18T08:00:00Z",
        status: "failure",
      }),
      "utf8",
    );
    const ts = String(Math.floor(clock.now().getTime() / 1000));
    const pathName = `/api/v1/workflows/${workflowId}/heartbeats`;
    const signature = signHeartbeatHmacSha256(
      secret,
      buildHeartbeatSigningPayload({
        method: "POST",
        path: pathName,
        timestampSeconds: ts,
        idempotencyKey: "fail-1",
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
        idempotencyKey: "fail-1",
        signatureHex: signature,
        rawBody: body,
      }).status,
    ).toBe("accepted");

    const hard = alerting.getUnresolvedIncident(
      tenant.id,
      "workflow",
      workflowId,
      "hard_failure",
    );
    expect(hard).not.toBeNull();
    expect(alerting.getIncident(tenant.id, empty.id)?.status).toBe("open");

    const okBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: "2026-07-18T08:01:00Z",
        status: "success",
        itemsProcessed: 2,
      }),
      "utf8",
    );
    const okSig = signHeartbeatHmacSha256(
      secret,
      buildHeartbeatSigningPayload({
        method: "POST",
        path: pathName,
        timestampSeconds: ts,
        idempotencyKey: "ok-1",
        bodySha256Hex: sha256Hex(okBody),
      }),
    );
    ingest({
      workflowId,
      method: "POST",
      path: pathName,
      keyId,
      timestampSeconds: ts,
      idempotencyKey: "ok-1",
      signatureHex: okSig,
      rawBody: okBody,
    });

    expect(alerting.getIncident(tenant.id, hard!.id)?.status).toBe("resolved");
    // empty_result also in resolve set for acceptable success
    expect(alerting.getIncident(tenant.id, empty.id)?.status).toBe("resolved");

    // New later failure opens a new incident
    const fail2 = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: "2026-07-18T08:02:00Z",
        status: "failure",
      }),
      "utf8",
    );
    const fail2Sig = signHeartbeatHmacSha256(
      secret,
      buildHeartbeatSigningPayload({
        method: "POST",
        path: pathName,
        timestampSeconds: ts,
        idempotencyKey: "fail-2",
        bodySha256Hex: sha256Hex(fail2),
      }),
    );
    ingest({
      workflowId,
      method: "POST",
      path: pathName,
      keyId,
      timestampSeconds: ts,
      idempotencyKey: "fail-2",
      signatureHex: fail2Sig,
      rawBody: fail2,
    });
    const next = alerting.getUnresolvedIncident(
      tenant.id,
      "workflow",
      workflowId,
      "hard_failure",
    );
    expect(next?.id).not.toBe(hard!.id);
  });

  it("opens one overdue incident + outbox, dedupes, renotifies after backoff, isolates contracts", () => {
    const sqlite = openDb();
    const a = seed(sqlite, {
      monitoringStartedAt: "2026-07-18T08:00:00.000Z",
      backoffMinutes: 60,
      maxQuiet: 30,
    });
    const b = seed(sqlite, {
      tenantId: a.tenant.id,
      monitoringStartedAt: "2026-07-18T08:00:00.000Z",
      backoffMinutes: 60,
      maxQuiet: 30,
    });

    const clock = new FixedClock(new Date("2026-07-18T08:45:00.000Z"));
    const watcher = createWatcher({
      sqlite,
      clock,
      claimOwner: "w1",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    const first = watcher.runTick(a.tenant.id);
    expect(first.openedSilentAbsence).toBeGreaterThanOrEqual(1);

    const outboxCount = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM notification_outbox
           WHERE tenant_id = ? AND event_type = 'opened'`,
        )
        .get(a.tenant.id) as { c: number }
    ).c;
    expect(outboxCount).toBeGreaterThanOrEqual(1);

    const incidentA = a.alerting.getUnresolvedIncident(
      a.tenant.id,
      "workflow",
      a.workflowId,
      "silent_absence",
    )!;
    expect(
      a.alerting.openOrObserveIncident(a.tenant.id, {
        id: createId(),
        contractKind: "workflow",
        workflowId: a.workflowId,
        incidentType: "silent_absence",
        severity: "critical",
        summary: "again",
        observedAt: "2026-07-18T08:50:00.000Z",
      }).id,
    ).toBe(incidentA.id);

    // Race uniqueness
    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO incidents (
             id, tenant_id, client_id, contract_kind, workflow_id, outcome_contract_id,
             incident_type, severity, status, opened_at, last_observed_at,
             notification_count, summary, created_at, updated_at
           ) VALUES (?, ?, NULL, 'workflow', ?, NULL, 'silent_absence', 'critical',
             'open', ?, ?, 0, 'race', ?, ?)`,
        )
        .run(
          createId(),
          a.tenant.id,
          a.workflowId,
          "2026-07-18T08:51:00.000Z",
          "2026-07-18T08:51:00.000Z",
          "2026-07-18T08:51:00.000Z",
          "2026-07-18T08:51:00.000Z",
        );
    }).toThrow();

    a.alerting.markIncidentNotified(
      a.tenant.id,
      incidentA.id,
      "2026-07-18T08:45:00.000Z",
    );
    const renotifyClock = new FixedClock(new Date("2026-07-18T09:50:00.000Z"));
    const renotifyWatcher = createWatcher({
      sqlite,
      clock: renotifyClock,
      claimOwner: "w1",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    const renotify = renotifyWatcher.runTick(a.tenant.id);
    expect(renotify.renotifications).toBeGreaterThanOrEqual(1);
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM notification_outbox
             WHERE incident_id = ? AND event_type = 'renotification'`,
          )
          .get(incidentA.id) as { c: number }
      ).c,
    ).toBeGreaterThanOrEqual(1);

    const incidentB = b.alerting.getUnresolvedIncident(
      b.tenant.id,
      "workflow",
      b.workflowId,
      "silent_absence",
    );
    expect(incidentB?.id).not.toBe(incidentA.id);

    a.alerting.acknowledgeIncident(a.tenant.id, incidentA.id, {
      actor: "ops",
      edition: "saas",
    });
    expect(
      a.alerting.listAuditEvents(a.tenant.id, incidentA.id)[0]?.eventType,
    ).toBe("acknowledged");
  });
});

describe("alert delivery health suite", () => {
  it("records webhook/smtp/timeout failures, isolates channels, and clears via channel test", async () => {
    const sqlite = openDb();
    const { tenant, workflowId, alerting } = seed(sqlite);
    const channelA = createId();
    const channelB = createId();
    for (const [id, name] of [
      [channelA, "A"],
      [channelB, "B"],
    ] as const) {
      alerting.createAlertChannel(tenant.id, {
        id,
        name,
        type: id === channelA ? "webhook" : "email",
        encryptedConfig: encryptCredentialSecret(
          id === channelA
            ? JSON.stringify({ url: "https://hooks.example/a" })
            : JSON.stringify({
                host: "smtp.example",
                port: 587,
                from: "a@ex.com",
                to: ["b@ex.com"],
              }),
          KEK,
        ),
        isActive: true,
      });
      alerting.routeContractToChannel(tenant.id, {
        contractKind: "workflow",
        contractId: workflowId,
        alertChannelId: id,
      });
    }

    const incident = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "overdue",
      observedAt: "2026-07-18T08:45:00.000Z",
    });
    sqlite
      .prepare(
        `INSERT INTO workflow_states (
           tenant_id, workflow_id, last_status, current_health, evidence_level,
           evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks, updated_at
         ) VALUES (?, ?, 'unknown', 'overdue', 'basic', 'overdue', '[]', 0, ?)`,
      )
      .run(tenant.id, workflowId, "2026-07-18T08:45:00.000Z");

    alerting.enqueueOutbox(tenant.id, {
      id: createId(),
      incidentId: incident.id,
      eventType: "opened",
      payloadJson: JSON.stringify({ incidentId: incident.id }),
      availableAt: "2026-07-18T08:45:00.000Z",
    });

    const processor = createOutboxProcessor({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T08:46:00.000Z")),
      kek: KEK,
      claimOwner: "o1",
      claimTtlMs: 30_000,
      maxAttempts: 2,
      retryBaseMs: 1,
      deliveryTimeoutMs: 50,
      publicBaseUrl: "http://127.0.0.1:3000",
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
          errorCode: "smtp_error",
          errorMessage: "smtp_rejected",
          responseStatusCode: null,
        }),
      },
    });

    await processor.processBatch();
    expect(
      alerting.getAlertChannelState(tenant.id, channelA)?.currentHealth,
    ).toBe("degraded");

    const processor2 = createOutboxProcessor({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T08:47:00.000Z")),
      kek: KEK,
      claimOwner: "o1",
      claimTtlMs: 30_000,
      maxAttempts: 2,
      retryBaseMs: 1,
      deliveryTimeoutMs: 50,
      publicBaseUrl: "http://127.0.0.1:3000",
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
          errorCode: "smtp_error",
          errorMessage: "smtp_rejected",
          responseStatusCode: null,
        }),
      },
    });
    await processor2.processBatch();
    expect(
      alerting.getAlertChannelState(tenant.id, channelA)?.currentHealth,
    ).toBe("failing");
    expect(alerting.getIncident(tenant.id, incident.id)?.status).toBe("open");
    const state = sqlite
      .prepare(
        `SELECT evidence_level, current_health FROM workflow_states WHERE workflow_id = ?`,
      )
      .get(workflowId) as { evidence_level: string; current_health: string };
    expect(state.evidence_level).toBe("basic");
    expect(state.current_health).toBe("overdue");

    // Channel B independent failing via timeout path
    alerting.applyChannelDeliveryResult(tenant.id, channelB, {
      type: "delivery_failed",
      retriesRemaining: true,
      errorCode: "timeout",
      errorMessage: "timeout",
    });
    expect(
      alerting.getAlertChannelState(tenant.id, channelB)?.currentHealth,
    ).toBe("degraded");
    expect(
      alerting.getAlertChannelState(tenant.id, channelA)?.currentHealth,
    ).toBe("failing");

    const catalog = queryContractCatalog({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T09:00:00.000Z")),
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    expect(catalog[0]?.alertChannelHealth).toBe("failing");
    expect(catalog[0]?.activeIncident?.type).toBe("silent_absence");
    expect(catalog[0]?.unverifiedDimensions).toContain(
      "destination_delivery_not_checked",
    );

    // Clear via successful channel test on A
    alerting.applyChannelDeliveryResult(tenant.id, channelA, {
      type: "test_succeeded",
    });
    expect(
      alerting.getAlertChannelState(tenant.id, channelA)?.currentHealth,
    ).toBe("healthy");
  });
});

describe("catalog read-model suite", () => {
  it("enforces tenant/client filters, sort order, and independent health/evidence", () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const tenantA = core.ensureSelfHostedTenant();
    const tenantB = createId();
    const now = "2026-07-18T08:00:00.000Z";
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Agency', 'saas', ?, ?)`,
      )
      .run(tenantB, now, now);

    const clientA = createId();
    const clientB = createId();
    core.createClient(tenantA.id, {
      id: clientA,
      name: "Client A",
      slug: "client-a",
      status: "protected",
      protectionStartedAt: now,
    });
    core.createClient(tenantA.id, {
      id: clientB,
      name: "Client B",
      slug: "client-b",
      status: "protected",
      protectionStartedAt: now,
    });

    const healthy = seed(sqlite, { tenantId: tenantA.id, clientId: clientB });
    sqlite
      .prepare(
        `INSERT INTO workflow_states (
           tenant_id, workflow_id, last_status, current_health, evidence_level,
           evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks, updated_at
         ) VALUES (?, ?, 'success', 'healthy', 'basic', 'ok', '[]', 0, ?)`,
      )
      .run(tenantA.id, healthy.workflowId, now);

    const critical = seed(sqlite, { tenantId: tenantA.id, clientId: clientA });
    sqlite
      .prepare(
        `INSERT INTO workflow_states (
           tenant_id, workflow_id, last_status, current_health, evidence_level,
           evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks, updated_at
         ) VALUES (?, ?, 'unknown', 'overdue', 'basic', 'overdue', '[]', 0, ?)`,
      )
      .run(tenantA.id, critical.workflowId, now);
    critical.alerting.openOrObserveIncident(tenantA.id, {
      id: createId(),
      clientId: clientA,
      contractKind: "workflow",
      workflowId: critical.workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "silence",
      observedAt: now,
    });

    const otherTenant = seed(sqlite, { tenantId: tenantB });
    sqlite
      .prepare(
        `INSERT INTO workflow_states (
           tenant_id, workflow_id, last_status, current_health, evidence_level,
           evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks, updated_at
         ) VALUES (?, ?, 'success', 'healthy', 'basic', 'ok', '[]', 0, ?)`,
      )
      .run(tenantB, otherTenant.workflowId, now);

    const all = queryContractCatalog({
      sqlite,
      clock: new FixedClock(new Date(now)),
      tenantId: tenantA.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    expect(all.every((row) => row.tenantId === tenantA.id)).toBe(true);
    expect(all.some((row) => row.workflowId === otherTenant.workflowId)).toBe(
      false,
    );
    expect(all[0]?.activeIncident?.severity).toBe("critical");

    const filtered = queryContractCatalog({
      sqlite,
      clock: new FixedClock(new Date(now)),
      tenantId: tenantA.id,
      clientId: clientA,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    expect(filtered.every((row) => row.clientId === clientA)).toBe(true);

    const page = queryContractCatalog({
      sqlite,
      clock: new FixedClock(new Date(now)),
      tenantId: tenantA.id,
      publicBaseUrl: "http://127.0.0.1:3000",
      limit: 1,
      offset: 0,
    });
    expect(page).toHaveLength(1);

    const healthyRow = all.find(
      (row) => row.workflowId === healthy.workflowId,
    )!;
    expect(healthyRow.health).toBe("healthy");
    expect(healthyRow.evidenceLevel).toBe("basic");
    expect(healthyRow.unverifiedDimensions).toContain(
      "destination_delivery_not_checked",
    );
  });
});
