import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { buildApp } from "../../src/infrastructure/http/app.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { SqliteAuthRepositories } from "../../src/infrastructure/db/repositories/sqlite-auth-repositories.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { SqliteAlertingRepositories } from "../../src/infrastructure/db/repositories/sqlite-alerting-repositories.js";
import {
  sanitizeOpsAuditDetails,
  SqliteOpsAuditRepositories,
} from "../../src/infrastructure/db/repositories/sqlite-ops-audit-repositories.js";
import { SESSION_COOKIE } from "../../src/infrastructure/http/cookies.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";
const SETUP = "setup-ops-audit-token-1234567890ab";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-ops-audit-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

async function boot(sqlite: BetterSqliteDatabase.Database, clock: FixedClock) {
  return buildApp({
    env: loadEnv({
      NODE_ENV: "test",
      QUORUM_CREDENTIAL_KEK: KEK,
      QUORUM_UI_AUTH_ENABLED: "true",
    }),
    clock,
    sqlite,
    enableUi: true,
    getSchemaReadiness: () => ({
      status: "ready",
      appliedMigrations: ["0015_ops_audit_events"],
    }),
  });
}

async function setupAdmin(
  sqlite: BetterSqliteDatabase.Database,
  clock: FixedClock,
) {
  const auth = new SqliteAuthRepositories(sqlite);
  const core = new SqliteCoreRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  auth.registerSetupTokenFromEnv(SETUP, clock.now());
  const app = await boot(sqlite, clock);
  const setup = await app.inject({
    method: "POST",
    url: "/setup",
    payload: `setupToken=${encodeURIComponent(SETUP)}&username=admin&password=${encodeURIComponent("strong-local-password")}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(setup.statusCode).toBe(302);
  sqlite
    .prepare(
      `INSERT INTO onboarding_state (tenant_id, step, completed_at, updated_at)
       VALUES (?, 'catalog', ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         step = excluded.step,
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at`,
    )
    .run(tenant.id, clock.now().toISOString(), clock.now().toISOString());
  const login = auth.tryLogin({
    username: "admin",
    password: "strong-local-password",
    ipKey: "127.0.0.1",
    now: clock.now(),
  });
  expect(login.ok).toBe(true);
  if (!login.ok) {
    throw new Error("login_failed");
  }
  return {
    app,
    auth,
    tenant,
    cookie: `${SESSION_COOKIE}=${login.sessionId}`,
    csrf: login.csrfToken,
    session: {
      adminUserId: "",
      csrfToken: login.csrfToken,
      role: "admin" as const,
    },
  };
}

describe("ops audit coverage", () => {
  it("strips secrets from details_json payloads", () => {
    expect(
      sanitizeOpsAuditDetails({
        workflowId: "w1",
        password: "nope",
        apiKey: "secret-key",
        nested: { token: "x", ok: true },
      }),
    ).toEqual({
      workflowId: "w1",
      nested: { ok: true },
    });
  });

  it("writes audit rows for setup, credentials, contracts, alerts, and connectors", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const { app, cookie, csrf, tenant } = await setupAdmin(sqlite, clock);
    const ops = new SqliteOpsAuditRepositories(sqlite);
    const core = new SqliteCoreRepositories(sqlite);

    expect(
      ops.listForTenant(tenant.id, { action: "admin.setup_completed" }).length,
    ).toBeGreaterThanOrEqual(1);

    const workflowId = createId();
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "W",
      externalWorkflowId: "ext",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: clock.now().toISOString(),
    });

    const cred = await app.inject({
      method: "POST",
      url: `/workflows/${workflowId}/credentials`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(cred.statusCode).toBe(200);
    expect(
      ops.listForTenant(tenant.id, { action: "credential.created" }).length,
    ).toBe(1);

    const credRow = sqlite
      .prepare(
        `SELECT id FROM workflow_credentials WHERE tenant_id = ? AND workflow_id = ? LIMIT 1`,
      )
      .get(tenant.id, workflowId) as { id: string };
    const rotate = await app.inject({
      method: "POST",
      url: `/workflows/${workflowId}/credentials/${credRow.id}/rotate`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(rotate.statusCode).toBe(200);
    expect(
      ops.listForTenant(tenant.id, { action: "credential.rotated" }).length,
    ).toBe(1);

    const activeCred = sqlite
      .prepare(
        `SELECT id FROM workflow_credentials WHERE tenant_id = ? AND status = 'active' LIMIT 1`,
      )
      .get(tenant.id) as { id: string };
    const revoke = await app.inject({
      method: "POST",
      url: `/workflows/${workflowId}/credentials/${activeCred.id}/revoke`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(revoke.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "credential.revoked" }).length,
    ).toBe(1);

    const contractId = createId();
    core.createWorkflowContract(tenant.id, {
      id: contractId,
      workflowId,
      name: "c",
      businessPurpose: "p",
      cadenceType: "interval",
      cadenceValue: "15",
      intervalMode: "fixed_rate",
      scheduleAnchorAt: clock.now().toISOString(),
      timezone: "UTC",
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: null,
      initialGraceMinutes: 5,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 30,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: clock.now().toISOString(),
    });
    const cadence = await app.inject({
      method: "POST",
      url: `/contracts/${contractId}/cadence`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&cadenceType=interval&cadenceValue=30&workflowId=${workflowId}`,
    });
    expect(cadence.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "contract.cadence_changed" })
        .length,
    ).toBe(1);

    const deactivate = await app.inject({
      method: "POST",
      url: `/contracts/${contractId}/deactivate`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(deactivate.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "contract.deactivated" }).length,
    ).toBe(1);

    const alert = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&name=Ops&url=https://example.com/hook`,
    });
    expect(alert.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "alert_channel.created" }).length,
    ).toBe(1);
    const channelId = sqlite
      .prepare(`SELECT id FROM alert_channels WHERE tenant_id = ? LIMIT 1`)
      .get(tenant.id) as { id: string };
    const test = await app.inject({
      method: "POST",
      url: `/alerts/${channelId.id}/test`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(test.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "alert_channel.tested" }).length,
    ).toBe(1);
    const disable = await app.inject({
      method: "POST",
      url: `/alerts/${channelId.id}/disable`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(disable.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "alert_channel.disabled" }).length,
    ).toBe(1);

    const connector = await app.inject({
      method: "POST",
      url: "/connectors/n8n",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&name=Local&baseUrl=http://127.0.0.1:5678&apiKey=test-api-key-value`,
    });
    expect(connector.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "connector.created" }).length,
    ).toBe(1);
    const connectorId = sqlite
      .prepare(`SELECT id FROM n8n_connectors WHERE tenant_id = ? LIMIT 1`)
      .get(tenant.id) as { id: string };
    const credUpdate = await app.inject({
      method: "POST",
      url: `/connectors/n8n/${connectorId.id}/credential`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&apiKey=rotated-api-key`,
    });
    expect(credUpdate.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "connector.credential_updated" })
        .length,
    ).toBe(1);
    const disableConnector = await app.inject({
      method: "POST",
      url: `/connectors/n8n/${connectorId.id}/disable`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(disableConnector.statusCode).toBe(302);
    expect(
      ops.listForTenant(tenant.id, { action: "connector.disabled" }).length,
    ).toBe(1);

    const secretLeak = ops.listForTenant(tenant.id);
    for (const row of secretLeak) {
      expect(row.detailsJson ?? "").not.toMatch(
        /test-api-key|strong-local-password|rotated-api-key/i,
      );
    }

    await app.close();
  });

  it("blocks viewer mutations and keeps ops audit immutable and tenant-scoped", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const { app, auth, cookie, csrf, tenant } = await setupAdmin(sqlite, clock);
    const ops = new SqliteOpsAuditRepositories(sqlite);

    const viewer = auth.createViewer({
      username: "viewer",
      password: "strong-viewer-password",
      now: clock.now(),
    });
    expect(viewer.ok).toBe(true);
    const viewerLogin = auth.tryLogin({
      username: "viewer",
      password: "strong-viewer-password",
      ipKey: "test",
      now: clock.now(),
    });
    expect(viewerLogin.ok).toBe(true);
    if (!viewerLogin.ok) return;

    const blocked = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: {
        cookie: `${SESSION_COOKIE}=${viewerLogin.sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(viewerLogin.csrfToken)}&name=Nope&url=https://example.com/x`,
    });
    expect(blocked.statusCode).toBe(403);
    expect(
      ops.listForTenant(tenant.id, { action: "alert_channel.created" }).length,
    ).toBe(0);

    const created = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&name=Ops&url=https://example.com/hook`,
    });
    expect(created.statusCode).toBe(302);
    const row = ops.listForTenant(tenant.id, {
      action: "alert_channel.created",
    })[0];
    expect(row).toBeTruthy();
    if (!row) {
      throw new Error("expected audit row");
    }
    expect(() =>
      sqlite
        .prepare(`UPDATE ops_audit_events SET action = 'tampered' WHERE id = ?`)
        .run(row.id),
    ).toThrow(/immutable/);
    expect(() =>
      sqlite.prepare(`DELETE FROM ops_audit_events WHERE id = ?`).run(row.id),
    ).toThrow(/immutable/);

    const otherTenantId = createId();
    const nowIso = clock.now().toISOString();
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Other', 'self_hosted', ?, ?)`,
      )
      .run(otherTenantId, nowIso, nowIso);
    ops.recordOpsAudit({
      tenantId: otherTenantId,
      action: "alert_channel.created",
      nowIso,
    });
    expect(
      ops.listForTenant(tenant.id).every((e) => e.tenantId === tenant.id),
    ).toBe(true);
    expect(
      ops
        .listForTenant(otherTenantId)
        .every((e) => e.tenantId === otherTenantId),
    ).toBe(true);

    await app.close();
  });

  it("auto-resolves heartbeat incidents via resolveIncident audit path", () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const workflowId = createId();
    const nowIso = clock.now().toISOString();
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "W",
      externalWorkflowId: "ext",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: nowIso,
    });
    const incident = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "hard_failure",
      severity: "critical",
      summary: "fail",
      observedAt: nowIso,
    });
    alerting.resolveIncident(tenant.id, incident.id, {
      actor: "system:ingest-heartbeat",
      at: nowIso,
    });
    const audit = alerting.listAuditEvents(tenant.id, incident.id);
    expect(audit.some((e) => e.eventType === "resolved")).toBe(true);
  });
});
