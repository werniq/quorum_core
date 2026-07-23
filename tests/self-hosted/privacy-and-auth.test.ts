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
import { SqliteOutboundDestinationRepositories } from "../../src/infrastructure/db/repositories/sqlite-outbound-destinations.js";
import { getTelemetryQueueLength } from "../../src/infrastructure/privacy/telemetry-queue.js";
import { SESSION_COOKIE } from "../../src/infrastructure/http/cookies.js";
import type { FastifyInstance } from "fastify";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-privacy-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  const { sqlite } = openSqliteDatabase(filePath);
  openConnections.push(sqlite);
  migrateSqliteToLatest(sqlite);
  return sqlite;
}

afterEach(async () => {
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

describe("self-hosted privacy and auth", () => {
  it("serves catalog UI without remote fonts/CDNs and keeps telemetry queue empty", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const auth = new SqliteAuthRepositories(sqlite);
    auth.registerSetupTokenFromEnv(
      "setup-token-for-privacy-tests",
      clock.now(),
    );
    auth.createAdminWithSetupToken({
      setupToken: "setup-token-for-privacy-tests",
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
    expect(login.ok).toBe(true);
    if (!login.ok) {
      return;
    }

    const declared = new Set<string>();
    const undeclared: string[] = [];
    const fetchImpl: typeof fetch = async (input, _init) => {
      const url = String(input);
      if (!declared.has(url)) {
        undeclared.push(url);
      }
      return new Response("ok", { status: 200 });
    };

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
        appliedMigrations: ["0007_self_hosted_admin"],
      }),
    });

    const catalog = await app.inject({
      method: "GET",
      url: "/catalog",
      headers: { cookie: `${SESSION_COOKIE}=${login.sessionId}` },
    });
    expect(catalog.statusCode).toBe(200);
    const html = catalog.body;
    expect(html).toContain("Contract Catalog");
    expect(html).not.toMatch(
      /fonts\.googleapis|cdn\.jsdelivr|cdnjs\.|analytics|segment\.|sentry/i,
    );
    expect(getTelemetryQueueLength()).toBe(0);

    const root = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: `${SESSION_COOKIE}=${login.sessionId}` },
    });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/catalog");

    // Network privacy page lists only configured destinations
    const outbound = new SqliteOutboundDestinationRepositories(sqlite);
    outbound.upsertDestination({
      tenantId: tenant.id,
      kind: "webhook",
      label: "Ops",
      destination: "https://hooks.example/quorum",
      nowIso: clock.now().toISOString(),
    });
    declared.add("https://hooks.example/quorum");
    const privacy = await app.inject({
      method: "GET",
      url: "/network-privacy",
      headers: { cookie: `${SESSION_COOKIE}=${login.sessionId}` },
    });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain("https://hooks.example/quorum");
    expect(privacy.body).toContain("zero telemetry");

    // Simulated connector call only to declared destination
    await fetchImpl("https://hooks.example/quorum", { method: "POST" });
    expect(undeclared).toEqual([]);

    await app.close();
  });

  it("rejects weak passwords, consumes setup token, and rate-limits login", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const auth = new SqliteAuthRepositories(sqlite);
    auth.registerSetupTokenFromEnv("setup-token-auth-suite-xx", clock.now());

    const weakShort = auth.createAdminWithSetupToken({
      setupToken: "setup-token-auth-suite-xx",
      username: "admin",
      password: "password",
      now: clock.now(),
    });
    expect(weakShort).toEqual({ ok: false, code: "weak_password" });

    const weakBlocked = auth.createAdminWithSetupToken({
      setupToken: "setup-token-auth-suite-xx",
      username: "admin",
      password: "password1234",
      now: clock.now(),
    });
    expect(weakBlocked).toEqual({ ok: false, code: "weak_password" });

    const ok = auth.createAdminWithSetupToken({
      setupToken: "setup-token-auth-suite-xx",
      username: "admin",
      password: "strong-local-password",
      now: clock.now(),
    });
    expect(ok.ok).toBe(true);

    const reuse = auth.createAdminWithSetupToken({
      setupToken: "setup-token-auth-suite-xx",
      username: "admin2",
      password: "strong-local-password",
      now: clock.now(),
    });
    expect(reuse).toEqual({ ok: false, code: "admin_exists" });

    for (let i = 0; i < 10; i += 1) {
      const attempt = auth.tryLogin({
        username: "admin",
        password: "wrong-password-xx",
        ipKey: "rate-limit-ip",
        now: clock.now(),
      });
      expect(attempt.ok).toBe(false);
    }
    const limited = auth.tryLogin({
      username: "admin",
      password: "strong-local-password",
      ipKey: "rate-limit-ip",
      now: clock.now(),
    });
    expect(limited).toEqual({ ok: false, code: "rate_limited" });
  });

  it("requires CSRF on mutating UI posts", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const auth = new SqliteAuthRepositories(sqlite);
    auth.registerSetupTokenFromEnv("setup-token-csrf-suite-xx", clock.now());
    auth.createAdminWithSetupToken({
      setupToken: "setup-token-csrf-suite-xx",
      username: "admin",
      password: "strong-local-password",
      now: clock.now(),
    });
    const login = auth.tryLogin({
      username: "admin",
      password: "strong-local-password",
      ipKey: "127.0.0.1",
      now: clock.now(),
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const app: FastifyInstance = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0007_self_hosted_admin"],
      }),
    });

    const bad = await app.inject({
      method: "POST",
      url: "/onboarding/method",
      headers: {
        cookie: `${SESSION_COOKIE}=${login.sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "method=push&csrf=wrong",
    });
    expect(bad.statusCode).toBe(403);

    const good = await app.inject({
      method: "POST",
      url: "/onboarding/method",
      headers: {
        cookie: `${SESSION_COOKIE}=${login.sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `method=push&csrf=${login.csrfToken}`,
    });
    expect(good.statusCode).toBe(302);

    await app.close();
  });

  it("opens the UI without setup or login when QUORUM_UI_AUTH_ENABLED is false", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    core.ensureSelfHostedTenant();

    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
        QUORUM_UI_AUTH_ENABLED: "false",
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0007_self_hosted_admin"],
      }),
    });

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/onboarding");
    expect(String(root.headers["set-cookie"] ?? "")).toMatch(
      /quorum_open_csrf=/,
    );

    const onboarding = await app.inject({
      method: "GET",
      url: "/onboarding",
      headers: {
        cookie: String(root.headers["set-cookie"] ?? "")
          .split(",")
          .map((p) => p.trim().split(";")[0])
          .join("; "),
      },
    });
    expect(onboarding.statusCode).toBe(200);
    expect(onboarding.body).toMatch(/onboarding|monitoring method|Choose/i);

    const setup = await app.inject({ method: "GET", url: "/setup" });
    expect(setup.statusCode).toBe(302);
    expect(setup.headers.location).toBe("/");

    const login = await app.inject({ method: "GET", url: "/login" });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe("/");

    await app.close();
  });

  it("opens the UI in demo mode on localhost and shows the insecure banner", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T10:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    core.ensureSelfHostedTenant();

    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
        QUORUM_DEMO_MODE: "true",
      }),
      clock,
      sqlite,
      enableUi: true,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0007_self_hosted_admin"],
      }),
    });

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/onboarding");

    const cookie = String(root.headers["set-cookie"] ?? "")
      .split(",")
      .map((p) => p.trim().split(";")[0])
      .join("; ");

    const onboarding = await app.inject({
      method: "GET",
      url: "/onboarding",
      headers: { cookie },
    });
    expect(onboarding.statusCode).toBe(200);
    expect(onboarding.body).toContain('role="alert"');
    expect(onboarding.body).toMatch(/Insecure demo mode/i);

    await app.close();
  });
});
