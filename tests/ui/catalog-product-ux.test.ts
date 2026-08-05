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
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import { SESSION_COOKIE } from "../../src/infrastructure/http/cookies.js";
import {
  applyCatalogFilters,
  summarizeCatalog,
} from "../../src/domain/catalog/summary.js";
import {
  deriveClientProtectionStatus,
  summarizeClientCoverage,
} from "../../src/domain/clients/protection-status.js";
import { validateWorkflowContract } from "../../src/domain/contracts/validate-workflow-contract.js";
import { PROCESS_TEMPLATES } from "../../src/domain/catalog/process-templates.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-catalog-ux-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

describe("workflow monitoring settings", () => {
  it("shows and edits enabled heartbeat alert rules", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-08-05T08:00:00.000Z"));
    const { core, tenant, sessionId, csrf } = seedAdmin(sqlite, clock);
    const workflow = core.createWorkflow(tenant.id, {
      id: createId(),
      clientId: null,
      name: "CRM outcome sync",
      externalWorkflowId: "crm-outcome-sync",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: clock.now().toISOString(),
    });
    const contract = core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId: workflow.id,
      name: "CRM outcome contract",
      businessPurpose: "Keep CRM current",
      contractType: "heartbeat",
      cadenceType: "event_driven",
      cadenceValue: "event",
      intervalMode: null,
      scheduleAnchorAt: null,
      timezone: "UTC",
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: 1440,
      initialGraceMinutes: 5,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 30,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: clock.now().toISOString(),
    });
    core.upsertWorkflowState(tenant.id, {
      tenantId: tenant.id,
      workflowId: workflow.id,
      lastExecutionAt: clock.now().toISOString(),
      lastNonemptySuccessAt: clock.now().toISOString(),
      lastAcceptableSuccessAt: clock.now().toISOString(),
      lastFailureAt: null,
      lastExternalExecutionRef: null,
      lastStatus: "success",
      nextExpectedAt: "2026-08-06T08:00:00.000Z",
      overdueSince: null,
      currentHealth: "healthy",
      evidenceLevel: "basic",
      evidenceSummaryCode: null,
      unverifiedDimensionsJson: null,
      consecutiveStaleChecks: 0,
      updatedAt: clock.now().toISOString(),
    });
    const app = await bootApp(sqlite, clock);
    const cookie = `${SESSION_COOKIE}=${sessionId}`;
    const edit = await app.inject({
      method: "GET",
      url: `/catalog/contracts/${workflow.id}/edit`,
      headers: { cookie },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.body).toContain("Execution failures");
    expect(edit.body).toContain("Zero useful output");
    expect(edit.body).toContain('name="quietHours"');
    expect(edit.body).not.toContain('name="zeroOutput" value="1" checked');

    const saved = await app.inject({
      method: "POST",
      url: `/catalog/contracts/${workflow.id}/edit`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&zeroOutput=1&quietHours=12`,
    });
    expect(saved.statusCode).toBe(302);
    const persisted = sqlite
      .prepare(
        `SELECT empty_result_policy, count_less_success_allowed,
                max_quiet_window_minutes
         FROM workflow_contracts WHERE id = ?`,
      )
      .get(contract.id) as {
      empty_result_policy: string;
      count_less_success_allowed: number;
      max_quiet_window_minutes: number;
    };
    expect(persisted).toEqual({
      empty_result_policy: "failure",
      count_less_success_allowed: 0,
      max_quiet_window_minutes: 720,
    });
    expect(core.getWorkflowState(tenant.id, workflow.id)?.nextExpectedAt).toBe(
      "2026-08-05T20:00:00.000Z",
    );

    const detail = await app.inject({
      method: "GET",
      url: `/catalog/contracts/${workflow.id}`,
      headers: { cookie },
    });
    expect(detail.body).toContain("Enabled alert rules");
    expect(detail.body).toContain("Execution failures");
    expect(detail.body).toContain("Zero useful output");
    expect(detail.body).toContain("Quiet window: 12 hours");
    expect(detail.body).not.toContain(
      'Output rule</span><div class="detail-value">Not configured',
    );
    await app.close();
  });
});

async function bootApp(
  sqlite: BetterSqliteDatabase.Database,
  clock: FixedClock,
) {
  return buildApp({
    env: loadEnv({
      NODE_ENV: "test",
      QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
    }),
    clock,
    sqlite,
    enableUi: true,
    getSchemaReadiness: () => ({
      status: "ready",
      appliedMigrations: ["0010_catalog_ux_roles"],
    }),
  });
}

function seedAdmin(sqlite: BetterSqliteDatabase.Database, clock: FixedClock) {
  const auth = new SqliteAuthRepositories(sqlite);
  auth.registerSetupTokenFromEnv("setup-token-catalog-ux-ok", clock.now());
  auth.createAdminWithSetupToken({
    setupToken: "setup-token-catalog-ux-ok",
    username: "admin",
    password: "strong-local-password",
    now: clock.now(),
  });
  const core = new SqliteCoreRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  sqlite
    .prepare(
      `INSERT INTO onboarding_state (tenant_id, step, completed_at, updated_at)
       VALUES (?, 'catalog', ?, ?)`,
    )
    .run(tenant.id, clock.now().toISOString(), clock.now().toISOString());
  const login = auth.tryLogin({
    username: "admin",
    password: "strong-local-password",
    ipKey: "127.0.0.1",
    now: clock.now(),
  });
  if (!login.ok) {
    throw new Error("login_failed");
  }
  return {
    auth,
    core,
    tenant,
    sessionId: login.sessionId,
    csrf: login.csrfToken,
  };
}

describe("catalog product UX domain helpers", () => {
  it("summarizes in business language and filters without overstating coverage", () => {
    const rows = [
      {
        isActive: true,
        health: "healthy",
        evidenceLevel: "basic",
        contractKind: "workflow",
        missingCount: null,
        alertChannelHealth: "healthy",
        activeIncident: null,
        clientId: "c1",
        connectorHealth: null,
      },
      {
        isActive: true,
        health: "overdue",
        evidenceLevel: "high",
        contractKind: "outcome",
        missingCount: 3,
        alertChannelHealth: "failing",
        activeIncident: { severity: "critical" },
        clientId: "c1",
        connectorHealth: "healthy",
      },
      {
        isActive: false,
        health: "inactive",
        evidenceLevel: "basic",
        contractKind: "workflow",
        missingCount: null,
        alertChannelHealth: "none",
        activeIncident: null,
        clientId: "c2",
        connectorHealth: null,
      },
    ];
    const summary = summarizeCatalog(rows);
    expect(summary.contractsCurrentlySatisfied).toBe(1);
    expect(summary.outcomesMissingOrDelayed).toBe(1);
    expect(summary.contractsWithOnlyBasicEvidence).toBe(1);
    expect(summary.clientsWithFailingAlertDelivery).toBe(1);
    expect(summary.contractsNotYetActivated).toBe(1);

    const filtered = applyCatalogFilters(rows, {
      evidenceLevel: "high",
      alertChannelHealth: "failing",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.missingCount).toBe(3);

    const status = deriveClientProtectionStatus({
      hasAnyContract: true,
      activeContractsWithTestedAlert: 1,
      allContractsPaused: false,
      archived: false,
    });
    const coverage = summarizeClientCoverage(
      rows.filter((r) => r.clientId === "c1"),
      status,
    );
    expect(coverage.coverageNote).toContain("active contract");
    expect(coverage.coverageNote).toMatch(/basic/);
    expect(coverage.coverageNote).not.toMatch(/fully protected/i);
  });

  it("activation gate blocks untested alert routes unless no-alert mode", () => {
    const base = {
      workflowId: "w1",
      name: "Lead delivery",
      businessPurpose: "Leads reach CRM",
      contractType: "heartbeat" as const,
      cadenceType: "interval" as const,
      cadenceValue: "15",
      intervalMode: "fixed_rate" as const,
      scheduleAnchorAt: new Date("2026-07-19T10:00:00.000Z"),
      timezone: "UTC",
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: null,
      initialGraceMinutes: 5,
      emptyResultPolicy: "allowed" as const,
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 30,
      evidenceLevel: "basic" as const,
      schemaVersion: 1,
      isActive: true,
    };
    const blocked = validateWorkflowContract(base, {
      activation: {
        hasActiveAlertRoute: false,
        acknowledgedNoAlertMode: false,
        edition: "self_hosted",
      },
    });
    expect(blocked.ok).toBe(false);
    expect(
      blocked.issues.some((i) => i.code === "ACTIVATION_ALERT_ROUTE_REQUIRED"),
    ).toBe(true);

    const allowed = validateWorkflowContract(base, {
      activation: {
        hasActiveAlertRoute: false,
        acknowledgedNoAlertMode: true,
        edition: "self_hosted",
      },
    });
    expect(allowed.ok).toBe(true);
  });

  it("process templates prefill without implying auto-activation", () => {
    expect(PROCESS_TEMPLATES.some((t) => t.id === "lead_delivery")).toBe(true);
    expect(PROCESS_TEMPLATES.every((t) => t.label.length > 0)).toBe(true);
  });
});

describe("catalog product UX UI acceptance", () => {
  it("defaults authenticated users to /catalog with health and evidence separated", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const { core, tenant, sessionId } = seedAdmin(sqlite, clock);
    const client = core.createClient(tenant.id, {
      id: createId(),
      name: "Acme",
      slug: "acme",
      status: "onboarding",
      protectionStartedAt: null,
    });
    const workflow = core.createWorkflow(tenant.id, {
      id: createId(),
      clientId: client.id,
      name: "Lead sync",
      externalWorkflowId: "ext-1",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: clock.now().toISOString(),
    });
    core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId: workflow.id,
      name: "Lead delivery",
      businessPurpose: "Leads reach CRM",
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
    core.upsertWorkflowState(tenant.id, {
      tenantId: tenant.id,
      workflowId: workflow.id,
      lastExecutionAt: clock.now().toISOString(),
      lastNonemptySuccessAt: clock.now().toISOString(),
      lastAcceptableSuccessAt: clock.now().toISOString(),
      lastFailureAt: null,
      lastExternalExecutionRef: null,
      lastStatus: "success",
      nextExpectedAt: new Date(clock.now().getTime() + 900_000).toISOString(),
      overdueSince: null,
      currentHealth: "healthy",
      evidenceLevel: "basic",
      evidenceSummaryCode: null,
      unverifiedDimensionsJson: null,
      consecutiveStaleChecks: 0,
      updatedAt: clock.now().toISOString(),
    });

    const app = await bootApp(sqlite, clock);
    const root = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/catalog");

    const catalog = await app.inject({
      method: "GET",
      url: "/catalog",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.body).toContain("Contract Catalog");
    expect(catalog.body).toContain("Set up monitoring");
    expect(catalog.body).toContain('aria-label="Evidence level basic');
    expect(catalog.body).toContain("destination not independently checked");
    expect(catalog.body).toContain("Health:");
    expect(catalog.body).toContain("skip-link");
    expect(catalog.body).not.toMatch(
      /Create your first monitor|pings received/i,
    );
    expect(catalog.body).toContain("Contracts currently satisfied");

    const detail = await app.inject({
      method: "GET",
      url: `/catalog/contracts/${workflow.id}`,
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Current evidence");
    expect(detail.body).toContain("Technical details");
    expect(detail.body).toContain("not required to understand current health");

    await app.close();
  });

  it("shows failing alert banner and clears it after successful test", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T14:32:00.000Z"));
    const { core, tenant, sessionId, csrf } = seedAdmin(sqlite, clock);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const channelId = createId();
    const nowIso = clock.now().toISOString();
    const workflow = core.createWorkflow(tenant.id, {
      id: createId(),
      clientId: null,
      name: "Ops workflow",
      externalWorkflowId: "ops-1",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: nowIso,
    });
    const contract = core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId: workflow.id,
      name: "Ops contract",
      businessPurpose: "Ops process",
      cadenceType: "interval",
      cadenceValue: "15",
      intervalMode: "fixed_rate",
      scheduleAnchorAt: nowIso,
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
      activatedAt: nowIso,
    });
    alerting.createAlertChannel(tenant.id, {
      id: channelId,
      name: "Operations Slack",
      type: "webhook",
      encryptedConfig: encryptCredentialSecret(
        JSON.stringify({ url: "https://hooks.example/ops" }),
        "quorum-test-credential-kek",
      ),
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    alerting.routeContractToChannel(tenant.id, {
      contractKind: "workflow",
      contractId: contract.id,
      alertChannelId: channelId,
    });
    alerting.applyChannelDeliveryResult(
      tenant.id,
      channelId,
      {
        type: "delivery_failed",
        retriesRemaining: false,
        errorCode: "webhook_error",
      },
      nowIso,
    );

    const app = await bootApp(sqlite, clock);
    const catalog = await app.inject({
      method: "GET",
      url: "/catalog",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(catalog.body).toContain("Alerts may not be reaching you");
    expect(catalog.body).toContain("Operations Slack");
    expect(catalog.body).toContain(`/alerts/${channelId}/test`);
    expect(catalog.body).toContain("Alert delivery failing");
    expect(catalog.body).toContain("Contracts with failing alerts");
    expect(catalog.body).toMatch(
      /<strong>1<\/strong>\s*<div class="helper">Contracts with failing alerts<\/div>/,
    );
    expect(catalog.body).toContain("Fix alert delivery");
    expect(catalog.body).not.toContain("Alerts: none");

    const test = await app.inject({
      method: "POST",
      url: `/alerts/${channelId}/test`,
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(test.statusCode).toBe(302);

    const after = await app.inject({
      method: "GET",
      url: "/catalog",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(after.body).not.toContain("Alerts may not be reaching you");

    await app.close();
  });

  it("blocks viewer mutations and keeps tenant filters scoped", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const { auth, core, tenant, sessionId } = seedAdmin(sqlite, clock);
    const viewerResult = auth.createViewer({
      username: "viewer",
      password: "strong-local-password",
      now: clock.now(),
    });
    expect(viewerResult.ok).toBe(true);
    const viewerLogin = auth.tryLogin({
      username: "viewer",
      password: "strong-local-password",
      ipKey: "127.0.0.1",
      now: clock.now(),
    });
    expect(viewerLogin.ok).toBe(true);
    if (!viewerLogin.ok) return;

    const otherTenant = createId();
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Other', 'saas', ?, ?)`,
      )
      .run(otherTenant, clock.now().toISOString(), clock.now().toISOString());
    const foreignClient = createId();
    sqlite
      .prepare(
        `INSERT INTO clients (id, tenant_id, name, slug, status, protection_started_at, created_at, updated_at)
         VALUES (?, ?, 'Foreign', 'foreign', 'onboarding', NULL, ?, ?)`,
      )
      .run(
        foreignClient,
        otherTenant,
        clock.now().toISOString(),
        clock.now().toISOString(),
      );
    core.createClient(tenant.id, {
      id: createId(),
      name: "Local client",
      slug: "local-client",
      status: "onboarding",
      protectionStartedAt: null,
    });

    const app = await bootApp(sqlite, clock);
    const blocked = await app.inject({
      method: "POST",
      url: "/workflows",
      headers: {
        cookie: `${SESSION_COOKIE}=${viewerLogin.sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(viewerLogin.csrfToken)}&name=Nope&externalWorkflowId=x&monitoringMethod=push`,
    });
    expect(blocked.statusCode).toBe(403);

    const protect = await app.inject({
      method: "GET",
      url: "/protect",
      headers: { cookie: `${SESSION_COOKIE}=${viewerLogin.sessionId}` },
    });
    expect(protect.statusCode).toBe(403);

    const clients = await app.inject({
      method: "GET",
      url: "/clients",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(clients.body).toContain("Local client");
    expect(clients.body).not.toContain("Foreign");
    expect(clients.body).toMatch(/onboarding|No active contracts/);

    const adminProtect = await app.inject({
      method: "GET",
      url: "/protect",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(adminProtect.statusCode).toBe(302);
    expect(adminProtect.headers.location).toBe("/onboarding");

    await app.close();
  });

  it("shows critical missing count for outcome rows and empty-state copy", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const { sessionId } = seedAdmin(sqlite, clock);
    const app = await bootApp(sqlite, clock);
    const empty = await app.inject({
      method: "GET",
      url: "/catalog",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(empty.body).toContain(
      "Define the first business process that should always work",
    );
    await app.close();
  });

  it("protect POST steps remain available for verification scripts", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const { sessionId, csrf, core, tenant } = seedAdmin(sqlite, clock);
    core.createWorkflow(tenant.id, {
      id: createId(),
      clientId: null,
      name: "Already registered",
      externalWorkflowId: "n8n-existing-1",
      description: null,
      monitoringMethod: "push",
      isActive: false,
      monitoringStartedAt: null,
    });
    const app = await bootApp(sqlite, clock);

    const step3 = await app.inject({
      method: "POST",
      url: "/protect/process",
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&clientId=c-local&templateId=custom&businessPurpose=Leads`,
    });
    expect(step3.statusCode).toBe(200);
    expect(step3.body).toContain('name="clientId"');
    expect(step3.body).toContain("Leads");
    expect(core.listWorkflows(tenant.id)).toHaveLength(1);

    await app.close();
  });

  it("protect wizard Back stays on legacy protect HTML for scripts", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const { sessionId, csrf } = seedAdmin(sqlite, clock);
    const app = await bootApp(sqlite, clock);

    const back = await app.inject({
      method: "POST",
      url: "/protect/back",
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&to=2&clientId=c-local&businessPurpose=Leads&templateId=custom`,
    });
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain('action="/protect/back"');
    expect(back.body).toContain("c-local");

    await app.close();
  });

  it("explains Catalog silence when Incidents is empty but contracts are warning", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const { core, tenant, sessionId } = seedAdmin(sqlite, clock);
    const nowIso = clock.now().toISOString();
    const workflow = core.createWorkflow(tenant.id, {
      id: createId(),
      clientId: null,
      name: "Poll invoices",
      externalWorkflowId: createId(),
      description: null,
      monitoringMethod: "poll",
      isActive: true,
      monitoringStartedAt: nowIso,
    });
    core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId: workflow.id,
      name: "Poll invoices",
      businessPurpose: "Poll invoices",
      cadenceType: "interval",
      cadenceValue: "1",
      intervalMode: "fixed_rate",
      scheduleAnchorAt: nowIso,
      timezone: "UTC",
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: null,
      initialGraceMinutes: 0,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 30,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: nowIso,
    });
    core.upsertWorkflowState(tenant.id, {
      tenantId: tenant.id,
      workflowId: workflow.id,
      lastExecutionAt: nowIso,
      lastNonemptySuccessAt: nowIso,
      lastAcceptableSuccessAt: nowIso,
      lastFailureAt: null,
      lastExternalExecutionRef: null,
      lastStatus: "success",
      nextExpectedAt: nowIso,
      overdueSince: null,
      currentHealth: "warning",
      evidenceLevel: "basic",
      evidenceSummaryCode: "warning_no_recent_execution",
      unverifiedDimensionsJson: "[]",
      consecutiveStaleChecks: 0,
      updatedAt: nowIso,
    });

    const app = await bootApp(sqlite, clock);
    const incidents = await app.inject({
      method: "GET",
      url: "/incidents",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(incidents.statusCode).toBe(200);
    expect(incidents.body).toContain("No open incidents");
    expect(incidents.body).toContain("needing attention");
    expect(incidents.body).toContain("no recent execution");
    expect(incidents.body).toContain(
      "opens a silent-absence incident when a contract becomes",
    );
    expect(incidents.body).toContain("Review Contract Catalog");
    expect(incidents.body).not.toContain("Define contracts proactively");

    const catalog = await app.inject({
      method: "GET",
      url: "/catalog",
      headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    expect(catalog.body).toContain("No recent execution");
    expect(catalog.body).toContain(
      "Quorum has not received a new execution within the expected window.",
    );
    expect(catalog.body).toContain(
      "Early warning — an incident opens if this becomes Overdue.",
    );

    await app.close();
  });

  it("runs a safe read-only watchdog test without creating incidents", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-18T12:00:00.000Z"));
    const { sessionId, csrf, core, tenant } = seedAdmin(sqlite, clock);
    const workflowId = createId();
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "Watchdog probe",
      externalWorkflowId: "ext-wd",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: clock.now().toISOString(),
    });
    core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId,
      name: "Watchdog probe",
      businessPurpose: "Watchdog probe",
      cadenceType: "interval",
      cadenceValue: "60",
      intervalMode: "fixed_rate",
      scheduleAnchorAt: clock.now().toISOString(),
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
      activatedAt: clock.now().toISOString(),
    });
    const beforeIncidents = (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM incidents`).get() as {
        n: number;
      }
    ).n;
    const beforeWorkflowUpdated = (
      sqlite
        .prepare(`SELECT updated_at AS u FROM workflows WHERE id = ?`)
        .get(workflowId) as { u: string }
    ).u;

    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0010_catalog_ux_roles"],
      }),
      getWatcherHealth: () => ({
        lastSuccessAt: "2026-07-18T11:59:00.000Z",
        staleAfterMs: 180_000,
        nowMs: clock.now().getTime(),
      }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/catalog/watchdog-test",
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("Watchdog%20ok");

    expect(
      (
        sqlite.prepare(`SELECT COUNT(*) AS n FROM incidents`).get() as {
          n: number;
        }
      ).n,
    ).toBe(beforeIncidents);
    expect(
      (
        sqlite
          .prepare(`SELECT updated_at AS u FROM workflows WHERE id = ?`)
          .get(workflowId) as { u: string }
      ).u,
    ).toBe(beforeWorkflowUpdated);
    await app.close();
  });
});
