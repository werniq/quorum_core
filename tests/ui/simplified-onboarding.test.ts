import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { SqliteOnboardingRepositories } from "../../src/infrastructure/db/repositories/sqlite-onboarding-repositories.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { buildApp } from "../../src/infrastructure/http/app.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import { SqliteN8nConnectorRepositories } from "../../src/infrastructure/db/repositories/sqlite-n8n-connector-repositories.js";
import * as n8nClient from "../../src/infrastructure/n8n/n8n-api-client.js";
import { createIngestHeartbeatHandler } from "../../src/infrastructure/ingestion/ingest-heartbeat.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-onboard-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  const { sqlite } = openSqliteDatabase(filePath);
  openConnections.push(sqlite);
  migrateSqliteToLatest(sqlite);
  return sqlite;
}

afterEach(() => {
  vi.restoreAllMocks();
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

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw.map((c) => String(c).split(";")[0]).join("; ");
  }
  if (typeof raw === "string") {
    return raw.split(";")[0] ?? "";
  }
  return "";
}

describe("simplified onboarding", () => {
  it("redirects /protect to /onboarding for admins", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    sqlite
      .prepare(
        `INSERT INTO onboarding_state (tenant_id, step, completed_at, updated_at, draft_json)
         VALUES (?, 'catalog', ?, ?, '{}')`,
      )
      .run(tenant.id, clock.now().toISOString(), clock.now().toISOString());

    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_UI_AUTH_ENABLED: "false",
        QUORUM_CREDENTIAL_KEK: KEK,
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: [],
      }),
    });

    const response = await app.inject({ method: "GET", url: "/protect" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/onboarding");
    await app.close();
  });

  it("renders client-first onboarding without method choice or raw IDs", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    new SqliteCoreRepositories(sqlite).ensureSelfHostedTenant();

    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_UI_AUTH_ENABLED: "false",
        QUORUM_CREDENTIAL_KEK: KEK,
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: [],
      }),
    });

    const page = await app.inject({ method: "GET", url: "/onboarding" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Who are these workflows for?");
    expect(page.body).not.toContain("How should n8n report");
    expect(page.body).not.toContain("Quorum workflow ID");
    await app.close();
  });

  it("creates a client and advances to connect n8n", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();

    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_UI_AUTH_ENABLED: "false",
        QUORUM_CREDENTIAL_KEK: KEK,
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: [],
      }),
    });

    const page = await app.inject({ method: "GET", url: "/onboarding" });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
    expect(csrf).toBeTruthy();
    const cookie = cookieFrom(page);

    const posted = await app.inject({
      method: "POST",
      url: "/onboarding/client",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      payload: `csrf=${encodeURIComponent(csrf!)}&clientId=&newClientName=Acme`,
    });
    expect(posted.statusCode).toBe(302);
    expect(posted.headers.location).toBe("/onboarding");

    const onboarding = new SqliteOnboardingRepositories(sqlite);
    const state = onboarding.get(tenant.id);
    expect(state?.step).toBe("connect_n8n");
    expect(state?.draft.clientName).toBe("Acme");
    expect(core.listClients(tenant.id)).toHaveLength(1);
    await app.close();
  });

  it("discovers workflows via mocked n8n API without exposing secrets", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const client = core.createClient(tenant.id, {
      id: createId(),
      name: "Acme",
      slug: "acme",
      status: "onboarding",
      protectionStartedAt: null,
    });
    const connectors = new SqliteN8nConnectorRepositories(sqlite);
    const connector = connectors.createConnector(tenant.id, {
      name: "n8n",
      baseUrl: "http://127.0.0.1:5678",
      encryptedApiKey: encryptCredentialSecret("super-secret-key", KEK),
      nowIso: clock.now().toISOString(),
      enforcePublicUrl: false,
    });
    const onboarding = new SqliteOnboardingRepositories(sqlite);
    onboarding.setStep(
      tenant.id,
      "select_workflows",
      clock.now().toISOString(),
      {
        draft: {
          clientId: client.id,
          clientName: "Acme",
          connectorId: connector.id,
          connectionTestOk: true,
        },
      },
    );

    vi.spyOn(n8nClient, "listN8nWorkflows").mockResolvedValue({
      ok: true,
      value: [
        {
          externalWorkflowId: "wf-1",
          name: "<script>alert(1)</script>Lead sync",
          active: true,
          triggerKind: "schedule",
          inferredCadence: {
            type: "interval",
            value: "15m",
            label: "Every 15 minutes",
          },
          multipleTriggers: false,
          triggerSummary: "Every 15 minutes",
        },
      ],
    });

    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_UI_AUTH_ENABLED: "false",
        QUORUM_CREDENTIAL_KEK: KEK,
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: [],
      }),
    });

    const page = await app.inject({ method: "GET", url: "/onboarding" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Select workflows to protect");
    expect(page.body).toContain("Every 15 minutes");
    expect(page.body).not.toContain("<script>alert");
    expect(page.body).toContain("&lt;script&gt;");
    expect(page.body).not.toContain("super-secret-key");
    await app.close();
  });

  it("rejects CSRF on onboarding client post", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    new SqliteCoreRepositories(sqlite).ensureSelfHostedTenant();
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_UI_AUTH_ENABLED: "false",
        QUORUM_CREDENTIAL_KEK: KEK,
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: [],
      }),
    });
    const page = await app.inject({ method: "GET", url: "/onboarding" });
    const cookie = cookieFrom(page);
    const bad = await app.inject({
      method: "POST",
      url: "/onboarding/client",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      payload: "csrf=wrong&newClientName=Acme",
    });
    expect(bad.statusCode).toBe(403);
    await app.close();
  });

  it("accepts event-driven setup without cadence and validates outcome ranges", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const onboarding = new SqliteOnboardingRepositories(sqlite);
    onboarding.setStep(
      tenant.id,
      "configure_monitoring",
      clock.now().toISOString(),
      {
        draft: {
          selectedExternalWorkflowIds: ["event-wf"],
          workflowConfigs: {
            "event-wf": {
              externalWorkflowId: "event-wf",
              name: "Event workflow",
              activeInN8n: true,
              triggerSummary: "Webhook",
              cadenceType: "event_driven",
              cadenceValue: "event",
              timezone: "UTC",
              quietHours: 24,
              monitorMissingRuns: false,
              monitorFailures: true,
              monitorEmptyResult: false,
              monitorVolumeRange: false,
              volumeMin: null,
              volumeMax: null,
              monitoringMethod: "push",
            },
          },
        },
      },
    );
    const env = loadEnv({
      NODE_ENV: "test",
      QUORUM_UI_AUTH_ENABLED: "false",
      QUORUM_CREDENTIAL_KEK: KEK,
    });
    const readiness = () => ({
      status: "ready" as const,
      appliedMigrations: [] as string[],
    });
    const app = await buildApp({
      env,
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: readiness,
      ingestHeartbeat: createIngestHeartbeatHandler({
        sqlite,
        env,
        clock,
        getSchemaReadiness: readiness,
      }),
    });
    const page = await app.inject({ method: "GET", url: "/onboarding" });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
    const cookie = cookieFrom(page);
    const missingRange = await app.inject({
      method: "POST",
      url: "/onboarding/configure",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      payload: `csrf=${encodeURIComponent(csrf!)}&wfid__0=event-wf&cadenceType__0=event_driven&cadenceValue__0=&quietHours__0=24&failure__0=1&volume__0=1&method__0=push`,
    });
    expect(missingRange.statusCode).toBe(200);
    expect(missingRange.body).toContain(
      "Enter a minimum and/or maximum useful item count",
    );

    const valid = await app.inject({
      method: "POST",
      url: "/onboarding/configure",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      payload: `csrf=${encodeURIComponent(csrf!)}&wfid__0=event-wf&cadenceType__0=event_driven&cadenceValue__0=&quietHours__0=24&failure__0=1&empty__0=1&volume__0=1&vmin__0=1&vmax__0=100&method__0=push`,
    });
    expect(valid.statusCode).toBe(302);
    const saved = onboarding.get(tenant.id);
    expect(saved?.step).toBe("alerts_activate");
    expect(saved?.draft.workflowConfigs?.["event-wf"]?.cadenceValue).toBe(
      "event",
    );
    expect(saved?.draft.workflowConfigs?.["event-wf"]?.volumeMin).toBe(1);
    await app.close();
  });

  it("rejects outcome rules when Basic monitoring is selected", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const onboarding = new SqliteOnboardingRepositories(sqlite);
    onboarding.setStep(
      tenant.id,
      "configure_monitoring",
      clock.now().toISOString(),
      {
        draft: {
          selectedExternalWorkflowIds: ["poll-wf"],
          workflowConfigs: {
            "poll-wf": {
              externalWorkflowId: "poll-wf",
              name: "Polling workflow",
              activeInN8n: true,
              triggerSummary: "Every 15 minutes",
              cadenceType: "interval",
              cadenceValue: "15m",
              timezone: "UTC",
              quietHours: null,
              monitorMissingRuns: true,
              monitorFailures: true,
              monitorEmptyResult: false,
              monitorVolumeRange: false,
              volumeMin: null,
              volumeMax: null,
              monitoringMethod: "poll",
            },
          },
        },
      },
    );
    const env = loadEnv({
      NODE_ENV: "test",
      QUORUM_UI_AUTH_ENABLED: "false",
      QUORUM_CREDENTIAL_KEK: KEK,
    });
    const readiness = () => ({
      status: "ready" as const,
      appliedMigrations: [] as string[],
    });
    const app = await buildApp({
      env,
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: readiness,
      ingestHeartbeat: createIngestHeartbeatHandler({
        sqlite,
        env,
        clock,
        getSchemaReadiness: readiness,
      }),
    });
    const page = await app.inject({ method: "GET", url: "/onboarding" });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
    const response = await app.inject({
      method: "POST",
      url: "/onboarding/configure",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieFrom(page),
      },
      payload: `csrf=${encodeURIComponent(csrf!)}&wfid__0=poll-wf&cadenceType__0=interval&cadenceValue__0=15m&missing__0=1&failure__0=1&empty__0=1&method__0=poll`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      "Choose Outcome monitoring for “Polling workflow”",
    );
    await app.close();
  });

  it("sends a signed test heartbeat and does not redisplay the secret", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const workflowId = createId();
    const contractId = createId();
    const secret = "one-time-heartbeat-secret";
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "Outcome workflow",
      externalWorkflowId: "n8n-outcome",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: clock.now().toISOString(),
    });
    core.createWorkflowContract(tenant.id, {
      id: contractId,
      workflowId,
      name: "Outcome monitoring",
      businessPurpose: "Verify useful output",
      contractType: "heartbeat",
      cadenceType: "event_driven",
      cadenceValue: "event",
      intervalMode: null,
      scheduleAnchorAt: null,
      timezone: "UTC",
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: 1440,
      initialGraceMinutes: 5,
      emptyResultPolicy: "failure",
      countLessSuccessAllowed: false,
      notificationBackoffMinutes: 30,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: clock.now().toISOString(),
    });
    core.createCredential(tenant.id, {
      id: createId(),
      workflowId,
      keyId: "key_test",
      encryptedSecretOrVerificationMaterial: encryptCredentialSecret(
        secret,
        KEK,
      ),
      status: "active",
      rotatedFromId: null,
      revokedAt: null,
    });
    const onboarding = new SqliteOnboardingRepositories(sqlite);
    onboarding.setStep(tenant.id, "complete", clock.now().toISOString(), {
      draft: {
        selectedExternalWorkflowIds: ["n8n-outcome"],
        workflowConfigs: {
          "n8n-outcome": {
            externalWorkflowId: "n8n-outcome",
            name: "Outcome workflow",
            activeInN8n: true,
            triggerSummary: "Webhook",
            cadenceType: "event_driven",
            cadenceValue: "event",
            timezone: "UTC",
            quietHours: 24,
            monitorMissingRuns: false,
            monitorFailures: true,
            monitorEmptyResult: true,
            monitorVolumeRange: false,
            volumeMin: null,
            volumeMax: null,
            monitoringMethod: "push",
            workflowId,
            contractId,
          },
        },
      },
    });
    const heartbeatEnv = loadEnv({
      NODE_ENV: "test",
      QUORUM_UI_AUTH_ENABLED: "false",
      QUORUM_CREDENTIAL_KEK: KEK,
    });
    const heartbeatReadiness = () => ({
      status: "ready" as const,
      appliedMigrations: [] as string[],
    });
    const app = await buildApp({
      env: heartbeatEnv,
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: heartbeatReadiness,
      ingestHeartbeat: createIngestHeartbeatHandler({
        sqlite,
        env: heartbeatEnv,
        clock,
        getSchemaReadiness: heartbeatReadiness,
      }),
    });
    const page = await app.inject({ method: "GET", url: "/onboarding" });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
    const response = await app.inject({
      method: "POST",
      url: "/onboarding/heartbeat/test",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieFrom(page),
      },
      payload: `csrf=${encodeURIComponent(csrf!)}&workflowId=${encodeURIComponent(workflowId)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      "Heartbeat accepted. Outcome monitoring is active.",
    );
    expect(response.body).toContain("<strong>Heartbeat:</strong> Accepted");
    expect(response.body).not.toContain(secret);
    expect(
      onboarding
        .get(tenant.id)
        ?.draft.heartbeatAcceptedWorkflowIds?.includes(workflowId),
    ).toBe(true);
    await app.close();
  });

  it("activates Outcome monitoring with a one-time credential and daily range rule", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const existingWorkflowId = createId();
    const existingContractId = createId();
    core.createWorkflow(tenant.id, {
      id: existingWorkflowId,
      clientId: null,
      name: "New outcome workflow",
      externalWorkflowId: "n8n-outcome-new",
      description: null,
      monitoringMethod: "push",
      isActive: false,
      monitoringStartedAt: null,
    });
    core.createWorkflowContract(tenant.id, {
      id: existingContractId,
      workflowId: existingWorkflowId,
      name: "Old monitoring defaults",
      businessPurpose: "Old defaults",
      contractType: "heartbeat",
      cadenceType: "interval",
      cadenceValue: "15m",
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
      isActive: false,
      activatedAt: null,
    });
    const onboarding = new SqliteOnboardingRepositories(sqlite);
    onboarding.setStep(
      tenant.id,
      "alerts_activate",
      clock.now().toISOString(),
      {
        draft: {
          selectedExternalWorkflowIds: ["n8n-outcome-new"],
          workflowConfigs: {
            "n8n-outcome-new": {
              externalWorkflowId: "n8n-outcome-new",
              name: "New outcome workflow",
              activeInN8n: true,
              triggerSummary: "Webhook",
              cadenceType: "event_driven",
              cadenceValue: "event",
              timezone: "UTC",
              quietHours: 24,
              monitorMissingRuns: false,
              monitorFailures: true,
              monitorEmptyResult: true,
              monitorVolumeRange: true,
              volumeMin: 1,
              volumeMax: 250,
              monitoringMethod: "push",
            },
          },
        },
      },
    );
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_UI_AUTH_ENABLED: "false",
        QUORUM_CREDENTIAL_KEK: KEK,
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    const page = await app.inject({ method: "GET", url: "/onboarding" });
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
    const cookie = cookieFrom(page);
    const activated = await app.inject({
      method: "POST",
      url: "/onboarding/alerts",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      payload: `csrf=${encodeURIComponent(csrf!)}&action=activate&acknowledgedNoAlertMode=1`,
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.body).toContain("Activate Outcome monitoring");
    expect(activated.body).toContain("Quorum workflow ID:");
    expect(activated.body).toContain("HMAC secret:");
    expect(activated.body).toContain("Download Quorum Reporter");

    const workflow = core.findWorkflowByExternalId(
      tenant.id,
      "n8n-outcome-new",
    );
    expect(workflow?.isActive).toBe(true);
    const contract = sqlite
      .prepare(
        `SELECT cadence_type, cadence_value, max_quiet_window_minutes,
                empty_result_policy, count_less_success_allowed
         FROM workflow_contracts WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenant.id, existingContractId) as {
      cadence_type: string;
      cadence_value: string;
      max_quiet_window_minutes: number | null;
      empty_result_policy: string;
      count_less_success_allowed: number;
    };
    expect(contract).toEqual({
      cadence_type: "event_driven",
      cadence_value: "event",
      max_quiet_window_minutes: 1440,
      empty_result_policy: "failure",
      count_less_success_allowed: 0,
    });
    expect(
      core.getWorkflowState(tenant.id, existingWorkflowId)?.nextExpectedAt,
    ).toBe("2026-07-27T12:00:00.000Z");
    const credential = sqlite
      .prepare(
        `SELECT encrypted_secret_or_verification_material
         FROM workflow_credentials WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .get(tenant.id, workflow!.id) as {
      encrypted_secret_or_verification_material: string;
    };
    expect(credential.encrypted_secret_or_verification_material).not.toContain(
      "HMAC secret",
    );
    const volumeRule = sqlite
      .prepare(
        `SELECT minimum_count, maximum_count, window_type
         FROM contract_volume_rules WHERE tenant_id = ?`,
      )
      .get(tenant.id) as {
      minimum_count: number;
      maximum_count: number;
      window_type: string;
    };
    expect(volumeRule).toEqual({
      minimum_count: 1,
      maximum_count: 250,
      window_type: "daily",
    });

    const detail = await app.inject({
      method: "GET",
      url: `/catalog/contracts/${workflow!.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Add to n8n");
    expect(detail.body).toContain("Report result to Quorum");
    expect(detail.body).toContain("Count incoming n8n items");
    expect(detail.body).toContain("Numeric field or expression");

    const reporter = await app.inject({
      method: "GET",
      url: `/catalog/contracts/${workflow!.id}/quorum-reporter.json`,
      headers: { cookie },
    });
    expect(reporter.statusCode).toBe(200);
    expect(reporter.headers["content-disposition"]).toContain("attachment");
    const reporterJson = reporter.json() as {
      meta: { quorumReporter: Record<string, unknown> };
    };
    expect(reporterJson.meta.quorumReporter).toMatchObject({
      workflowId: workflow!.id,
      ingestPath: `/api/v1/workflows/${workflow!.id}/heartbeats`,
      outputMonitoringEnabled: true,
      secretIncluded: false,
    });
    expect(reporter.body).not.toContain("one-time-heartbeat-secret");

    const refreshed = await app.inject({
      method: "GET",
      url: "/onboarding",
      headers: { cookie },
    });
    expect(refreshed.body).not.toContain("HMAC secret:");
    expect(refreshed.body).toContain("<strong>Heartbeat:</strong> Not tested");
    await app.close();

    // Simulate the stale state produced by the older activation path. A new
    // process repairs only the contract tied to this onboarding activation.
    sqlite
      .prepare(
        `UPDATE workflow_contracts
         SET cadence_type = 'interval', cadence_value = '15m',
             max_quiet_window_minutes = NULL, empty_result_policy = 'allowed',
             count_less_success_allowed = 1
         WHERE id = ?`,
      )
      .run(existingContractId);
    sqlite
      .prepare(
        `UPDATE workflow_states SET next_expected_at = ?
         WHERE workflow_id = ?`,
      )
      .run(clock.now().toISOString(), existingWorkflowId);
    const repairedApp = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_UI_AUTH_ENABLED: "false",
        QUORUM_CREDENTIAL_KEK: KEK,
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
    });
    const repaired = sqlite
      .prepare(
        `SELECT cadence_type, max_quiet_window_minutes, empty_result_policy
         FROM workflow_contracts WHERE id = ?`,
      )
      .get(existingContractId) as {
      cadence_type: string;
      max_quiet_window_minutes: number;
      empty_result_policy: string;
    };
    expect(repaired).toEqual({
      cadence_type: "event_driven",
      max_quiet_window_minutes: 1440,
      empty_result_policy: "failure",
    });
    expect(
      core.getWorkflowState(tenant.id, existingWorkflowId)?.nextExpectedAt,
    ).toBe("2026-07-27T12:00:00.000Z");
    await repairedApp.close();
  });
});
