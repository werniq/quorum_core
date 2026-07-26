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
});
