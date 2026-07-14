import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import { createId } from "../../src/domain/ids.js";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { SqliteAlertingRepositories } from "../../src/infrastructure/db/repositories/sqlite-alerting-repositories.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { SqliteN8nConnectorRepositories } from "../../src/infrastructure/db/repositories/sqlite-n8n-connector-repositories.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-concurrency-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

describe("worker claim concurrency", () => {
  it("two outbox claimers cannot take the same pending row while TTL holds", () => {
    const sqlite = openDb();
    const now = "2026-07-19T12:00:00.000Z";
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const alerting = new SqliteAlertingRepositories(sqlite);
    const workflowId = createId();
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "wf",
      externalWorkflowId: "ext",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });
    const incident = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId,
      incidentType: "silent_absence",
      severity: "critical",
      summary: "overdue",
      observedAt: now,
    });
    alerting.enqueueOutbox(tenant.id, {
      id: createId(),
      incidentId: incident.id,
      eventType: "opened",
      payloadJson: "{}",
      availableAt: now,
    });
    const claimed = alerting.claimOutboxBatch(tenant.id, {
      nowIso: now,
      claimOwner: "worker-a",
      claimExpiresAtIso: "2026-07-19T12:01:00.000Z",
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    const contested = alerting.claimOutboxBatch(tenant.id, {
      nowIso: now,
      claimOwner: "worker-b",
      claimExpiresAtIso: "2026-07-19T12:01:00.000Z",
      limit: 10,
    });
    expect(contested).toHaveLength(0);
  });

  it("two poll claim owners cannot hold the same workflow claim", () => {
    const sqlite = openDb();
    const nowIso = "2026-07-19T12:00:00.000Z";
    const core = new SqliteCoreRepositories(sqlite);
    const connectors = new SqliteN8nConnectorRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const connector = connectors.createConnector(tenant.id, {
      name: "n8n",
      baseUrl: "https://n8n.example.com",
      encryptedApiKey: "enc",
      nowIso,
      status: "active",
    });
    const workflowId = createId();
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "polled",
      externalWorkflowId: "ext-poll",
      description: null,
      monitoringMethod: "poll",
      isActive: true,
      monitoringStartedAt: nowIso,
    });
    sqlite
      .prepare(
        `UPDATE workflows SET connector_id = ? WHERE id = ? AND tenant_id = ?`,
      )
      .run(connector.id, workflowId, tenant.id);
    const first = connectors.tryClaimPoll(
      tenant.id,
      workflowId,
      "poller-a",
      nowIso,
      "2026-07-19T12:01:00.000Z",
    );
    expect(first).toBe(true);
    const second = connectors.tryClaimPoll(
      tenant.id,
      workflowId,
      "poller-b",
      nowIso,
      "2026-07-19T12:01:00.000Z",
    );
    expect(second).toBe(false);
  });
});
