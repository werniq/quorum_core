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
import { SqliteAuthRepositories } from "../../src/infrastructure/db/repositories/sqlite-auth-repositories.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { SESSION_COOKIE } from "../../src/infrastructure/http/cookies.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-n8n-poll-onboard-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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
  auth.registerSetupTokenFromEnv(
    "setup-token-n8n-poll-onboard-ok",
    clock.now(),
  );
  auth.createAdminWithSetupToken({
    setupToken: "setup-token-n8n-poll-onboard-ok",
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
    tenant,
    sessionId: login.sessionId,
    csrf: login.csrfToken,
  };
}

describe("n8n poll onboarding UI", () => {
  it("creates connector, poll workflow, and binds connector_id via UI", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const { tenant, sessionId, csrf } = seedAdmin(sqlite, clock);
    const app = await bootApp(sqlite, clock);
    const cookie = `${SESSION_COOKIE}=${sessionId}`;

    const createConnector = await app.inject({
      method: "POST",
      url: "/connectors/n8n",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&name=Local+n8n&baseUrl=${encodeURIComponent("http://127.0.0.1:5678")}&apiKey=test-api-key`,
    });
    expect(createConnector.statusCode).toBe(302);
    expect(createConnector.headers.location).toBe("/connectors");

    const connector = sqlite
      .prepare(
        `SELECT id, name, status FROM n8n_connectors WHERE tenant_id = ? LIMIT 1`,
      )
      .get(tenant.id) as { id: string; name: string; status: string };
    expect(connector.name).toBe("Local n8n");
    expect(connector.status).toBe("active");

    const createWorkflow = await app.inject({
      method: "POST",
      url: "/workflows",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&name=Poll+WF&externalWorkflowId=ext-wf-1&monitoringMethod=poll`,
    });
    expect(createWorkflow.statusCode).toBe(302);
    expect(createWorkflow.headers.location).toBe("/workflows?registered=1");

    const workflow = sqlite
      .prepare(
        `SELECT id, monitoring_method, connector_id FROM workflows WHERE tenant_id = ? LIMIT 1`,
      )
      .get(tenant.id) as {
      id: string;
      monitoring_method: string;
      connector_id: string | null;
    };
    expect(workflow.monitoring_method).toBe("poll");
    expect(workflow.connector_id).toBeNull();

    const bind = await app.inject({
      method: "POST",
      url: `/workflows/${workflow.id}/connector`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&connectorId=${encodeURIComponent(connector.id)}`,
    });
    expect(bind.statusCode).toBe(302);
    expect(bind.headers.location).toBe("/workflows");

    const bound = sqlite
      .prepare(
        `SELECT connector_id FROM workflows WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenant.id, workflow.id) as { connector_id: string | null };
    expect(bound.connector_id).toBe(connector.id);

    const workflowsPage = await app.inject({
      method: "GET",
      url: "/workflows",
      headers: { cookie },
    });
    expect(workflowsPage.statusCode).toBe(200);
    expect(workflowsPage.body).toContain("Bind connector");
    expect(workflowsPage.body).toContain(connector.id);

    const connectorsPage = await app.inject({
      method: "GET",
      url: "/connectors",
      headers: { cookie },
    });
    expect(connectorsPage.statusCode).toBe(200);
    expect(connectorsPage.body).toContain("Add n8n connector");
    expect(connectorsPage.body).toContain("Local n8n");
    expect(connectorsPage.body).toContain(
      `/connectors/n8n/${connector.id}/test`,
    );
    expect(connectorsPage.body).toContain(
      `/connectors/n8n/${connector.id}/disable`,
    );

    const missingBind = await app.inject({
      method: "POST",
      url: "/workflows/does-not-exist/connector",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(csrf)}&connectorId=${encodeURIComponent(connector.id)}`,
    });
    expect(missingBind.statusCode).toBe(404);
  });
});
