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
import { buildApp } from "../../src/infrastructure/http/app.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { shouldEnqueueRenotification } from "../../src/domain/alerting/renotification.js";
import {
  catalogSortBucket,
  compareCatalogSortBuckets,
} from "../../src/domain/catalog/sort.js";
import { transitionIncidentStatus } from "../../src/domain/incidents/lifecycle.js";
import { SILENT_ABSENCE_MESSAGE } from "../../src/domain/n8n/workflow-editor-url.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-w08-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function seedContract(
  sqlite: BetterSqliteDatabase.Database,
  options?: {
    monitoringStartedAt?: string;
    maxQuietWindowMinutes?: number;
    initialGraceMinutes?: number;
    backoffMinutes?: number;
  },
) {
  const core = new SqliteCoreRepositories(sqlite);
  const alerting = new SqliteAlertingRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const workflowId = createId();
  const now = options?.monitoringStartedAt ?? "2026-07-18T08:00:00.000Z";
  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "Invoices",
    externalWorkflowId: createId(),
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: now,
  });
  core.createWorkflowContract(tenant.id, {
    id: createId(),
    workflowId,
    name: "Invoice heartbeat",
    businessPurpose: "Daily invoice sync",
    cadenceType: "event_driven",
    cadenceValue: "event",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: null,
    allowedLatenessMinutes: 0,
    maxQuietWindowMinutes: options?.maxQuietWindowMinutes ?? 30,
    initialGraceMinutes: options?.initialGraceMinutes ?? 0,
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

describe("incident lifecycle", () => {
  it("supports open → acknowledged → resolved and rejects invalid transitions", () => {
    expect(transitionIncidentStatus("open", "acknowledged")).toBe(
      "acknowledged",
    );
    expect(transitionIncidentStatus("acknowledged", "resolved")).toBe(
      "resolved",
    );
    expect(() => transitionIncidentStatus("resolved", "open")).toThrow();
  });

  it("dedupes observations, audits ack/resolve, and enqueues one outbox on open", () => {
    const sqlite = openDb();
    const { tenant, workflowId, alerting } = seedContract(sqlite);
    const first = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "missing",
      observedAt: "2026-07-18T09:00:00.000Z",
    });
    alerting.enqueueOutbox(tenant.id, {
      id: createId(),
      incidentId: first.id,
      eventType: "opened",
      payloadJson: JSON.stringify({ incidentId: first.id }),
      availableAt: "2026-07-18T09:00:00.000Z",
    });
    const second = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "missing again",
      observedAt: "2026-07-18T09:05:00.000Z",
    });
    expect(second.id).toBe(first.id);
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM incidents WHERE workflow_id = ? AND status IN ('open','acknowledged')`,
          )
          .get(workflowId) as { c: number }
      ).c,
    ).toBe(1);

    alerting.acknowledgeIncident(tenant.id, first.id, {
      actor: "ops@example.com",
      edition: "saas",
      at: "2026-07-18T09:10:00.000Z",
    });
    alerting.resolveIncident(tenant.id, first.id, {
      actor: "ops@example.com",
      edition: "saas",
      at: "2026-07-18T09:20:00.000Z",
    });
    const audit = alerting.listAuditEvents(tenant.id, first.id);
    expect(audit.map((row) => row.eventType)).toEqual([
      "acknowledged",
      "resolved",
    ]);
  });
});

describe("renotification backoff", () => {
  it("follows contract backoff without opening a new incident", () => {
    const clock = new FixedClock(new Date("2026-07-18T10:00:00.000Z"));
    expect(
      shouldEnqueueRenotification({
        lastNotifiedAt: new Date("2026-07-18T09:00:00.000Z"),
        openedAt: new Date("2026-07-18T08:00:00.000Z"),
        backoffMinutes: 60,
        clock,
      }),
    ).toBe(true);
    expect(
      shouldEnqueueRenotification({
        lastNotifiedAt: new Date("2026-07-18T09:30:00.000Z"),
        openedAt: new Date("2026-07-18T08:00:00.000Z"),
        backoffMinutes: 60,
        clock,
      }),
    ).toBe(false);
  });
});

describe("watcher", () => {
  it("opens one silent_absence incident when overdue and updates watcher health", () => {
    const sqlite = openDb();
    const { tenant, workflowId } = seedContract(sqlite, {
      monitoringStartedAt: "2026-07-18T08:00:00.000Z",
      maxQuietWindowMinutes: 30,
      initialGraceMinutes: 0,
    });
    const clock = new FixedClock(new Date("2026-07-18T08:45:00.000Z"));
    const watcher = createWatcher({
      sqlite,
      clock,
      claimOwner: "watcher-1",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });

    const first = watcher.runTick(tenant.id);
    expect(first.openedSilentAbsence).toBe(1);
    expect(first.evaluated).toBe(1);
    const second = watcher.runTick(tenant.id);
    expect(second.openedSilentAbsence).toBe(0);
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM incidents
             WHERE workflow_id = ? AND incident_type = 'silent_absence'
               AND status IN ('open','acknowledged')`,
          )
          .get(workflowId) as { c: number }
      ).c,
    ).toBe(1);

    const state = watcher.getRunState();
    expect(state.lastSuccessAt).toBe("2026-07-18T08:45:00.000Z");
    expect(state.evaluatedContracts).toBe(1);
  });

  it("resolves silent_absence when cadence becomes healthy again", () => {
    const sqlite = openDb();
    const { tenant, workflowId } = seedContract(sqlite, {
      monitoringStartedAt: "2026-07-18T08:00:00.000Z",
      maxQuietWindowMinutes: 30,
    });
    const overdueClock = new FixedClock(new Date("2026-07-18T08:45:00.000Z"));
    const watcher = createWatcher({
      sqlite,
      clock: overdueClock,
      claimOwner: "watcher-1",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    watcher.runTick(tenant.id);

    sqlite
      .prepare(
        `UPDATE workflow_states
         SET last_acceptable_success_at = ?, last_status = 'success'
         WHERE workflow_id = ?`,
      )
      .run("2026-07-18T08:50:00.000Z", workflowId);

    const healthyClock = new FixedClock(new Date("2026-07-18T09:00:00.000Z"));
    const healthyWatcher = createWatcher({
      sqlite,
      clock: healthyClock,
      claimOwner: "watcher-1",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    const result = healthyWatcher.runTick(tenant.id);
    expect(result.resolvedSilentAbsence).toBe(1);
  });

  it("moves a 1-minute fixed-rate contract Healthy → warning → Overdue → recovered without requiring an alert channel", () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const workflowId = createId();
    const contractId = createId();
    const anchor = "2026-07-18T14:00:00.000Z";
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "Poll invoices",
      externalWorkflowId: createId(),
      description: null,
      monitoringMethod: "poll",
      isActive: true,
      monitoringStartedAt: anchor,
    });
    core.createWorkflowContract(tenant.id, {
      id: contractId,
      workflowId,
      name: "Poll invoices",
      businessPurpose: "Poll invoices",
      cadenceType: "interval",
      cadenceValue: "1",
      intervalMode: "fixed_rate",
      scheduleAnchorAt: anchor,
      timezone: null,
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: 60,
      initialGraceMinutes: 0,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 60,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: anchor,
    });
    core.upsertWorkflowState(tenant.id, {
      tenantId: tenant.id,
      workflowId,
      lastExecutionAt: anchor,
      lastNonemptySuccessAt: anchor,
      lastAcceptableSuccessAt: anchor,
      lastFailureAt: null,
      lastExternalExecutionRef: "exec-1",
      lastStatus: "success",
      nextExpectedAt: null,
      overdueSince: null,
      currentHealth: "healthy",
      evidenceLevel: "basic",
      evidenceSummaryCode: "healthy_occurrence_satisfied",
      unverifiedDimensionsJson: "[]",
      consecutiveStaleChecks: 0,
      updatedAt: anchor,
    });

    const runAt = (iso: string) => {
      const watcher = createWatcher({
        sqlite,
        clock: new FixedClock(new Date(iso)),
        claimOwner: "watcher-1",
        claimTtlMs: 55_000,
        getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      });
      return watcher.runTick(tenant.id);
    };

    expect(runAt("2026-07-18T14:00:30.000Z").openedSilentAbsence).toBe(0);
    expect(
      (
        sqlite
          .prepare(
            `SELECT current_health AS h FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { h: string }
      ).h,
    ).toBe("healthy");

    expect(runAt("2026-07-18T14:03:00.000Z").openedSilentAbsence).toBe(0);
    expect(
      (
        sqlite
          .prepare(
            `SELECT current_health AS h, evidence_summary_code AS c FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { h: string; c: string }
      ).h,
    ).toBe("warning");

    const overdueTick = runAt("2026-07-18T14:06:01.000Z");
    expect(overdueTick.openedSilentAbsence).toBe(1);
    expect(
      (
        sqlite
          .prepare(
            `SELECT current_health AS h FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { h: string }
      ).h,
    ).toBe("overdue");
    expect(
      (
        sqlite
          .prepare(
            `SELECT summary FROM incidents
             WHERE workflow_id = ? AND incident_type = 'silent_absence' AND status = 'open'`,
          )
          .get(workflowId) as { summary: string }
      ).summary,
    ).toBe(SILENT_ABSENCE_MESSAGE);

    const catalog = queryContractCatalog({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T14:06:30.000Z")),
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    const row = catalog.find((r) => r.workflowId === workflowId);
    expect(row?.health).toBe("overdue");
    expect(row?.alertChannelHealth).toBe("none");
    expect(row?.activeIncident?.type).toBe("silent_absence");

    sqlite
      .prepare(
        `UPDATE workflow_states
         SET last_acceptable_success_at = ?, last_status = 'success'
         WHERE workflow_id = ?`,
      )
      .run("2026-07-18T14:07:00.000Z", workflowId);
    const recovered = runAt("2026-07-18T14:07:15.000Z");
    expect(recovered.resolvedSilentAbsence).toBe(1);
    expect(
      (
        sqlite
          .prepare(
            `SELECT current_health AS h FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { h: string }
      ).h,
    ).toBe("healthy");
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents WHERE workflow_id = ? AND incident_type = 'silent_absence'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("resolved");
  });

  it("opens silent_absence on overdue even when an alert channel is routed", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const workflowId = createId();
    const anchor = "2026-07-18T14:00:00.000Z";
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "Poll with alerts",
      externalWorkflowId: createId(),
      description: null,
      monitoringMethod: "poll",
      isActive: true,
      monitoringStartedAt: anchor,
    });
    const contractId = createId();
    core.createWorkflowContract(tenant.id, {
      id: contractId,
      workflowId,
      name: "Poll with alerts",
      businessPurpose: "Poll with alerts",
      cadenceType: "interval",
      cadenceValue: "1",
      intervalMode: "fixed_rate",
      scheduleAnchorAt: anchor,
      timezone: null,
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: 60,
      initialGraceMinutes: 0,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 60,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: anchor,
    });
    core.upsertWorkflowState(tenant.id, {
      tenantId: tenant.id,
      workflowId,
      lastExecutionAt: anchor,
      lastNonemptySuccessAt: anchor,
      lastAcceptableSuccessAt: anchor,
      lastFailureAt: null,
      lastExternalExecutionRef: "exec-1",
      lastStatus: "success",
      nextExpectedAt: null,
      overdueSince: null,
      currentHealth: "healthy",
      evidenceLevel: "basic",
      evidenceSummaryCode: null,
      unverifiedDimensionsJson: "[]",
      consecutiveStaleChecks: 0,
      updatedAt: anchor,
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
      contractId,
      alertChannelId: channelId,
    });

    const watcher = createWatcher({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T14:06:01.000Z")),
      claimOwner: "watcher-1",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    expect(watcher.runTick(tenant.id).openedSilentAbsence).toBe(1);

    const processor = createOutboxProcessor({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T14:06:30.000Z")),
      kek: KEK,
      claimOwner: "outbox-1",
      claimTtlMs: 30_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      deliveryTimeoutMs: 1_000,
      publicBaseUrl: "http://127.0.0.1:3000",
      edition: "self_hosted",
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      providers: {
        deliverWebhook: async () => ({
          ok: true,
          externalMessageId: "msg-1",
          externalThreadId: "thread-1",
          responseStatusCode: 200,
        }),
        deliverSmtp: async () => ({
          ok: false,
          errorCode: "unused",
          errorMessage: "unused",
          responseStatusCode: null,
        }),
      },
    });
    const batch = await processor.processBatch();
    expect(batch.delivered).toBe(1);

    const catalog = queryContractCatalog({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T14:06:30.000Z")),
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    expect(catalog.find((r) => r.workflowId === workflowId)?.health).toBe(
      "overdue",
    );
  });
});

describe("alert delivery and catalog", () => {
  it("delivers via webhook after incident commit and records channel failure without rollback", async () => {
    const sqlite = openDb();
    const { tenant, workflowId, alerting } = seedContract(sqlite);
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

    const incident = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "overdue",
      detailsJson: JSON.stringify({
        expectedAt: "2026-07-18T08:00:00.000Z",
        deadlineAt: "2026-07-18T08:30:00.000Z",
        overdueSince: "2026-07-18T08:30:00.000Z",
      }),
      observedAt: "2026-07-18T08:45:00.000Z",
    });
    alerting.enqueueOutbox(tenant.id, {
      id: createId(),
      incidentId: incident.id,
      eventType: "opened",
      payloadJson: JSON.stringify({ incidentId: incident.id }),
      availableAt: "2026-07-18T08:45:00.000Z",
    });

    // Incident exists before delivery.
    expect(alerting.getIncident(tenant.id, incident.id)?.status).toBe("open");

    let deliveredPayload: unknown;
    const processor = createOutboxProcessor({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T08:46:00.000Z")),
      kek: KEK,
      claimOwner: "outbox-1",
      claimTtlMs: 30_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      deliveryTimeoutMs: 1_000,
      publicBaseUrl: "http://127.0.0.1:3000",
      edition: "self_hosted",
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      providers: {
        deliverWebhook: async (_config, payload) => {
          deliveredPayload = payload;
          return {
            ok: true,
            externalMessageId: "msg-1",
            externalThreadId: "thread-1",
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

    const ok = await processor.processBatch();
    expect(ok.delivered).toBe(1);
    expect(deliveredPayload).toMatchObject({
      schemaVersion: 1,
      evidence: { level: "basic" },
      catalogEntryUrl: expect.stringContaining(workflowId),
    });
    expect(
      alerting.getAlertChannelState(tenant.id, channelId)?.currentHealth,
    ).toBe("healthy");

    // Failure path: exhausted retries mark channel failing; incident remains.
    const failIncident = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "hard_failure",
      severity: "critical",
      summary: "fail",
      observedAt: "2026-07-18T09:00:00.000Z",
    });
    const failOutbox = createId();
    alerting.enqueueOutbox(tenant.id, {
      id: failOutbox,
      incidentId: failIncident.id,
      eventType: "opened",
      payloadJson: JSON.stringify({ incidentId: failIncident.id }),
      availableAt: "2026-07-18T09:00:00.000Z",
    });

    const failing = createOutboxProcessor({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T09:01:00.000Z")),
      kek: KEK,
      claimOwner: "outbox-1",
      claimTtlMs: 30_000,
      maxAttempts: 1,
      retryBaseMs: 1_000,
      deliveryTimeoutMs: 1_000,
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
          errorCode: "unused",
          errorMessage: "unused",
          responseStatusCode: null,
        }),
      },
    });
    const failed = await failing.processBatch();
    expect(failed.failed).toBe(1);
    expect(alerting.getIncident(tenant.id, failIncident.id)?.status).toBe(
      "open",
    );
    expect(
      alerting.getAlertChannelState(tenant.id, channelId)?.currentHealth,
    ).toBe("failing");
  });

  it("sorts catalog by attention and answers the primary product question", () => {
    expect(
      compareCatalogSortBuckets(
        catalogSortBucket({
          health: "healthy",
          hasCriticalIncident: true,
          alertChannelHealth: "healthy",
        }),
        catalogSortBucket({
          health: "overdue",
          hasCriticalIncident: false,
          alertChannelHealth: "none",
        }),
      ),
    ).toBeLessThan(0);

    const sqlite = openDb();
    const { tenant, workflowId, alerting } = seedContract(sqlite);
    sqlite
      .prepare(
        `INSERT INTO workflow_states (
           tenant_id, workflow_id, last_status, current_health, evidence_level,
           evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks,
           next_expected_at, overdue_since, updated_at
         ) VALUES (?, ?, 'unknown', 'overdue', 'basic', 'overdue', '[]', 0, ?, ?, ?)`,
      )
      .run(
        tenant.id,
        workflowId,
        "2026-07-18T08:30:00.000Z",
        "2026-07-18T08:30:00.000Z",
        "2026-07-18T08:45:00.000Z",
      );
    alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "silence",
      observedAt: "2026-07-18T08:45:00.000Z",
    });

    const catalog = queryContractCatalog({
      sqlite,
      clock: new FixedClock(new Date("2026-07-18T09:00:00.000Z")),
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    expect(catalog[0]).toMatchObject({
      workflowId,
      health: "overdue",
      evidenceLevel: "basic",
      activeIncident: { type: "silent_absence", severity: "critical" },
    });
    expect(catalog[0]?.unverifiedDimensions.length).toBeGreaterThan(0);
    expect(catalog[0]?.detailUrl).toContain(workflowId);
  });
});

describe("health endpoints", () => {
  it("exposes live/ready/watcher with stale watcher non-200", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-18T12:00:00.000Z"));
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        WATCHER_STALE_MS: "60000",
        PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      }),
      clock,
      sqlite,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      getWatcherHealth: () => ({
        lastSuccessAt: "2026-07-18T11:00:00.000Z",
        staleAfterMs: 60_000,
        nowMs: clock.now().getTime(),
      }),
    });

    expect(
      (await app.inject({ method: "GET", url: "/health/live" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/health/ready" })).statusCode,
    ).toBe(200);
    const watcher = await app.inject({ method: "GET", url: "/health/watcher" });
    expect(watcher.statusCode).toBe(503);
    expect(watcher.json()).toMatchObject({
      status: "stale",
      documentation: expect.stringContaining("external uptime check"),
    });

    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/catalog/contracts",
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      question: expect.stringContaining("What should happen"),
    });
    await app.close();
  });
});
