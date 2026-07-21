import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import {
  isUniqueConstraintError,
  validateWorkflowRegistrationInput,
  workflowRegistrationErrorMessage,
} from "../../src/infrastructure/http/ui-form-errors.js";

describe("workflow registration form errors", () => {
  it("validates required fields", () => {
    expect(
      validateWorkflowRegistrationInput({ name: "", externalWorkflowId: "x" }),
    ).toMatch(/name/i);
    expect(
      validateWorkflowRegistrationInput({
        name: "Lead sync",
        externalWorkflowId: "  ",
      }),
    ).toMatch(/n8n workflow ID/i);
    expect(
      validateWorkflowRegistrationInput({
        name: "Lead sync",
        externalWorkflowId: "abc",
      }),
    ).toBeNull();
  });

  it("maps sqlite unique errors to readable copy", () => {
    const error = Object.assign(
      new Error(
        "UNIQUE constraint failed: workflows.tenant_id, workflows.source_platform, workflows.external_workflow_id",
      ),
      {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      },
    );
    expect(isUniqueConstraintError(error)).toBe(true);
    expect(workflowRegistrationErrorMessage(error)).toMatch(
      /already registered/i,
    );
  });
});

describe("workflow registration UI", () => {
  it("shows a friendly duplicate error instead of a raw 500", async () => {
    const filePath = path.join(os.tmpdir(), `quorum-wf-dup-${Date.now()}.db`);
    const { sqlite } = openSqliteDatabase(filePath);
    migrateSqliteToLatest(sqlite);
    const clock = new FixedClock(new Date("2026-07-20T12:00:00.000Z"));
    const auth = new SqliteAuthRepositories(sqlite);
    auth.registerSetupTokenFromEnv("setup-token-wf-dup-ok-12345", clock.now());
    const created = auth.createAdminWithSetupToken({
      setupToken: "setup-token-wf-dup-ok-12345",
      username: "admin",
      password: "strong-local-password",
      now: clock.now(),
    });
    if (!created.ok) {
      throw new Error(`admin_create_failed:${created.code}`);
    }
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
    if (!login.ok) throw new Error("login failed");

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
        appliedMigrations: [],
      }),
    });

    const first = await app.inject({
      method: "POST",
      url: "/workflows",
      headers: {
        cookie: `${SESSION_COOKIE}=${login.sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(login.csrfToken)}&name=Lead+sync&externalWorkflowId=n8n-abc&monitoringMethod=push`,
    });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe("/workflows?registered=1");

    const second = await app.inject({
      method: "POST",
      url: "/workflows",
      headers: {
        cookie: `${SESSION_COOKIE}=${login.sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrf=${encodeURIComponent(login.csrfToken)}&name=Lead+sync+2&externalWorkflowId=n8n-abc&monitoringMethod=push`,
    });
    expect(second.statusCode).toBe(400);
    expect(second.headers["content-type"]).toMatch(/text\/html/);
    expect(second.body).toContain("already registered");
    expect(second.body).toContain("n8n-abc");
    expect(second.body).not.toContain("SQLITE_CONSTRAINT");
    expect(second.body).not.toContain('"statusCode":500');

    await app.close();
    sqlite.close();
    fs.unlinkSync(filePath);
  });
});
