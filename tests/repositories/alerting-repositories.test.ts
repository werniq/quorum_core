import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  migrateSqliteToLatest,
  migrateSqliteUpTo,
  openSqliteDatabase,
  getAppliedSqliteMigrationTags,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { listMigrationTags } from "../../src/infrastructure/db/migrations.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { SqliteAlertingRepositories } from "../../src/infrastructure/db/repositories/sqlite-alerting-repositories.js";
import { createId } from "../../src/domain/ids.js";
import { sanitizeDeliveryErrorMessage } from "../../src/domain/alerting/sanitize-delivery-error.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openRepos(): {
  sqlite: BetterSqliteDatabase.Database;
  core: SqliteCoreRepositories;
  alerting: SqliteAlertingRepositories;
} {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-alerting-repos-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  const { sqlite } = openSqliteDatabase(filePath);
  openConnections.push(sqlite);
  migrateSqliteToLatest(sqlite);
  return {
    sqlite,
    core: new SqliteCoreRepositories(sqlite),
    alerting: new SqliteAlertingRepositories(sqlite),
  };
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

describe("alerting schema repositories", () => {
  it("migrates forward to incidents/alerting/outbox without data loss", () => {
    const filePath = path.join(
      os.tmpdir(),
      `quorum-alerting-fwd-${Date.now()}.db`,
    );
    tempFiles.push(filePath);
    const { sqlite } = openSqliteDatabase(filePath);
    openConnections.push(sqlite);
    migrateSqliteUpTo(sqlite, "0003_credentials_heartbeats_state");
    const tenantId = createId();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'T', 'self_hosted', ?, ?)`,
      )
      .run(tenantId, now, now);

    migrateSqliteToLatest(sqlite);
    expect(getAppliedSqliteMigrationTags(sqlite)).toEqual(
      listMigrationTags("sqlite"),
    );
    expect(
      (
        sqlite
          .prepare(`SELECT COUNT(*) AS c FROM tenants WHERE id = ?`)
          .get(tenantId) as { c: number }
      ).c,
    ).toBe(1);
    expect(listMigrationTags("sqlite")).toContain(
      "0004_incidents_alerting_outbox",
    );
  });

  it("updates one unresolved incident instead of opening duplicates", () => {
    const { core, alerting } = openRepos();
    const tenant = core.ensureSelfHostedTenant();
    const now = new Date().toISOString();
    const workflowId = createId();
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

    const first = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "missed run",
      observedAt: now,
    });
    const second = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "still missing",
      detailsJson: JSON.stringify({ checks: 2 }),
      observedAt: new Date(Date.now() + 1000).toISOString(),
    });

    expect(second.id).toBe(first.id);
    expect(alerting.listIncidents(tenant.id)).toHaveLength(1);
    expect(second.detailsJson).toContain("checks");
  });

  it("keeps recovery operationally separate from idempotent acknowledgment", () => {
    const { core, alerting } = openRepos();
    const tenant = core.ensureSelfHostedTenant();
    const now = "2026-08-05T08:00:00.000Z";
    const workflowId = createId();
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "Recovery workflow",
      externalWorkflowId: "recovery-workflow",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });
    const opened = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "empty_result",
      severity: "critical",
      summary: "zero useful output",
      observedAt: now,
    });
    expect(opened).toMatchObject({
      lifecycleStatus: "active",
      acknowledgmentStatus: "unacknowledged",
    });
    expect(() =>
      alerting.acknowledgeIncident(tenant.id, opened.id, {
        actor: "admin-user",
        at: "2026-08-05T08:01:00.000Z",
      }),
    ).toThrow(/Invalid incident transition/);
    const recovered = alerting.resolveIncident(tenant.id, opened.id, {
      actor: "system:heartbeat",
      at: "2026-08-05T08:05:00.000Z",
      recoveryEvidence: "success · 1 item",
    });
    expect(recovered).toMatchObject({
      status: "resolved",
      lifecycleStatus: "recovered",
      acknowledgmentStatus: "unacknowledged",
      recoveredAt: "2026-08-05T08:05:00.000Z",
      recoveryEvidence: "success · 1 item",
    });
    const acknowledged = alerting.acknowledgeIncident(tenant.id, opened.id, {
      actor: "admin-user",
      at: "2026-08-05T08:10:00.000Z",
      note: "Reviewed with operations",
    });
    expect(acknowledged).toMatchObject({
      status: "resolved",
      lifecycleStatus: "recovered",
      acknowledgmentStatus: "acknowledged",
      acknowledgedBy: "admin-user",
      acknowledgedAt: "2026-08-05T08:10:00.000Z",
      acknowledgmentNote: "Reviewed with operations",
    });
    expect(
      alerting.acknowledgeIncident(tenant.id, opened.id, {
        actor: "different-user",
        at: "2026-08-05T08:20:00.000Z",
      }),
    ).toEqual(acknowledged);
  });

  it("isolates incidents and channels by tenant", () => {
    const { sqlite, core, alerting } = openRepos();
    const tenantA = core.ensureSelfHostedTenant();
    const tenantB = createId();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Agency', 'saas', ?, ?)`,
      )
      .run(tenantB, now, now);

    const workflowA = createId();
    const workflowB = createId();
    core.createWorkflow(tenantA.id, {
      id: workflowA,
      clientId: null,
      name: "A",
      externalWorkflowId: "a",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });
    core.createWorkflow(tenantB, {
      id: workflowB,
      clientId: null,
      name: "B",
      externalWorkflowId: "b",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });

    alerting.openOrObserveIncident(tenantA.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId: workflowA,
      incidentType: "hard_failure",
      severity: "warning",
      summary: "fail A",
    });
    alerting.openOrObserveIncident(tenantB, {
      id: createId(),
      contractKind: "workflow",
      workflowId: workflowB,
      incidentType: "hard_failure",
      severity: "warning",
      summary: "fail B",
    });

    expect(alerting.listIncidents(tenantA.id)).toHaveLength(1);
    expect(alerting.listIncidents(tenantA.id)[0]?.summary).toBe("fail A");
    expect(alerting.listIncidents(tenantB)).toHaveLength(1);

    const channelB = createId();
    alerting.createAlertChannel(tenantB, {
      id: channelB,
      name: "B hook",
      type: "webhook",
      encryptedConfig: "enc",
      isActive: true,
    });
    expect(() =>
      alerting.routeContractToChannel(tenantA.id, {
        contractKind: "workflow",
        contractId: workflowA,
        alertChannelId: channelB,
      }),
    ).toThrow(/not visible/);
  });

  it("tracks alert-channel health independently and sanitizes delivery errors", () => {
    const { core, alerting } = openRepos();
    const tenant = core.ensureSelfHostedTenant();
    const channelId = createId();
    alerting.createAlertChannel(tenant.id, {
      id: channelId,
      name: "Ops",
      type: "email",
      encryptedConfig: "enc",
      isActive: true,
    });

    const degraded = alerting.applyChannelDeliveryResult(tenant.id, channelId, {
      type: "delivery_failed",
      retriesRemaining: true,
      errorCode: "timeout",
      errorMessage: "webhook failed api_key=super-secret",
    });
    expect(degraded.currentHealth).toBe("degraded");
    expect(degraded.lastErrorMessageSanitized).toContain("[redacted]");
    expect(degraded.lastErrorMessageSanitized).not.toContain("super-secret");

    const failing = alerting.applyChannelDeliveryResult(tenant.id, channelId, {
      type: "delivery_failed",
      retriesRemaining: false,
      errorMessage: "Bearer abc.def.ghi rejected",
    });
    expect(failing.currentHealth).toBe("failing");

    const healthy = alerting.applyChannelDeliveryResult(tenant.id, channelId, {
      type: "test_succeeded",
    });
    expect(healthy.currentHealth).toBe("healthy");
    expect(healthy.consecutiveFailures).toBe(0);
  });

  it("persists outbox events and notification attempts with threading fields", () => {
    const { core, alerting } = openRepos();
    const tenant = core.ensureSelfHostedTenant();
    const now = new Date().toISOString();
    const workflowId = createId();
    const channelId = createId();
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
    alerting.createAlertChannel(tenant.id, {
      id: channelId,
      name: "Hook",
      type: "webhook",
      encryptedConfig: "enc",
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
      incidentType: "empty_result",
      severity: "warning",
      summary: "empty",
    });
    const outbox = alerting.enqueueOutbox(tenant.id, {
      id: createId(),
      incidentId: incident.id,
      eventType: "opened",
      payloadJson: JSON.stringify({ incidentId: incident.id }),
      availableAt: now,
    });
    alerting.recordNotificationAttempt(tenant.id, {
      id: createId(),
      incidentId: incident.id,
      alertChannelId: channelId,
      outboxId: outbox.id,
      status: "failed",
      attemptedAt: now,
      deliveredAt: null,
      externalMessageId: null,
      externalThreadId: "thread-1",
      responseStatusCode: 500,
      errorCode: "upstream",
      errorMessageSanitized: "password=should-hide",
    });

    const attempts = alerting.listNotificationAttempts(tenant.id, outbox.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.externalThreadId).toBe("thread-1");
    expect(attempts[0]?.errorMessageSanitized).toContain("[redacted]");
    expect(attempts[0]?.errorMessageSanitized).not.toContain("should-hide");
    expect(
      alerting.listRoutesForContract(tenant.id, "workflow", workflowId),
    ).toHaveLength(1);
  });
});

describe("sanitizeDeliveryErrorMessage", () => {
  it("redacts secret-like tokens", () => {
    expect(sanitizeDeliveryErrorMessage("token=abc123 failed")).toContain(
      "[redacted]",
    );
  });
});
