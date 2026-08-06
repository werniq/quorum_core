import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import {
  buildHeartbeatSigningPayload,
  sha256Hex,
  signHeartbeatHmacSha256,
} from "../../src/infrastructure/security/heartbeat-hmac.js";
import { createIngestHeartbeatHandler } from "../../src/infrastructure/ingestion/ingest-heartbeat.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { renderIncidentsBody } from "../../src/presentation/html/incidents-ui.js";
import type { IncidentListRow } from "../../src/presentation/html/incidents-ui.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";
const SECRET = "workflow-hmac-secret";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-empty-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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
        if (fs.existsSync(candidate)) {
          fs.unlinkSync(candidate);
        }
      } catch {
        // ignore
      }
    }
  }
});

function seedWorkflow(
  sqlite: BetterSqliteDatabase.Database,
  emptyResultPolicy: "allowed" | "warning" | "failure" = "failure",
) {
  const core = new SqliteCoreRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const now = new Date("2026-07-18T08:00:00.000Z").toISOString();
  const workflowId = createId();
  const keyId = "hk_empty";
  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "Invoice sync",
    externalWorkflowId: "n8n-empty",
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: now,
  });
  core.createWorkflowContract(tenant.id, {
    id: createId(),
    workflowId,
    name: "HB",
    businessPurpose: "sync",
    cadenceType: "event_driven",
    cadenceValue: "event",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: null,
    allowedLatenessMinutes: 0,
    maxQuietWindowMinutes: 60,
    initialGraceMinutes: 0,
    emptyResultPolicy,
    countLessSuccessAllowed: true,
    notificationBackoffMinutes: 240,
    evidenceLevel: "basic",
    schemaVersion: 1,
    isActive: true,
    activatedAt: now,
  });
  core.createCredential(tenant.id, {
    id: createId(),
    workflowId,
    keyId,
    encryptedSecretOrVerificationMaterial: encryptCredentialSecret(SECRET, KEK),
    status: "active",
    rotatedFromId: null,
    revokedAt: null,
  });

  const clock = new FixedClock(new Date("2026-07-18T08:00:00.000Z"));
  const env = loadEnv({
    NODE_ENV: "test",
    QUORUM_CREDENTIAL_KEK: KEK,
    HEARTBEAT_RATE_LIMIT_PER_MINUTE: "60",
    HEARTBEAT_RATE_LIMIT_BURST: "20",
  });
  const ingest = createIngestHeartbeatHandler({
    sqlite,
    env,
    clock,
    getSchemaReadiness: () => ({
      status: "ready",
      appliedMigrations: ["0004_incidents_alerting_outbox"],
    }),
  });

  return { tenant, workflowId, keyId, ingest, clock };
}

function signedRequest(input: {
  workflowId: string;
  keyId: string;
  idempotencyKey: string;
  body: object;
}) {
  const rawBody = Buffer.from(JSON.stringify(input.body), "utf8");
  const timestampSeconds = String(
    Math.floor(new Date("2026-07-18T08:00:00.000Z").getTime() / 1000),
  );
  const path = `/api/v1/workflows/${input.workflowId}/heartbeats`;
  const signature = signHeartbeatHmacSha256(
    SECRET,
    buildHeartbeatSigningPayload({
      method: "POST",
      path,
      timestampSeconds,
      idempotencyKey: input.idempotencyKey,
      bodySha256Hex: sha256Hex(rawBody),
    }),
  );
  return { rawBody, timestampSeconds, path, signature };
}

function ingestOk(
  ingest: ReturnType<typeof createIngestHeartbeatHandler>,
  workflowId: string,
  keyId: string,
  idempotencyKey: string,
  body: object,
) {
  const req = signedRequest({ workflowId, keyId, idempotencyKey, body });
  expect(
    ingest({
      workflowId,
      method: "POST",
      path: req.path,
      keyId,
      timestampSeconds: req.timestampSeconds,
      idempotencyKey,
      signatureHex: req.signature,
      rawBody: req.rawBody,
    }),
  ).toMatchObject({ status: "accepted" });
}

describe("empty-result contract handling", () => {
  it("recovers normal → empty result → normal and recalculates next deadline", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seedWorkflow(sqlite, "failure");
    sqlite
      .prepare(
        `UPDATE workflow_contracts
         SET max_quiet_window_minutes = 1440
         WHERE workflow_id = ?`,
      )
      .run(workflowId);

    ingestOk(ingest, workflowId, keyId, "ok-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 5,
      externalExecutionRef: "ok-1",
    });

    const afterOk = sqlite
      .prepare(
        `SELECT last_execution_at, last_acceptable_success_at, last_nonempty_success_at,
                last_status, current_health, next_expected_at, overdue_since
         FROM workflow_states WHERE workflow_id = ?`,
      )
      .get(workflowId) as Record<string, string | null>;
    expect(afterOk.last_status).toBe("success");
    expect(afterOk.current_health).toBe("healthy");
    expect(afterOk.last_nonempty_success_at).toBe("2026-07-18T08:00:00.000Z");
    expect(afterOk.next_expected_at).toBe("2026-07-19T08:00:00.000Z");
    const deadlineAfterOk = afterOk.next_expected_at!;

    ingestOk(ingest, workflowId, keyId, "empty-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:15:00Z",
      status: "success",
      itemsProcessed: 0,
      externalExecutionRef: "empty-1",
    });

    const afterEmpty = sqlite
      .prepare(
        `SELECT last_execution_at, last_acceptable_success_at, last_nonempty_success_at,
                last_status, current_health, next_expected_at, overdue_since
         FROM workflow_states WHERE workflow_id = ?`,
      )
      .get(workflowId) as Record<string, string | null>;
    expect(afterEmpty.last_status).toBe("empty_result");
    expect(afterEmpty.current_health).toBe("healthy");
    expect(afterEmpty.overdue_since).toBeNull();
    expect(afterEmpty.last_execution_at).toBe("2026-07-18T08:15:00.000Z");
    expect(afterEmpty.last_acceptable_success_at).toBe(
      "2026-07-18T08:00:00.000Z",
    );
    expect(afterEmpty.last_nonempty_success_at).toBe(
      "2026-07-18T08:00:00.000Z",
    );
    expect(afterEmpty.next_expected_at).toBe("2026-07-19T08:15:00.000Z");
    expect(afterEmpty.next_expected_at).not.toBe(deadlineAfterOk);

    const emptyIncident = sqlite
      .prepare(
        `SELECT status, summary, details_json FROM incidents
         WHERE workflow_id = ? AND incident_type = 'empty_result'`,
      )
      .get(workflowId) as {
      status: string;
      summary: string;
      details_json: string;
    };
    expect(emptyIncident.status).toBe("open");
    expect(emptyIncident.summary).toContain("contract violation");
    expect(JSON.parse(emptyIncident.details_json).itemsProcessed).toBe(0);

    ingestOk(ingest, workflowId, keyId, "ok-2", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:30:00Z",
      status: "success",
      itemsProcessed: 4,
      externalExecutionRef: "ok-2",
    });

    const recovered = sqlite
      .prepare(
        `SELECT status, summary FROM incidents
         WHERE workflow_id = ? AND incident_type = 'empty_result'`,
      )
      .get(workflowId) as { status: string; summary: string };
    expect(recovered.status).toBe("resolved");
    expect(recovered.summary).toContain("recovered");

    const finalState = sqlite
      .prepare(
        `SELECT last_status, last_nonempty_success_at, current_health
         FROM workflow_states WHERE workflow_id = ?`,
      )
      .get(workflowId) as Record<string, string>;
    expect(finalState.last_status).toBe("success");
    expect(finalState.last_nonempty_success_at).toBe(
      "2026-07-18T08:30:00.000Z",
    );
    expect(finalState.current_health).toBe("healthy");
  });

  it("resolves silent_absence when an empty-result heartbeat arrives", () => {
    const sqlite = openDb();
    const { tenant, workflowId, keyId, ingest } = seedWorkflow(
      sqlite,
      "warning",
    );

    ingestOk(ingest, workflowId, keyId, "ok-before", {
      schemaVersion: 1,
      executedAt: "2026-07-18T07:00:00Z",
      status: "success",
      itemsProcessed: 2,
    });

    const silenceId = createId();
    const opened = "2026-07-18T07:50:00.000Z";
    sqlite
      .prepare(
        `INSERT INTO incidents (
           id, tenant_id, client_id, contract_kind, workflow_id, outcome_contract_id,
           incident_type, severity, status, opened_at, acknowledged_at, resolved_at,
           last_observed_at, last_notified_at, notification_count, summary, details_json,
           volume_rule_id, volume_window_start, assignee_user_id, resolution_note,
           client_safe_resolution_note, response_target_minutes, resolution_target_minutes,
           created_at, updated_at
         ) VALUES (
           ?, ?, NULL, 'workflow', ?, NULL, 'silent_absence', 'critical', 'open', ?, NULL, NULL,
           ?, NULL, 0, 'silence', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?
         )`,
      )
      .run(silenceId, tenant.id, workflowId, opened, opened, opened, opened);

    sqlite
      .prepare(
        `UPDATE workflow_states
         SET current_health = 'overdue', overdue_since = ?
         WHERE workflow_id = ?`,
      )
      .run(opened, workflowId);

    ingestOk(ingest, workflowId, keyId, "empty-after-silence", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 0,
    });

    expect(
      (
        sqlite
          .prepare(`SELECT status FROM incidents WHERE id = ?`)
          .get(silenceId) as { status: string }
      ).status,
    ).toBe("resolved");

    const empty = sqlite
      .prepare(
        `SELECT status FROM incidents
         WHERE workflow_id = ? AND incident_type = 'empty_result'`,
      )
      .get(workflowId) as { status: string };
    expect(empty.status).toBe("open");

    const state = sqlite
      .prepare(
        `SELECT current_health, overdue_since, last_status FROM workflow_states WHERE workflow_id = ?`,
      )
      .get(workflowId) as {
      current_health: string;
      overdue_since: string | null;
      last_status: string;
    };
    expect(state.current_health).toBe("healthy");
    expect(state.overdue_since).toBeNull();
    expect(state.last_status).toBe("empty_result");
  });

  it("resolves hard_failure then opens empty_result on an empty heartbeat", () => {
    const sqlite = openDb();
    const { workflowId, keyId, ingest } = seedWorkflow(sqlite, "failure");

    ingestOk(ingest, workflowId, keyId, "fail-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "failure",
      itemsProcessed: 0,
      externalExecutionRef: "fail-1",
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents
             WHERE workflow_id = ? AND incident_type = 'hard_failure'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("open");

    ingestOk(ingest, workflowId, keyId, "empty-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:01:00Z",
      status: "success",
      itemsProcessed: 0,
      externalExecutionRef: "empty-1",
    });

    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents
             WHERE workflow_id = ? AND incident_type = 'hard_failure'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("resolved");

    const empty = sqlite
      .prepare(
        `SELECT status, summary FROM incidents
         WHERE workflow_id = ? AND incident_type = 'empty_result'`,
      )
      .get(workflowId) as { status: string; summary: string };
    expect(empty.status).toBe("open");
    expect(empty.summary).toContain("contract violation");
  });

  it("resets consecutive empties only after non-empty success; failures do not count", () => {
    const sqlite = openDb();
    const { tenant, workflowId, keyId, ingest } = seedWorkflow(
      sqlite,
      "failure",
    );
    sqlite
      .prepare(
        `UPDATE workflow_contracts
         SET empty_result_breach_threshold = 2
         WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .run(tenant.id, workflowId);

    ingestOk(ingest, workflowId, keyId, "empty-a", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 0,
      externalExecutionRef: "empty-a",
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT consecutive_empty_results AS n FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { n: number }
      ).n,
    ).toBe(1);
    expect(
      sqlite
        .prepare(
          `SELECT id FROM incidents WHERE workflow_id = ? AND incident_type = 'empty_result' AND status IN ('open','acknowledged')`,
        )
        .get(workflowId),
    ).toBeUndefined();

    ingestOk(ingest, workflowId, keyId, "fail-hold", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:05:00Z",
      status: "failure",
      itemsProcessed: 4,
      externalExecutionRef: "fail-hold",
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT consecutive_empty_results AS n FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { n: number }
      ).n,
    ).toBe(1);

    ingestOk(ingest, workflowId, keyId, "empty-b", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:10:00Z",
      status: "success",
      itemsProcessed: 0,
      externalExecutionRef: "empty-b",
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT consecutive_empty_results AS n FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { n: number }
      ).n,
    ).toBe(2);
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents
             WHERE workflow_id = ? AND incident_type = 'empty_result'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("open");

    ingestOk(ingest, workflowId, keyId, "ok-reset", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:15:00Z",
      status: "success",
      itemsProcessed: 3,
      externalExecutionRef: "ok-reset",
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT consecutive_empty_results AS n FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents
             WHERE workflow_id = ? AND incident_type = 'empty_result'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("resolved");
  });

  it("opens freshness_stale then recovers when the watermark advances", () => {
    const sqlite = openDb();
    const { tenant, workflowId, keyId, ingest } = seedWorkflow(
      sqlite,
      "allowed",
    );
    sqlite
      .prepare(
        `UPDATE workflow_contracts
         SET source_watermark_required = 1,
             watermark_comparison_type = 'numeric',
             freshness_allowed_staleness_seconds = 0,
             empty_result_breach_threshold = 1
         WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .run(tenant.id, workflowId);

    ingestOk(ingest, workflowId, keyId, "wm-1", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:00:00Z",
      status: "success",
      itemsProcessed: 2,
      externalExecutionRef: "wm-1",
      metadata: { sourceWatermark: "100" },
    });
    ingestOk(ingest, workflowId, keyId, "wm-stale", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:05:00Z",
      status: "success",
      itemsProcessed: 2,
      externalExecutionRef: "wm-stale",
      metadata: { sourceWatermark: "100" },
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents
             WHERE workflow_id = ? AND incident_type = 'freshness_stale'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("open");

    ingestOk(ingest, workflowId, keyId, "wm-advance", {
      schemaVersion: 1,
      executedAt: "2026-07-18T08:10:00Z",
      status: "success",
      itemsProcessed: 2,
      externalExecutionRef: "wm-advance",
      metadata: { sourceWatermark: "101" },
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT status FROM incidents
             WHERE workflow_id = ? AND incident_type = 'freshness_stale'`,
          )
          .get(workflowId) as { status: string }
      ).status,
    ).toBe("resolved");
    expect(
      (
        sqlite
          .prepare(
            `SELECT last_source_watermark AS w, consecutive_stale_watermarks AS n
             FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { w: string; n: number }
      ).w,
    ).toBe("101");
    expect(
      (
        sqlite
          .prepare(
            `SELECT consecutive_stale_watermarks AS n FROM workflow_states WHERE workflow_id = ?`,
          )
          .get(workflowId) as { n: number }
      ).n,
    ).toBe(0);
  });
});

describe("incidents page open-before-history", () => {
  it("renders open incidents before resolved hard-failure history", () => {
    const openSilent: IncidentListRow = {
      id: "s1",
      severity: "critical",
      status: "open",
      summary: "silence",
      openedAt: "2026-07-30T10:00:00.000Z",
      resolvedAt: null,
      lifecycleStatus: "active",
      acknowledgmentStatus: "unacknowledged",
      recoveredAt: null,
      recoveryEvidence: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      acknowledgmentNote: null,
      detailsJson: null,
      incidentType: "silent_absence",
      workflowId: "wf-1",
      workflowName: "A",
      monitoringMethod: "push",
      externalWorkflowId: null,
      connectorBaseUrl: null,
      lastAcceptableEvidenceAt: null,
      nextExpectedAt: null,
      overdueSince: null,
    };
    const resolvedHard: IncidentListRow = {
      id: "h1",
      severity: "critical",
      status: "resolved",
      summary: "recovered",
      openedAt: "2026-07-30T09:00:00.000Z",
      resolvedAt: "2026-07-30T09:30:00.000Z",
      lifecycleStatus: "recovered",
      acknowledgmentStatus: "acknowledged",
      recoveredAt: "2026-07-30T09:30:00.000Z",
      recoveryEvidence: "Healthy heartbeat",
      acknowledgedAt: "2026-07-30T09:31:00.000Z",
      acknowledgedBy: "admin",
      acknowledgmentNote: null,
      detailsJson: null,
      incidentType: "hard_failure",
      workflowId: "wf-2",
      workflowName: "B",
      monitoringMethod: "push",
      externalWorkflowId: null,
      connectorBaseUrl: null,
      lastAcceptableEvidenceAt: null,
      nextExpectedAt: null,
      overdueSince: null,
    };
    const html = renderIncidentsBody({
      rows: [resolvedHard, openSilent],
      nowMs: Date.parse("2026-07-30T11:00:00.000Z"),
      csrf: "csrf",
      attentionCount: 0,
      warningCount: 0,
      overdueCount: 0,
    });
    expect(html).toContain("Incident history");
    expect(html.indexOf("silent_absence")).toBeLessThan(
      html.indexOf("Incident history"),
    );
  });
});
