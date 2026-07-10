import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
  evaluateSqliteReadiness,
  migrateSqliteUpTo,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import {
  listMigrationTags,
  readMigrationSql,
  splitMigrationStatements,
  buildReadinessState,
} from "../../src/infrastructure/db/migrations.js";
import { createId } from "../../src/domain/ids.js";
import { SqliteAlertingRepositories } from "../../src/infrastructure/db/repositories/sqlite-alerting-repositories.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { queryContractCatalog } from "../../src/infrastructure/catalog/query-catalog.js";
import { FixedClock } from "../../src/domain/clock.js";
import { assertApplicationReady } from "../../src/application/processors.js";
import { SchemaNotReadyError } from "../../src/application/schema-readiness.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openSqlite(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-dialect-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  const { sqlite } = openSqliteDatabase(filePath);
  openConnections.push(sqlite);
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

async function migratePostgresLatest(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS __quorum_migrations (
      id SERIAL PRIMARY KEY,
      tag TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL
    );
  `);
  const applied = await db.query<{ tag: string }>(
    `SELECT tag FROM __quorum_migrations ORDER BY id ASC`,
  );
  const appliedSet = new Set(applied.rows.map((row) => row.tag));
  for (const tag of listMigrationTags("postgres")) {
    if (appliedSet.has(tag)) continue;
    const sql = readMigrationSql("postgres", tag);
    for (const statement of splitMigrationStatements(sql)) {
      await db.exec(statement);
    }
    await db.query(
      `INSERT INTO __quorum_migrations (tag, applied_at) VALUES ($1, NOW())`,
      [tag],
    );
  }
}

describe("shared dialect invariants", () => {
  it("SQLite: fresh migrate, upgrade, pending gate, claiming, catalog sort/pagination", () => {
    const sqlite = openSqlite();
    migrateSqliteUpTo(sqlite, "0003_credentials_heartbeats_state");
    migrateSqliteToLatest(sqlite);
    expect(evaluateSqliteReadiness(sqlite).status).toBe("ready");

    const pending = openSqlite();
    migrateSqliteUpTo(pending, "0001_tenants_clients");
    expect(() =>
      assertApplicationReady(evaluateSqliteReadiness(pending)),
    ).toThrow(SchemaNotReadyError);

    const db = openSqlite();
    migrateSqliteToLatest(db);
    const core = new SqliteCoreRepositories(db);
    const alerting = new SqliteAlertingRepositories(db);
    const tenant = core.ensureSelfHostedTenant();
    const workflowId = createId();
    const now = "2026-07-18T08:00:00.000Z";
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "W",
      externalWorkflowId: createId(),
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });
    core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId,
      name: "C",
      businessPurpose: "P",
      cadenceType: "event_driven",
      cadenceValue: "event",
      intervalMode: null,
      scheduleAnchorAt: null,
      timezone: null,
      allowedLatenessMinutes: 0,
      maxQuietWindowMinutes: 30,
      initialGraceMinutes: 0,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 60,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: now,
    });

    const incident = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "x",
      observedAt: now,
    });
    const outboxId = createId();
    alerting.enqueueOutbox(tenant.id, {
      id: outboxId,
      incidentId: incident.id,
      eventType: "opened",
      payloadJson: "{}",
      availableAt: now,
    });
    const claimed = alerting.claimOutboxBatch(tenant.id, {
      nowIso: now,
      claimOwner: "worker-a",
      claimExpiresAtIso: "2026-07-18T08:01:00.000Z",
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    const contested = alerting.claimOutboxBatch(tenant.id, {
      nowIso: now,
      claimOwner: "worker-b",
      claimExpiresAtIso: "2026-07-18T08:01:00.000Z",
      limit: 10,
    });
    expect(contested).toHaveLength(0);

    alerting.applyChannelDeliveryResult(
      tenant.id,
      (() => {
        const channelId = createId();
        alerting.createAlertChannel(tenant.id, {
          id: channelId,
          name: "w",
          type: "webhook",
          encryptedConfig: "enc",
          isActive: true,
        });
        alerting.routeContractToChannel(tenant.id, {
          contractKind: "workflow",
          contractId: workflowId,
          alertChannelId: channelId,
        });
        return channelId;
      })(),
      { type: "delivery_failed", retriesRemaining: false },
      now,
    );

    db.prepare(
      `INSERT INTO workflow_states (
         tenant_id, workflow_id, last_status, current_health, evidence_level,
         evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks, updated_at
       ) VALUES (?, ?, 'unknown', 'overdue', 'basic', 'overdue', '[]', 0, ?)`,
    ).run(tenant.id, workflowId, now);

    const catalog = queryContractCatalog({
      sqlite: db,
      clock: new FixedClock(new Date(now)),
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
      limit: 5,
      offset: 0,
    });
    expect(catalog[0]?.alertChannelHealth).toBe("failing");
    expect(catalog[0]?.activeIncident?.severity).toBe("critical");
  });

  it("Postgres: fresh migrate, incident uniqueness, immutable heartbeats, outbox claim columns", async () => {
    const db = new PGlite();
    await migratePostgresLatest(db);
    const readiness = buildReadinessState({
      expectedTags: listMigrationTags("postgres"),
      appliedTags: (
        await db.query<{ tag: string }>(
          `SELECT tag FROM __quorum_migrations ORDER BY id ASC`,
        )
      ).rows.map((row) => row.tag),
    });
    expect(readiness.status).toBe("ready");

    const tenantId = createId();
    const workflowId = createId();
    const now = "2026-07-18T08:00:00.000Z";
    await db.query(
      `INSERT INTO tenants (id, name, edition, created_at, updated_at)
       VALUES ($1, 'T', 'saas', $2, $2)`,
      [tenantId, now],
    );
    await db.query(
      `INSERT INTO workflows (
         id, tenant_id, name, source_platform, external_workflow_id,
         monitoring_method, is_active, created_at, updated_at
       ) VALUES ($1, $2, 'W', 'n8n', $3, 'push', true, $4, $4)`,
      [workflowId, tenantId, createId(), now],
    );

    const incidentId = createId();
    await db.query(
      `INSERT INTO incidents (
         id, tenant_id, contract_kind, workflow_id, incident_type, severity, status,
         opened_at, last_observed_at, notification_count, summary, created_at, updated_at
       ) VALUES ($1, $2, 'workflow', $3, 'silent_absence', 'critical', 'open',
         $4, $4, 0, 'x', $4, $4)`,
      [incidentId, tenantId, workflowId, now],
    );
    await expect(
      db.query(
        `INSERT INTO incidents (
           id, tenant_id, contract_kind, workflow_id, incident_type, severity, status,
           opened_at, last_observed_at, notification_count, summary, created_at, updated_at
         ) VALUES ($1, $2, 'workflow', $3, 'silent_absence', 'critical', 'open',
           $4, $4, 0, 'y', $4, $4)`,
        [createId(), tenantId, workflowId, now],
      ),
    ).rejects.toThrow();

    const eventId = createId();
    await db.query(
      `INSERT INTO heartbeat_events (
         id, tenant_id, workflow_id, received_at, executed_at, status,
         items_processed, idempotency_key, payload_schema_version, created_at
       ) VALUES ($1, $2, $3, $4, $4, 'success', 1, 'idem-1', 1, $4)`,
      [eventId, tenantId, workflowId, now],
    );
    await expect(
      db.query(`UPDATE heartbeat_events SET status = 'failure' WHERE id = $1`, [
        eventId,
      ]),
    ).rejects.toThrow();

    const outboxId = createId();
    await db.query(
      `INSERT INTO notification_outbox (
         id, tenant_id, incident_id, event_type, payload_json, available_at,
         attempt_count, created_at
       ) VALUES ($1, $2, $3, 'opened', '{}', $4, 0, $4)`,
      [outboxId, tenantId, incidentId, now],
    );
    await db.query(
      `UPDATE notification_outbox
       SET claimed_at = $1, claim_expires_at = $2
       WHERE id = $3 AND processed_at IS NULL`,
      [now, "2026-07-18T08:05:00.000Z", outboxId],
    );
    const claimed = await db.query<{ claimed_at: string }>(
      `SELECT claimed_at FROM notification_outbox WHERE id = $1`,
      [outboxId],
    );
    expect(claimed.rows[0]?.claimed_at).toBeTruthy();

    await db.close();
  });
});
