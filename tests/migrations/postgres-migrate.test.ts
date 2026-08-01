import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  buildReadinessState,
  listMigrationTags,
  readMigrationSql,
  splitMigrationStatements,
} from "../../src/infrastructure/db/migrations.js";
import { createId } from "../../src/domain/ids.js";
import {
  assertApplicationReady,
  startIngestion,
  startOutboxProcessing,
  startWatcher,
} from "../../src/application/processors.js";
import { SchemaNotReadyError } from "../../src/application/schema-readiness.js";

const MIGRATIONS_TABLE = "__quorum_migrations";
const FAILURE_TABLE = "__quorum_migration_failure";

async function ensureMetaTables(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      tag TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${FAILURE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      error TEXT NOT NULL,
      failed_at TIMESTAMPTZ NOT NULL
    );
  `);
}

async function getAppliedTags(db: PGlite): Promise<string[]> {
  await ensureMetaTables(db);
  const result = await db.query<{ tag: string }>(
    `SELECT tag FROM ${MIGRATIONS_TABLE} ORDER BY id ASC`,
  );
  return result.rows.map((row) => row.tag);
}

async function getFailure(db: PGlite): Promise<string | null> {
  await ensureMetaTables(db);
  const result = await db.query<{ error: string }>(
    `SELECT error FROM ${FAILURE_TABLE} WHERE id = 1`,
  );
  return result.rows[0]?.error ?? null;
}

async function migrateUpTo(db: PGlite, inclusiveTag: string): Promise<void> {
  await ensureMetaTables(db);
  const applied = new Set(await getAppliedTags(db));
  const expected = listMigrationTags("postgres");
  const stopIndex = expected.indexOf(inclusiveTag);
  if (stopIndex < 0) {
    throw new Error(`Unknown migration tag: ${inclusiveTag}`);
  }

  for (const tag of expected.slice(0, stopIndex + 1)) {
    if (applied.has(tag)) {
      continue;
    }
    const sql = readMigrationSql("postgres", tag);
    for (const statement of splitMigrationStatements(sql)) {
      await db.exec(statement);
    }
    await db.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES ($1, NOW())`,
      [tag],
    );
  }
}

async function migrateToLatest(db: PGlite): Promise<void> {
  await ensureMetaTables(db);
  const failure = await getFailure(db);
  if (failure) {
    throw new Error(`Cannot migrate: previous migration failed: ${failure}`);
  }

  const applied = new Set(await getAppliedTags(db));
  for (const tag of listMigrationTags("postgres")) {
    if (applied.has(tag)) {
      continue;
    }
    try {
      const sql = readMigrationSql("postgres", tag);
      for (const statement of splitMigrationStatements(sql)) {
        await db.exec(statement);
      }
      await db.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES ($1, NOW())`,
        [tag],
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown migration failure";
      await db.query(
        `INSERT INTO ${FAILURE_TABLE} (id, error, failed_at)
         VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE
         SET error = EXCLUDED.error, failed_at = EXCLUDED.failed_at`,
        [message],
      );
      throw error;
    }
  }
}

async function evaluateReadiness(db: PGlite) {
  return buildReadinessState({
    expectedTags: listMigrationTags("postgres"),
    appliedTags: await getAppliedTags(db),
    failedError: await getFailure(db),
  });
}

describe("Postgres migrations", () => {
  const open: PGlite[] = [];

  afterEach(async () => {
    while (open.length > 0) {
      const db = open.pop();
      await db?.close();
    }
  });

  async function freshDb(): Promise<PGlite> {
    const db = new PGlite();
    open.push(db);
    return db;
  }

  it("migrates an empty Postgres database to latest", async () => {
    const db = await freshDb();
    await migrateToLatest(db);

    expect(await getAppliedTags(db)).toEqual(listMigrationTags("postgres"));

    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename`,
    );
    const names = tables.rows.map((row) => row.tablename);
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
      ]),
    );

    const readiness = await evaluateReadiness(db);
    expect(readiness.status).toBe("ready");
  });

  it("migrates a previous supported schema forward without data loss", async () => {
    const db = await freshDb();
    await migrateUpTo(db, "0003_credentials_heartbeats_state");

    const tenantId = createId();
    const clientId = createId();
    const workflowId = createId();
    const credentialId = createId();
    await db.query(
      `INSERT INTO tenants (id, name, edition, created_at, updated_at)
       VALUES ($1, $2, 'saas', NOW(), NOW())`,
      [tenantId, "Agency"],
    );
    await db.query(
      `INSERT INTO clients (id, tenant_id, name, slug, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'onboarding', NOW(), NOW())`,
      [clientId, tenantId, "Beta", "beta"],
    );
    await db.query(
      `INSERT INTO workflows (
         id, tenant_id, client_id, name, source_platform, external_workflow_id,
         monitoring_method, is_active, created_at, updated_at
       ) VALUES ($1, $2, $3, 'Invoices', 'n8n', 'ext-1', 'push', true, NOW(), NOW())`,
      [workflowId, tenantId, clientId],
    );
    await db.query(
      `INSERT INTO workflow_credentials (
         id, tenant_id, workflow_id, key_id,
         encrypted_secret_or_verification_material, status, created_at
       ) VALUES ($1, $2, $3, 'key_1', 'enc-material', 'active', NOW())`,
      [credentialId, tenantId, workflowId],
    );

    await migrateToLatest(db);

    const tenant = await db.query(
      `SELECT id, name, edition FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const credential = await db.query(
      `SELECT id, key_id, status FROM workflow_credentials WHERE id = $1`,
      [credentialId],
    );

    expect(tenant.rows[0]).toEqual({
      id: tenantId,
      name: "Agency",
      edition: "saas",
    });
    expect(credential.rows[0]).toEqual({
      id: credentialId,
      key_id: "key_1",
      status: "active",
    });
    expect(await getAppliedTags(db)).toEqual(listMigrationTags("postgres"));

    const channelId = createId();
    await db.query(
      `INSERT INTO alert_channels (
         id, tenant_id, name, type, encrypted_config, is_active, created_at, updated_at
       ) VALUES ($1, $2, 'Ops webhook', 'webhook', 'enc-cfg', true, NOW(), NOW())`,
      [channelId, tenantId],
    );
    const channels = await db.query(
      `SELECT COUNT(*)::int AS c FROM alert_channels WHERE id = $1`,
      [channelId],
    );
    expect(channels.rows[0]).toEqual({ c: 1 });
  });

  it("fails application readiness when migrations are pending", async () => {
    const db = await freshDb();
    await migrateUpTo(db, "0001_tenants_clients");
    const readiness = await evaluateReadiness(db);
    expect(readiness.status).toBe("pending_migrations");
    expect(() => assertApplicationReady(readiness)).toThrow(
      SchemaNotReadyError,
    );
  });

  it("blocks watcher, ingestion, and outbox after a failed migration", async () => {
    const db = await freshDb();
    await migrateUpTo(db, "0001_tenants_clients");
    await db.query(
      `INSERT INTO ${FAILURE_TABLE} (id, error, failed_at)
       VALUES (1, 'simulated migration failure', NOW())`,
    );

    const readiness = await evaluateReadiness(db);
    expect(readiness.status).toBe("failed_migration");
    expect(() => startWatcher(readiness)).toThrow(/watcher blocked/);
    expect(() => startIngestion(readiness)).toThrow(/ingestion blocked/);
    expect(() => startOutboxProcessing(readiness)).toThrow(/outbox blocked/);
  });

  it("keeps dialect-specific SQL inside versioned migration files", () => {
    const contractSql = readMigrationSql(
      "postgres",
      "0002_workflows_contracts",
    );
    expect(contractSql).toContain(
      "workflow_contracts_one_active_heartbeat_uidx",
    );
    expect(contractSql).toMatch(/WHERE\s+"is_active"\s*=\s*true/i);

    const evidenceSql = readMigrationSql(
      "postgres",
      "0003_credentials_heartbeats_state",
    );
    expect(evidenceSql).toContain("heartbeat_events_workflow_idempotency_uidx");
    expect(evidenceSql).toContain("forbid_heartbeat_events_mutation");

    const alertingSql = readMigrationSql(
      "postgres",
      "0004_incidents_alerting_outbox",
    );
    expect(alertingSql).toContain("incidents_one_unresolved_uidx");
    expect(alertingSql).toMatch(
      /WHERE\s+"status"\s+IN\s+\('open',\s*'acknowledged'\)/i,
    );

    const connectorSql = readMigrationSql(
      "postgres",
      "0005_n8n_connectors_polling",
    );
    expect(connectorSql).toContain("n8n_connectors");
    expect(connectorSql).toContain("n8n_poll_checkpoints");

    const waitingSql = readMigrationSql(
      "postgres",
      "0014_reconciliation_waiting_status",
    );
    expect(waitingSql).toContain("'waiting'");
    expect(waitingSql).toContain("SET \"match_status\" = 'waiting'");
    expect(waitingSql).toContain("reconciliation_items_status_check");

    const watchdogSql = readMigrationSql(
      "postgres",
      "0018_watchdog_dimensions",
    );
    expect(watchdogSql).toContain("empty_result_breach_threshold");
    expect(watchdogSql).toContain("source_watermark_required");
    expect(watchdogSql).toContain("freshness_stale");
    expect(watchdogSql).toContain("consecutive_empty_results");
    expect(watchdogSql).toContain("last_source_watermark");

    const unknownFreshSql = readMigrationSql(
      "postgres",
      "0019_watchdog_unknown_freshness",
    );
    expect(unknownFreshSql).toContain("unknown_reason");
    expect(unknownFreshSql).toContain("watermark_comparison_type");
    expect(unknownFreshSql).toContain("freshness_allowed_staleness_seconds");
    expect(unknownFreshSql).toContain("last_source_watermark_at");

    const effectSql = readMigrationSql(
      "postgres",
      "0020_effect_receipt_reconciliation",
    );
    expect(effectSql).toContain("effect_reconciliation_enabled");
    expect(effectSql).toContain("effect_count_mismatch");
    expect(effectSql).toContain("last_effect_reconciliation_status");
  });

  it("enforces heartbeat idempotency, immutability, and healthy+basic state", async () => {
    const db = await freshDb();
    await migrateToLatest(db);

    const tenantId = createId();
    const workflowId = createId();
    const eventId = createId();

    await db.query(
      `INSERT INTO tenants (id, name, edition, created_at, updated_at)
       VALUES ($1, 'T', 'saas', NOW(), NOW())`,
      [tenantId],
    );
    await db.query(
      `INSERT INTO workflows (
         id, tenant_id, client_id, name, source_platform, external_workflow_id,
         monitoring_method, is_active, created_at, updated_at
       ) VALUES ($1, $2, NULL, 'W', 'n8n', 'ext', 'push', true, NOW(), NOW())`,
      [workflowId, tenantId],
    );

    await db.query(
      `INSERT INTO heartbeat_events (
         id, tenant_id, workflow_id, received_at, executed_at, status,
         items_processed, external_execution_ref, idempotency_key,
         payload_schema_version, metadata_json, created_at
       ) VALUES ($1, $2, $3, NOW(), NOW(), 'success', 2, 'exec-1', 'idem-1', 1, $4, NOW())`,
      [eventId, tenantId, workflowId, JSON.stringify({ trigger: "schedule" })],
    );

    await expect(
      db.query(
        `INSERT INTO heartbeat_events (
           id, tenant_id, workflow_id, received_at, executed_at, status,
           items_processed, external_execution_ref, idempotency_key,
           payload_schema_version, metadata_json, created_at
         ) VALUES ($1, $2, $3, NOW(), NOW(), 'success', 2, 'exec-2', 'idem-1', 1, NULL, NOW())`,
        [createId(), tenantId, workflowId],
      ),
    ).rejects.toThrow();

    await expect(
      db.query(`UPDATE heartbeat_events SET status = 'failure' WHERE id = $1`, [
        eventId,
      ]),
    ).rejects.toThrow(/immutable/);

    await expect(
      db.query(`DELETE FROM heartbeat_events WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/immutable/);

    await db.query(
      `INSERT INTO workflow_states (
         tenant_id, workflow_id, last_status, current_health, evidence_level,
         consecutive_stale_checks, updated_at, unverified_dimensions_json
       ) VALUES ($1, $2, 'success', 'healthy', 'basic', 0, NOW(), $3)`,
      [tenantId, workflowId, JSON.stringify(["destination_not_checked"])],
    );

    const state = await db.query<{
      current_health: string;
      evidence_level: string;
    }>(
      `SELECT current_health, evidence_level FROM workflow_states
       WHERE tenant_id = $1 AND workflow_id = $2`,
      [tenantId, workflowId],
    );
    expect(state.rows[0]).toEqual({
      current_health: "healthy",
      evidence_level: "basic",
    });
  });

  it("enforces at most one unresolved incident per contract and type", async () => {
    const db = await freshDb();
    await migrateToLatest(db);

    const tenantId = createId();
    const workflowId = createId();
    const channelId = createId();

    await db.query(
      `INSERT INTO tenants (id, name, edition, created_at, updated_at)
       VALUES ($1, 'T', 'saas', NOW(), NOW())`,
      [tenantId],
    );
    await db.query(
      `INSERT INTO workflows (
         id, tenant_id, client_id, name, source_platform, external_workflow_id,
         monitoring_method, is_active, created_at, updated_at
       ) VALUES ($1, $2, NULL, 'W', 'n8n', 'ext', 'push', true, NOW(), NOW())`,
      [workflowId, tenantId],
    );
    await db.query(
      `INSERT INTO alert_channels (
         id, tenant_id, name, type, encrypted_config, is_active, created_at, updated_at
       ) VALUES ($1, $2, 'Hook', 'webhook', 'enc', true, NOW(), NOW())`,
      [channelId, tenantId],
    );

    await db.query(
      `INSERT INTO incidents (
         id, tenant_id, client_id, contract_kind, workflow_id, outcome_contract_id,
         incident_type, severity, status, opened_at, last_observed_at,
         notification_count, summary, created_at, updated_at
       ) VALUES ($1, $2, NULL, 'workflow', $3, NULL, 'silent_absence', 'critical', 'open', NOW(), NOW(), 0, 'missing run', NOW(), NOW())`,
      [createId(), tenantId, workflowId],
    );

    await expect(
      db.query(
        `INSERT INTO incidents (
           id, tenant_id, client_id, contract_kind, workflow_id, outcome_contract_id,
           incident_type, severity, status, opened_at, last_observed_at,
           notification_count, summary, created_at, updated_at
         ) VALUES ($1, $2, NULL, 'workflow', $3, NULL, 'silent_absence', 'critical', 'acknowledged', NOW(), NOW(), 0, 'missing run', NOW(), NOW())`,
        [createId(), tenantId, workflowId],
      ),
    ).rejects.toThrow();

    await db.query(
      `INSERT INTO incidents (
         id, tenant_id, client_id, contract_kind, workflow_id, outcome_contract_id,
         incident_type, severity, status, opened_at, last_observed_at,
         notification_count, summary, created_at, updated_at
       ) VALUES ($1, $2, NULL, 'workflow', $3, NULL, 'silent_absence', 'critical', 'resolved', NOW(), NOW(), 0, 'missing run', NOW(), NOW())`,
      [createId(), tenantId, workflowId],
    );

    await db.query(
      `INSERT INTO alert_channel_states (
         tenant_id, alert_channel_id, current_health, consecutive_failures, updated_at
       ) VALUES ($1, $2, 'failing', 3, NOW())`,
      [tenantId, channelId],
    );

    const channelHealth = await db.query<{ current_health: string }>(
      `SELECT current_health FROM alert_channel_states
       WHERE tenant_id = $1 AND alert_channel_id = $2`,
      [tenantId, channelId],
    );
    expect(channelHealth.rows[0]?.current_health).toBe("failing");
  });
});
