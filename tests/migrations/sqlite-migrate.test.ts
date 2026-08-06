import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  evaluateSqliteReadiness,
  getAppliedSqliteMigrationTags,
  getSqliteMigrationFailure,
  migrateSqliteToLatest,
  migrateSqliteUpTo,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import {
  listMigrationTags,
  readMigrationSql,
} from "../../src/infrastructure/db/migrations.js";
import { createId } from "../../src/domain/ids.js";
import {
  assertApplicationReady,
  startIngestion,
  startOutboxProcessing,
  startWatcher,
} from "../../src/application/processors.js";
import { SchemaNotReadyError } from "../../src/application/schema-readiness.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function tempDbPath(): string {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-sqlite-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  return filePath;
}

function openTempSqlite(): BetterSqliteDatabase.Database {
  const { sqlite } = openSqliteDatabase(tempDbPath());
  openConnections.push(sqlite);
  return sqlite;
}

afterEach(() => {
  while (openConnections.length > 0) {
    const sqlite = openConnections.pop();
    try {
      sqlite?.close();
    } catch {
      // already closed in test body
    }
  }
  for (const filePath of tempFiles.splice(0, tempFiles.length)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const candidate = `${filePath}${suffix}`;
      try {
        if (fs.existsSync(candidate)) {
          fs.unlinkSync(candidate);
        }
      } catch {
        // best-effort cleanup on Windows file locks
      }
    }
  }
});

describe("SQLite migrations", () => {
  it("migrates an empty SQLite database to latest", () => {
    const sqlite = openTempSqlite();
    migrateSqliteToLatest(sqlite);

    const tags = getAppliedSqliteMigrationTags(sqlite);
    expect(tags).toEqual(listMigrationTags("sqlite"));

    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "tenants",
        "clients",
        "workflows",
        "workflow_contracts",
        "workflow_credentials",
        "ingestion_rate_limit_states",
        "heartbeat_events",
        "workflow_states",
        "incidents",
        "alert_channels",
        "contract_alert_channels",
        "alert_channel_states",
        "notification_outbox",
        "notification_attempts",
        "n8n_connectors",
        "n8n_poll_checkpoints",
        "n8n_poll_claims",
        "watcher_run_state",
        "watcher_contract_claims",
        "incident_audit_events",
        "admin_users",
        "admin_sessions",
        "setup_tokens",
        "outbound_destinations",
        "onboarding_state",
        "login_rate_limits",
        "connectors",
        "outcome_contracts",
        "reconciliation_runs",
        "reconciliation_items",
        "reconciliation_audit_events",
        "reconciliation_export_tokens",
        "ops_audit_events",
        "contract_volume_rules",
        "volume_band_evaluations",
        "volume_evaluation_claims",
      ]),
    );

    const readiness = evaluateSqliteReadiness(sqlite);
    expect(readiness.status).toBe("ready");

    const adminCols = sqlite
      .prepare(`PRAGMA table_info(admin_users)`)
      .all() as Array<{ name: string }>;
    expect(adminCols.map((c) => c.name)).toContain("role");

    const itemsSql = (
      sqlite
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reconciliation_items'`,
        )
        .get() as { sql: string }
    ).sql;
    expect(itemsSql).toContain("'waiting'");
    expect(itemsSql).toContain("'ignored'");
  });

  it("migrates a previous supported schema forward without data loss", () => {
    const sqlite = openTempSqlite();
    migrateSqliteUpTo(sqlite, "0003_credentials_heartbeats_state");

    const tenantId = createId();
    const clientId = createId();
    const workflowId = createId();
    const credentialId = createId();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, ?, 'self_hosted', ?, ?)`,
      )
      .run(tenantId, "Local", now, now);
    sqlite
      .prepare(
        `INSERT INTO clients (id, tenant_id, name, slug, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'onboarding', ?, ?)`,
      )
      .run(clientId, tenantId, "Acme", "acme", now, now);
    sqlite
      .prepare(
        `INSERT INTO workflows (
           id, tenant_id, client_id, name, source_platform, external_workflow_id,
           monitoring_method, is_active, created_at, updated_at
         ) VALUES (?, ?, ?, 'Invoices', 'n8n', 'ext-1', 'push', 1, ?, ?)`,
      )
      .run(workflowId, tenantId, clientId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workflow_credentials (
           id, tenant_id, workflow_id, key_id,
           encrypted_secret_or_verification_material, status, created_at
         ) VALUES (?, ?, ?, 'key_1', 'enc-material', 'active', ?)`,
      )
      .run(credentialId, tenantId, workflowId, now);

    migrateSqliteToLatest(sqlite);

    const tenant = sqlite
      .prepare(`SELECT id, name, edition FROM tenants WHERE id = ?`)
      .get(tenantId) as { id: string; name: string; edition: string };
    const credential = sqlite
      .prepare(
        `SELECT id, key_id, status FROM workflow_credentials WHERE id = ?`,
      )
      .get(credentialId) as { id: string; key_id: string; status: string };

    expect(tenant).toEqual({
      id: tenantId,
      name: "Local",
      edition: "self_hosted",
    });
    expect(credential).toEqual({
      id: credentialId,
      key_id: "key_1",
      status: "active",
    });
    expect(getAppliedSqliteMigrationTags(sqlite)).toEqual(
      listMigrationTags("sqlite"),
    );

    const channelId = createId();
    sqlite
      .prepare(
        `INSERT INTO alert_channels (
           id, tenant_id, name, type, encrypted_config, is_active, created_at, updated_at
         ) VALUES (?, ?, 'Ops webhook', 'webhook', 'enc-cfg', 1, ?, ?)`,
      )
      .run(channelId, tenantId, now, now);

    expect(
      (
        sqlite
          .prepare(`SELECT COUNT(*) AS c FROM alert_channels WHERE id = ?`)
          .get(channelId) as { c: number }
      ).c,
    ).toBe(1);
  });

  it("fails application readiness when migrations are pending", () => {
    const sqlite = openTempSqlite();
    migrateSqliteUpTo(sqlite, "0001_tenants_clients");
    const readiness = evaluateSqliteReadiness(sqlite);
    expect(readiness.status).toBe("pending_migrations");
    expect(() => assertApplicationReady(readiness)).toThrow(
      SchemaNotReadyError,
    );
  });

  it("blocks watcher, ingestion, and outbox after a failed migration", () => {
    const sqlite = openTempSqlite();
    migrateSqliteUpTo(sqlite, "0001_tenants_clients");

    sqlite.exec(`
      INSERT INTO __quorum_migration_failure (id, error, failed_at)
      VALUES (1, 'simulated migration failure', '${new Date().toISOString()}')
    `);

    const readiness = evaluateSqliteReadiness(sqlite);
    expect(readiness.status).toBe("failed_migration");

    expect(() => startWatcher(readiness)).toThrow(/watcher blocked/);
    expect(() => startIngestion(readiness)).toThrow(/ingestion blocked/);
    expect(() => startOutboxProcessing(readiness)).toThrow(/outbox blocked/);
  });

  it("keeps dialect-specific SQL inside versioned migration files", () => {
    const contractSql = readMigrationSql("sqlite", "0002_workflows_contracts");
    expect(contractSql).toContain(
      "workflow_contracts_one_active_heartbeat_uidx",
    );
    expect(contractSql).toMatch(/WHERE\s+`?is_active`?\s*=\s*1/i);

    const evidenceSql = readMigrationSql(
      "sqlite",
      "0003_credentials_heartbeats_state",
    );
    expect(evidenceSql).toContain("heartbeat_events_workflow_idempotency_uidx");
    expect(evidenceSql).toContain("heartbeat_events_immutable_update");

    const alertingSql = readMigrationSql(
      "sqlite",
      "0004_incidents_alerting_outbox",
    );
    expect(alertingSql).toContain("incidents_one_unresolved_uidx");
    expect(alertingSql).toMatch(
      /WHERE\s+`status`\s+IN\s+\('open',\s*'acknowledged'\)/i,
    );

    const connectorSql = readMigrationSql(
      "sqlite",
      "0005_n8n_connectors_polling",
    );
    expect(connectorSql).toContain("n8n_connectors");
    expect(connectorSql).toContain("n8n_poll_checkpoints");
    expect(connectorSql).toContain("connector_id");

    const watcherSql = readMigrationSql("sqlite", "0006_watcher_outbox_audit");
    expect(watcherSql).toContain("watcher_run_state");
    expect(watcherSql).toContain("incident_audit_events");

    const waitingSql = readMigrationSql(
      "sqlite",
      "0014_reconciliation_waiting_status",
    );
    expect(waitingSql).toContain("'waiting'");
    expect(waitingSql).toMatch(
      /CASE WHEN `match_status` = 'ignored' THEN 'waiting'/i,
    );

    const watchdogSql = readMigrationSql("sqlite", "0018_watchdog_dimensions");
    expect(watchdogSql).toContain("empty_result_breach_threshold");
    expect(watchdogSql).toContain("source_watermark_required");
    expect(watchdogSql).toContain("freshness_stale");
    expect(watchdogSql).toContain("consecutive_empty_results");
    expect(watchdogSql).toContain("last_source_watermark");

    const unknownFreshSql = readMigrationSql(
      "sqlite",
      "0019_watchdog_unknown_freshness",
    );
    expect(unknownFreshSql).toContain("unknown_reason");
    expect(unknownFreshSql).toContain("first_failure_at");
    expect(unknownFreshSql).toContain("latest_failure_at");
    expect(unknownFreshSql).toContain("watermark_comparison_type");
    expect(unknownFreshSql).toContain("freshness_allowed_staleness_seconds");
    expect(unknownFreshSql).toContain("last_source_watermark_at");

    const effectSql = readMigrationSql(
      "sqlite",
      "0020_effect_receipt_reconciliation",
    );
    expect(effectSql).toContain("effect_reconciliation_enabled");
    expect(effectSql).toContain("effect_count_mismatch");
    expect(effectSql).toContain("last_effect_reconciliation_status");

    const srcRoot = path.resolve("src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) {
          continue;
        }
        const content = fs.readFileSync(full, "utf8");
        if (/ALTER\s+TABLE/i.test(content)) {
          offenders.push(full);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it("migrates a pre-0020 database forward onto effect receipt columns", () => {
    const sqlite = openTempSqlite();
    migrateSqliteUpTo(sqlite, "0019_watchdog_unknown_freshness");
    const before = getAppliedSqliteMigrationTags(sqlite);
    expect(before).toContain("0019_watchdog_unknown_freshness");
    expect(before).not.toContain("0020_effect_receipt_reconciliation");

    const colsBefore = sqlite
      .prepare(`PRAGMA table_info(workflow_contracts)`)
      .all() as Array<{ name: string }>;
    expect(colsBefore.map((c) => c.name)).not.toContain(
      "effect_reconciliation_enabled",
    );

    migrateSqliteToLatest(sqlite);
    const after = getAppliedSqliteMigrationTags(sqlite);
    expect(after).toContain("0020_effect_receipt_reconciliation");
    expect(after).toEqual(listMigrationTags("sqlite"));

    const contractCols = sqlite
      .prepare(`PRAGMA table_info(workflow_contracts)`)
      .all() as Array<{ name: string }>;
    expect(contractCols.map((c) => c.name)).toContain(
      "effect_reconciliation_enabled",
    );
    const stateCols = sqlite
      .prepare(`PRAGMA table_info(workflow_states)`)
      .all() as Array<{ name: string }>;
    expect(stateCols.map((c) => c.name)).toContain(
      "last_effect_reconciliation_status",
    );
  });

  it("retries the known pre-0020 foreign-key failure and preserves incident references", () => {
    const sqlite = openTempSqlite();
    migrateSqliteUpTo(sqlite, "0019_watchdog_unknown_freshness");
    const now = new Date().toISOString();
    const tenantId = createId();
    const workflowId = createId();
    const incidentId = createId();

    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'T', 'self_hosted', ?, ?)`,
      )
      .run(tenantId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workflows (
           id, tenant_id, client_id, name, source_platform, external_workflow_id,
           monitoring_method, is_active, created_at, updated_at
         ) VALUES (?, ?, NULL, 'W', 'n8n', 'ext', 'poll', 1, ?, ?)`,
      )
      .run(workflowId, tenantId, now, now);
    sqlite
      .prepare(
        `INSERT INTO incidents (
           id, tenant_id, client_id, contract_kind, workflow_id,
           outcome_contract_id, incident_type, severity, status, opened_at,
           last_observed_at, notification_count, summary, created_at, updated_at
         ) VALUES (?, ?, NULL, 'workflow', ?, NULL, 'silent_absence',
           'warning', 'open', ?, ?, 0, 'Missing run', ?, ?)`,
      )
      .run(incidentId, tenantId, workflowId, now, now, now, now);
    sqlite
      .prepare(
        `INSERT INTO notification_outbox (
           id, tenant_id, incident_id, event_type, payload_json, available_at,
           attempt_count, created_at
         ) VALUES (?, ?, ?, 'opened', '{}', ?, 0, ?)`,
      )
      .run(createId(), tenantId, incidentId, now, now);
    sqlite
      .prepare(
        `INSERT INTO __quorum_migration_failure (id, error, failed_at)
         VALUES (1, 'FOREIGN KEY constraint failed', ?)`,
      )
      .run(now);

    expect(() => migrateSqliteToLatest(sqlite)).not.toThrow();
    expect(getSqliteMigrationFailure(sqlite)).toBeNull();
    expect(getAppliedSqliteMigrationTags(sqlite)).toContain(
      "0020_effect_receipt_reconciliation",
    );
    expect(
      sqlite
        .prepare(`SELECT incident_id FROM notification_outbox LIMIT 1`)
        .get(),
    ).toEqual({ incident_id: incidentId });
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("retries a foreign-key failure recorded before migration 0016", () => {
    const sqlite = openTempSqlite();
    migrateSqliteUpTo(sqlite, "0015_ops_audit_events");
    sqlite
      .prepare(
        `INSERT INTO __quorum_migration_failure (id, error, failed_at)
         VALUES (1, 'FOREIGN KEY constraint failed', ?)`,
      )
      .run(new Date().toISOString());

    expect(() => migrateSqliteToLatest(sqlite)).not.toThrow();
    expect(getSqliteMigrationFailure(sqlite)).toBeNull();
    expect(getAppliedSqliteMigrationTags(sqlite)).toEqual(
      listMigrationTags("sqlite"),
    );
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("enforces one active heartbeat contract per workflow at the database", () => {
    const sqlite = openTempSqlite();
    migrateSqliteToLatest(sqlite);
    const now = new Date().toISOString();
    const tenantId = createId();
    const workflowId = createId();

    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'T', 'self_hosted', ?, ?)`,
      )
      .run(tenantId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workflows (
           id, tenant_id, client_id, name, source_platform, external_workflow_id,
           monitoring_method, is_active, created_at, updated_at
         ) VALUES (?, ?, NULL, 'W', 'n8n', 'ext', 'push', 1, ?, ?)`,
      )
      .run(workflowId, tenantId, now, now);

    const insertContract = sqlite.prepare(`
      INSERT INTO workflow_contracts (
        id, tenant_id, workflow_id, name, business_purpose, contract_type,
        cadence_type, cadence_value, interval_mode, schedule_anchor_at, timezone,
        allowed_lateness_minutes, max_quiet_window_minutes, initial_grace_minutes,
        empty_result_policy, count_less_success_allowed, notification_backoff_minutes,
        evidence_level, schema_version, is_active, activated_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'c', 'purpose', 'heartbeat', 'event_driven', 'event', NULL, NULL, NULL,
        10, 60, 15, 'allowed', 0, 240, 'basic', 1, 1, ?, ?, ?
      )
    `);

    insertContract.run(createId(), tenantId, workflowId, now, now, now);
    expect(() =>
      insertContract.run(createId(), tenantId, workflowId, now, now, now),
    ).toThrow();
  });

  it("enforces heartbeat idempotency, immutability, and items_processed", () => {
    const sqlite = openTempSqlite();
    migrateSqliteToLatest(sqlite);
    const now = new Date().toISOString();
    const tenantId = createId();
    const workflowId = createId();
    const eventId = createId();

    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'T', 'self_hosted', ?, ?)`,
      )
      .run(tenantId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workflows (
           id, tenant_id, client_id, name, source_platform, external_workflow_id,
           monitoring_method, is_active, created_at, updated_at
         ) VALUES (?, ?, NULL, 'W', 'n8n', 'ext', 'push', 1, ?, ?)`,
      )
      .run(workflowId, tenantId, now, now);

    const insertEvent = sqlite.prepare(`
      INSERT INTO heartbeat_events (
        id, tenant_id, workflow_id, received_at, executed_at, status,
        items_processed, external_execution_ref, idempotency_key,
        payload_schema_version, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'success', ?, 'exec-1', ?, 1, ?, ?)
    `);

    insertEvent.run(
      eventId,
      tenantId,
      workflowId,
      now,
      now,
      2,
      "idem-1",
      JSON.stringify({ trigger: "schedule" }),
      now,
    );

    expect(() =>
      insertEvent.run(
        createId(),
        tenantId,
        workflowId,
        now,
        now,
        2,
        "idem-1",
        null,
        now,
      ),
    ).toThrow();

    expect(() =>
      sqlite
        .prepare(`UPDATE heartbeat_events SET status = 'failure' WHERE id = ?`)
        .run(eventId),
    ).toThrow(/immutable/);

    expect(() =>
      sqlite.prepare(`DELETE FROM heartbeat_events WHERE id = ?`).run(eventId),
    ).toThrow(/immutable/);

    expect(() =>
      insertEvent.run(
        createId(),
        tenantId,
        workflowId,
        now,
        now,
        -1,
        "idem-2",
        null,
        now,
      ),
    ).toThrow();

    sqlite
      .prepare(
        `INSERT INTO workflow_states (
           tenant_id, workflow_id, last_status, current_health, evidence_level,
           consecutive_stale_checks, updated_at, unverified_dimensions_json
         ) VALUES (?, ?, 'success', 'healthy', 'basic', 0, ?, ?)`,
      )
      .run(
        tenantId,
        workflowId,
        now,
        JSON.stringify(["destination_not_checked"]),
      );

    const state = sqlite
      .prepare(
        `SELECT current_health, evidence_level FROM workflow_states
         WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .get(tenantId, workflowId) as {
      current_health: string;
      evidence_level: string;
    };
    expect(state).toEqual({
      current_health: "healthy",
      evidence_level: "basic",
    });
  });

  it("enforces at most one unresolved incident per contract and type", () => {
    const sqlite = openTempSqlite();
    migrateSqliteToLatest(sqlite);
    const now = new Date().toISOString();
    const tenantId = createId();
    const workflowId = createId();
    const channelId = createId();

    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'T', 'self_hosted', ?, ?)`,
      )
      .run(tenantId, now, now);
    sqlite
      .prepare(
        `INSERT INTO workflows (
           id, tenant_id, client_id, name, source_platform, external_workflow_id,
           monitoring_method, is_active, created_at, updated_at
         ) VALUES (?, ?, NULL, 'W', 'n8n', 'ext', 'push', 1, ?, ?)`,
      )
      .run(workflowId, tenantId, now, now);
    sqlite
      .prepare(
        `INSERT INTO alert_channels (
           id, tenant_id, name, type, encrypted_config, is_active, created_at, updated_at
         ) VALUES (?, ?, 'Hook', 'webhook', 'enc', 1, ?, ?)`,
      )
      .run(channelId, tenantId, now, now);

    const insertIncident = sqlite.prepare(`
      INSERT INTO incidents (
        id, tenant_id, client_id, contract_kind, workflow_id, outcome_contract_id,
        incident_type, severity, status, opened_at, last_observed_at,
        notification_count, summary, created_at, updated_at
      ) VALUES (?, ?, NULL, 'workflow', ?, NULL, 'silent_absence', 'critical', ?, ?, ?, 0, 'missing run', ?, ?)
    `);

    insertIncident.run(
      createId(),
      tenantId,
      workflowId,
      "open",
      now,
      now,
      now,
      now,
    );

    expect(() =>
      insertIncident.run(
        createId(),
        tenantId,
        workflowId,
        "acknowledged",
        now,
        now,
        now,
        now,
      ),
    ).toThrow();

    insertIncident.run(
      createId(),
      tenantId,
      workflowId,
      "resolved",
      now,
      now,
      now,
      now,
    );

    sqlite
      .prepare(
        `INSERT INTO alert_channel_states (
           tenant_id, alert_channel_id, current_health, consecutive_failures, updated_at
         ) VALUES (?, ?, 'failing', 3, ?)`,
      )
      .run(tenantId, channelId, now);

    const channelHealth = sqlite
      .prepare(
        `SELECT current_health FROM alert_channel_states
         WHERE tenant_id = ? AND alert_channel_id = ?`,
      )
      .get(tenantId, channelId) as { current_health: string };
    expect(channelHealth.current_health).toBe("failing");

    const outboxId = createId();
    sqlite
      .prepare(
        `INSERT INTO notification_outbox (
           id, tenant_id, incident_id, event_type, payload_json, available_at,
           attempt_count, created_at
         ) VALUES (?, ?, NULL, 'channel_test', '{}', ?, 0, ?)`,
      )
      .run(outboxId, tenantId, now, now);

    sqlite
      .prepare(
        `INSERT INTO notification_attempts (
           id, tenant_id, incident_id, alert_channel_id, outbox_id, status, attempted_at
         ) VALUES (?, ?, NULL, ?, ?, 'failed', ?)`,
      )
      .run(createId(), tenantId, channelId, outboxId, now);
  });

  it("migrates legacy incident lifecycle and review state without losing history", () => {
    const sqlite = openTempSqlite();
    migrateSqliteUpTo(sqlite, "0020_effect_receipt_reconciliation");
    const tenantId = createId();
    const workflowId = createId();
    const acknowledgedWorkflowId = createId();
    const openedAt = "2026-08-05T07:00:00.000Z";
    const resolvedAt = "2026-08-05T07:10:00.000Z";
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'T', 'self_hosted', ?, ?)`,
      )
      .run(tenantId, openedAt, openedAt);
    sqlite
      .prepare(
        `INSERT INTO workflows (
           id, tenant_id, name, source_platform, external_workflow_id,
           monitoring_method, is_active, created_at, updated_at
         ) VALUES (?, ?, 'W', 'n8n', 'legacy-workflow', 'push', 1, ?, ?)`,
      )
      .run(workflowId, tenantId, openedAt, openedAt);
    sqlite
      .prepare(
        `INSERT INTO workflows (
           id, tenant_id, name, source_platform, external_workflow_id,
           monitoring_method, is_active, created_at, updated_at
         ) VALUES (?, ?, 'W2', 'n8n', 'legacy-ack-workflow', 'push', 1, ?, ?)`,
      )
      .run(acknowledgedWorkflowId, tenantId, openedAt, openedAt);
    const insert = sqlite.prepare(
      `INSERT INTO incidents (
         id, tenant_id, contract_kind, workflow_id, incident_type, severity,
         status, opened_at, resolved_at, last_observed_at,
         notification_count, summary, details_json, created_at, updated_at
       ) VALUES (?, ?, 'workflow', ?, 'hard_failure', 'critical', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    );
    const openId = createId();
    const acknowledgedId = createId();
    const resolvedId = createId();
    insert.run(
      openId,
      tenantId,
      workflowId,
      "open",
      openedAt,
      null,
      openedAt,
      "still failing",
      '{"failure":"status=failure"}',
      openedAt,
      openedAt,
    );
    insert.run(
      acknowledgedId,
      tenantId,
      acknowledgedWorkflowId,
      "acknowledged",
      openedAt,
      null,
      openedAt,
      "legacy acknowledged active incident",
      null,
      openedAt,
      openedAt,
    );
    sqlite
      .prepare(`UPDATE incidents SET acknowledged_at = ? WHERE id = ?`)
      .run("2026-08-05T07:05:00.000Z", acknowledgedId);
    insert.run(
      resolvedId,
      tenantId,
      workflowId,
      "resolved",
      openedAt,
      resolvedAt,
      resolvedAt,
      "recovered",
      '{"recoveredAt":"2026-08-05T07:10:00.000Z"}',
      openedAt,
      resolvedAt,
    );

    migrateSqliteToLatest(sqlite);
    const rows = sqlite
      .prepare(
        `SELECT id, lifecycle_status, acknowledgment_status, recovered_at,
                acknowledged_at, acknowledged_by, status, details_json
         FROM incidents ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    const active = rows.find((row) => row.id === openId);
    const legacyAcknowledged = rows.find((row) => row.id === acknowledgedId);
    const recovered = rows.find((row) => row.id === resolvedId);
    expect(active).toMatchObject({
      lifecycle_status: "active",
      acknowledgment_status: "unacknowledged",
      recovered_at: null,
      acknowledged_by: null,
      status: "open",
    });
    expect(recovered).toMatchObject({
      lifecycle_status: "recovered",
      acknowledgment_status: "acknowledged",
      recovered_at: resolvedAt,
      acknowledged_at: resolvedAt,
      acknowledged_by: "migration:legacy-status",
      status: "resolved",
      details_json: '{"recoveredAt":"2026-08-05T07:10:00.000Z"}',
    });
    expect(legacyAcknowledged).toMatchObject({
      lifecycle_status: "active",
      acknowledgment_status: "acknowledged",
      acknowledged_at: "2026-08-05T07:05:00.000Z",
      acknowledged_by: "migration:legacy-status",
      status: "open",
    });
  });
});
