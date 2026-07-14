import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { backupSqliteDatabase } from "../../src/infrastructure/db/sqlite-backup.js";
import { buildApp } from "../../src/infrastructure/http/app.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { SqliteAlertingRepositories } from "../../src/infrastructure/db/repositories/sqlite-alerting-repositories.js";
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import {
  assertKekCanDecrypt,
  decryptCredentialSecretWithFallback,
  reencryptCredentialSecret,
  sealBackupVerificationBlob,
} from "../../src/infrastructure/security/kek-rotation.js";
import {
  assertSafeMetricLabels,
  localMetrics,
} from "../../src/infrastructure/observability/metrics.js";
import {
  redactSensitiveText,
  sanitizeLogFields,
} from "../../src/infrastructure/observability/logging.js";
import { validateHostedPollBaseUrl } from "../../src/domain/connectors/poll-base-url.js";
import { assertPublicHttpsUrl } from "../../src/infrastructure/security/secure-outbound-http.js";
import { SESSION_COOKIE } from "../../src/infrastructure/http/cookies.js";
import { SqliteAuthRepositories } from "../../src/infrastructure/db/repositories/sqlite-auth-repositories.js";
import { SqliteOpsAuditRepositories } from "../../src/infrastructure/db/repositories/sqlite-ops-audit-repositories.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-ops-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  const { sqlite } = openSqliteDatabase(filePath);
  openConnections.push(sqlite);
  migrateSqliteToLatest(sqlite);
  return sqlite;
}

afterEach(() => {
  localMetrics.resetForTests();
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

describe("observability and production security", () => {
  it("redacts secrets from structured log fields and free text", () => {
    expect(
      redactSensitiveText("Authorization: Bearer super-secret-token-value"),
    ).toContain("[redacted]");
    expect(
      sanitizeLogFields({
        requestId: "req-1",
        tenantId: "t1",
        password: "nope",
        event: "contract.activated",
      }),
    ).toEqual({
      requestId: "req-1",
      tenantId: "t1",
      event: "contract.activated",
    });
  });

  it("rejects unsafe metric labels", () => {
    expect(() => assertSafeMetricLabels({ secret: "x" })).toThrow(
      /unsafe_metric_label/,
    );
    localMetrics.inc("quorum_test_counter", { health: "failing" });
    expect(localMetrics.toPrometheusText()).toContain("quorum_test_counter");
    expect(localMetrics.toPrometheusText()).not.toMatch(/password|Bearer/i);
  });

  it("keeps /metrics disabled by default and requires auth or loopback when enabled", async () => {
    const sqlite = openDb();
    const disabled = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
      }),
      clock: new FixedClock(new Date("2026-07-19T12:00:00.000Z")),
      sqlite,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0012_audit_immutability_ops"],
      }),
    });
    expect(
      (await disabled.inject({ method: "GET", url: "/metrics" })).statusCode,
    ).toBe(404);
    await disabled.close();

    const enabled = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
        METRICS_ENABLED: "true",
        METRICS_AUTH_TOKEN: "metrics-test-token",
      }),
      clock: new FixedClock(new Date("2026-07-19T12:00:00.000Z")),
      sqlite,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0012_audit_immutability_ops"],
      }),
    });
    expect(
      (await enabled.inject({ method: "GET", url: "/metrics" })).statusCode,
    ).toBe(401);
    const metrics = await enabled.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer metrics-test-token" },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-security-policy"]).toMatch(
      /default-src 'self'/,
    );
    expect(metrics.headers["x-frame-options"]).toBe("DENY");
    expect(metrics.body).toContain("quorum_info");
    expect(metrics.body).not.toMatch(/api[_-]?key|password|Bearer/i);

    const json = await enabled.inject({
      method: "GET",
      url: "/metrics.json",
      headers: { authorization: "Bearer metrics-test-token" },
    });
    expect(json.json()).toMatchObject({
      transmittedByDefault: false,
      authRequired: true,
    });
    await enabled.close();
  });

  it("keeps audit events immutable", () => {
    const sqlite = openDb();
    const opsAudit = new SqliteOpsAuditRepositories(sqlite);
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const nowIso = new Date().toISOString();
    opsAudit.recordOpsAudit({
      tenantId: tenant.id,
      action: "contract.activated",
      nowIso,
    });
    const row = sqlite
      .prepare(`SELECT id FROM ops_audit_events WHERE tenant_id = ? LIMIT 1`)
      .get(tenant.id) as { id: string };
    expect(() =>
      sqlite
        .prepare(`UPDATE ops_audit_events SET action = 'tampered' WHERE id = ?`)
        .run(row.id),
    ).toThrow(/immutable/);
    expect(() =>
      sqlite.prepare(`DELETE FROM ops_audit_events WHERE id = ?`).run(row.id),
    ).toThrow(/immutable/);
  });

  it("rotates KEK and detects missing key after restore", () => {
    const oldKek = "old-quorum-credential-kek";
    const newKek = "new-quorum-credential-kek";
    const sealed = encryptCredentialSecret("workflow-hmac-secret", oldKek);
    const rotated = reencryptCredentialSecret(sealed, oldKek, newKek);
    expect(decryptCredentialSecretWithFallback(rotated, newKek)).toBe(
      "workflow-hmac-secret",
    );
    expect(decryptCredentialSecretWithFallback(sealed, newKek, oldKek)).toBe(
      "workflow-hmac-secret",
    );
    expect(assertKekCanDecrypt(rotated, "")).toEqual({
      ok: false,
      code: "missing_key",
    });
    expect(assertKekCanDecrypt(rotated, "wrong-key")).toEqual({
      ok: false,
      code: "decrypt_failed",
    });
    expect(
      assertKekCanDecrypt(sealBackupVerificationBlob(newKek), newKek).ok,
    ).toBe(true);
  });

  it("backs up SQLite and restores on a clean database with schema upgrade path", async () => {
    const sourcePath = path.join(os.tmpdir(), `quorum-src-${Date.now()}.db`);
    const backupPath = path.join(os.tmpdir(), `quorum-bak-${Date.now()}.db`);
    tempFiles.push(sourcePath, backupPath);
    const { sqlite } = openSqliteDatabase(sourcePath);
    openConnections.push(sqlite);
    migrateSqliteToLatest(sqlite);
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant("Backup Agency");
    await backupSqliteDatabase(sqlite, backupPath);
    sqlite.close();
    openConnections.pop();

    const restored = openSqliteDatabase(backupPath);
    openConnections.push(restored.sqlite);
    migrateSqliteToLatest(restored.sqlite);
    const name = restored.sqlite
      .prepare(`SELECT name FROM tenants WHERE id = ?`)
      .get(tenant.id) as { name: string };
    expect(name.name).toBe("Backup Agency");
  });

  it("shows alert attempt timeline and restores channel health after test", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const auth = new SqliteAuthRepositories(sqlite);
    auth.registerSetupTokenFromEnv("setup-ops-token-1234567890ab", clock.now());
    auth.createAdminWithSetupToken({
      setupToken: "setup-ops-token-1234567890ab",
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
    if (!login.ok) return;

    const alerting = new SqliteAlertingRepositories(sqlite);
    const channelId = createId();
    const nowIso = clock.now().toISOString();
    alerting.createAlertChannel(tenant.id, {
      id: channelId,
      name: "Ops webhook",
      type: "webhook",
      encryptedConfig: encryptCredentialSecret(
        JSON.stringify({ url: "https://hooks.example/ops" }),
        "quorum-test-credential-kek",
      ),
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    alerting.applyChannelDeliveryResult(
      tenant.id,
      channelId,
      {
        type: "delivery_failed",
        retriesRemaining: false,
        errorCode: "webhook_error",
        errorMessage: "timeout Authorization: Bearer leak",
      },
      nowIso,
    );
    const outboxId = createId();
    alerting.enqueueOutbox(tenant.id, {
      id: outboxId,
      incidentId: null,
      eventType: "channel_test",
      payloadJson: JSON.stringify({ alertChannelId: channelId }),
      availableAt: nowIso,
    });
    alerting.recordNotificationAttempt(tenant.id, {
      id: createId(),
      incidentId: null,
      alertChannelId: channelId,
      outboxId,
      status: "failed",
      attemptedAt: nowIso,
      deliveredAt: null,
      externalMessageId: null,
      externalThreadId: null,
      responseStatusCode: 500,
      errorCode: "webhook_error",
      errorMessageSanitized: "timeout [redacted]",
    });

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
        appliedMigrations: ["0012_audit_immutability_ops"],
      }),
    });

    const detail = await app.inject({
      method: "GET",
      url: `/alerts/${channelId}`,
      headers: { cookie: `${SESSION_COOKIE}=${login.sessionId}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Attempt timeline");
    expect(detail.body).toContain("webhook_error");
    expect(detail.body).not.toContain("Bearer leak");
    expect(detail.body).toContain("Send test");

    await app.close();
  });

  it("includes SSRF and tenant isolation in security regression suite", () => {
    expect(
      validateHostedPollBaseUrl("https://127.0.0.1", assertPublicHttpsUrl).ok,
    ).toBe(false);
    expect(
      validateHostedPollBaseUrl("https://n8n.example.com", assertPublicHttpsUrl)
        .ok,
    ).toBe(true);

    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const a = core.ensureSelfHostedTenant();
    const other = createId();
    const nowIso = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Other', 'saas', ?, ?)`,
      )
      .run(other, nowIso, nowIso);
    expect(core.getClient(other, "missing")).toBeNull();
    expect(core.listClients(a.id)).toEqual([]);
  });
});
