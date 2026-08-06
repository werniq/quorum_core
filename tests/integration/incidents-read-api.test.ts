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
import { SqliteAlertingRepositories } from "../../src/infrastructure/db/repositories/sqlite-alerting-repositories.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { buildApp } from "../../src/infrastructure/http/app.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import {
  decodeIncidentListCursor,
  encodeIncidentListCursor,
} from "../../src/infrastructure/http/incident-list-cursor.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-incidents-api-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

async function buildTestApp(sqlite: BetterSqliteDatabase.Database) {
  const clock = new FixedClock(new Date("2026-07-26T12:00:00.000Z"));
  const app = await buildApp({
    env: loadEnv({
      NODE_ENV: "test",
      QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
    }),
    clock,
    sqlite,
    getSchemaReadiness: () => ({
      status: "ready",
      appliedMigrations: [],
    }),
  });
  return app;
}

function seedWorkflow(
  core: SqliteCoreRepositories,
  tenantId: string,
  opts?: { clientId?: string | null; name?: string },
) {
  const workflowId = createId();
  const now = "2026-07-26T12:00:00.000Z";
  core.createWorkflow(tenantId, {
    id: workflowId,
    clientId: opts?.clientId ?? null,
    name: opts?.name ?? "Workflow",
    externalWorkflowId: `ext-${workflowId}`,
    description: null,
    monitoringMethod: "push",
    isActive: true,
    monitoringStartedAt: now,
  });
  return workflowId;
}

describe("incident list cursor", () => {
  it("round-trips and rejects garbage", () => {
    const encoded = encodeIncidentListCursor({
      updatedAt: "2026-07-26T12:00:00.000Z",
      id: "inc_abc",
    });
    expect(encoded.startsWith("v1.")).toBe(true);
    expect(decodeIncidentListCursor(encoded)).toEqual({
      updatedAt: "2026-07-26T12:00:00.000Z",
      id: "inc_abc",
    });
    expect(decodeIncidentListCursor("not-a-cursor")).toBeNull();
    expect(decodeIncidentListCursor("v1.!!!")).toBeNull();
  });
});

describe("GET /api/v1/incidents", () => {
  it("lists only the active tenant incidents and returns empty items", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const local = core.ensureSelfHostedTenant();
    const foreign = createId();
    const now = "2026-07-26T12:00:00.000Z";
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Foreign', 'saas', ?, ?)`,
      )
      .run(foreign, now, now);

    const localWorkflow = seedWorkflow(core, local.id);
    const foreignWorkflow = seedWorkflow(core, foreign);
    const localIncident = alerting.openOrObserveIncident(local.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId: localWorkflow,
      incidentType: "hard_failure",
      severity: "critical",
      summary: "local fail",
      observedAt: now,
    });
    alerting.openOrObserveIncident(foreign, {
      id: createId(),
      contractKind: "workflow",
      workflowId: foreignWorkflow,
      incidentType: "hard_failure",
      severity: "critical",
      summary: "foreign fail",
      observedAt: now,
    });

    const app = await buildTestApp(sqlite);
    const emptyBefore = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?status=resolved",
    });
    expect(emptyBefore.statusCode).toBe(200);
    expect(emptyBefore.json()).toEqual({ items: [], nextCursor: null });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/incidents",
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      items: Array<{ id: string; summary: string; tenantId: string }>;
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(localIncident.id);
    expect(body.items[0]?.summary).toBe("local fail");
    expect(body.items.every((item) => item.tenantId === local.id)).toBe(true);
    expect(body.nextCursor).toBeNull();
    await app.close();
  });

  it("retrieves by id and hides foreign tenant incidents", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const local = core.ensureSelfHostedTenant();
    const foreign = createId();
    const now = "2026-07-26T12:00:00.000Z";
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Foreign', 'saas', ?, ?)`,
      )
      .run(foreign, now, now);

    const localWorkflow = seedWorkflow(core, local.id);
    const foreignWorkflow = seedWorkflow(core, foreign);
    const localIncident = alerting.openOrObserveIncident(local.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId: localWorkflow,
      incidentType: "silent_absence",
      severity: "warning",
      summary: "local miss",
      observedAt: now,
    });
    const foreignIncident = alerting.openOrObserveIncident(foreign, {
      id: createId(),
      contractKind: "workflow",
      workflowId: foreignWorkflow,
      incidentType: "silent_absence",
      severity: "warning",
      summary: "foreign miss",
      observedAt: now,
    });

    const app = await buildTestApp(sqlite);
    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/incidents/${localIncident.id}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      incident: { id: localIncident.id, summary: "local miss" },
    });

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/incidents/${foreignIncident.id}`,
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: "not_found" });
    await app.close();
  });

  it("filters by status, severity, workflow, contract, client, and updatedAfter", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const client = core.createClient(tenant.id, {
      id: createId(),
      name: "Acme",
      slug: "acme",
      status: "protected",
      protectionStartedAt: "2026-07-01T00:00:00.000Z",
    });
    const workflowA = seedWorkflow(core, tenant.id, {
      clientId: client.id,
      name: "A",
    });
    const workflowB = seedWorkflow(core, tenant.id, { name: "B" });

    const early = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      clientId: client.id,
      contractKind: "workflow",
      workflowId: workflowA,
      incidentType: "hard_failure",
      severity: "critical",
      summary: "critical open",
      observedAt: "2026-07-26T10:00:00.000Z",
    });
    const warned = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId: workflowB,
      incidentType: "silent_absence",
      severity: "warning",
      summary: "warning open",
      observedAt: "2026-07-26T11:00:00.000Z",
    });
    const resolved = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId: workflowB,
      incidentType: "empty_result",
      severity: "warning",
      summary: "resolved empty",
      observedAt: "2026-07-26T12:00:00.000Z",
    });
    alerting.resolveIncident(tenant.id, resolved.id, {
      at: "2026-07-26T12:30:00.000Z",
    });

    const app = await buildTestApp(sqlite);

    const byStatus = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?status=open",
    });
    expect(byStatus.statusCode).toBe(200);
    const statusIds = (
      byStatus.json() as { items: Array<{ id: string }> }
    ).items.map((item) => item.id);
    expect(statusIds.sort()).toEqual([early.id, warned.id].sort());

    const bySeverity = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?severity=critical",
    });
    expect(
      (bySeverity.json() as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
    ).toEqual([early.id]);

    const byWorkflow = await app.inject({
      method: "GET",
      url: `/api/v1/incidents?workflowId=${workflowA}`,
    });
    expect(
      (byWorkflow.json() as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
    ).toEqual([early.id]);

    const byContract = await app.inject({
      method: "GET",
      url: `/api/v1/incidents?contractId=${workflowB}`,
    });
    const contractIds = (
      byContract.json() as { items: Array<{ id: string }> }
    ).items.map((item) => item.id);
    expect(contractIds.sort()).toEqual([warned.id, resolved.id].sort());

    const byClient = await app.inject({
      method: "GET",
      url: `/api/v1/incidents?clientId=${client.id}`,
    });
    expect(
      (byClient.json() as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
    ).toEqual([early.id]);

    const byUpdated = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?updatedAfter=2026-07-26T11:45:00.000Z",
    });
    expect(
      (byUpdated.json() as { items: Array<{ id: string }> }).items.map(
        (item) => item.id,
      ),
    ).toEqual([resolved.id]);

    await app.close();
  });

  it("paginates with cursors without duplicates or skips, including equal timestamps", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const workflow = seedWorkflow(core, tenant.id);
    const sharedUpdatedAt = "2026-07-26T15:00:00.000Z";

    const ids = ["inc_z", "inc_y", "inc_x", "inc_w", "inc_v"].map((id) => {
      const incident = alerting.openOrObserveIncident(tenant.id, {
        id,
        contractKind: "workflow",
        workflowId: workflow,
        // distinct types so openOrObserve does not coalesce
        incidentType:
          id === "inc_z"
            ? "hard_failure"
            : id === "inc_y"
              ? "silent_absence"
              : id === "inc_x"
                ? "empty_result"
                : id === "inc_w"
                  ? "malformed_heartbeat"
                  : "watcher_failure",
        severity: "warning",
        summary: id,
        observedAt: "2026-07-26T14:00:00.000Z",
      });
      sqlite
        .prepare(
          `UPDATE incidents SET updated_at = ? WHERE tenant_id = ? AND id = ?`,
        )
        .run(sharedUpdatedAt, tenant.id, incident.id);
      return incident.id;
    });

    // Equal updated_at → order by id DESC: inc_z, inc_y, inc_x, inc_w, inc_v
    const expectedOrder = [...ids].sort().reverse();

    const app = await buildTestApp(sqlite);
    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?limit=2",
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json() as {
      items: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(body1.items.map((item) => item.id)).toEqual(
      expectedOrder.slice(0, 2),
    );
    expect(body1.nextCursor).toBeTruthy();

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/incidents?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
    });
    const body2 = page2.json() as {
      items: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(body2.items.map((item) => item.id)).toEqual(
      expectedOrder.slice(2, 4),
    );

    const page3 = await app.inject({
      method: "GET",
      url: `/api/v1/incidents?limit=2&cursor=${encodeURIComponent(body2.nextCursor)}`,
    });
    const body3 = page3.json() as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(body3.items.map((item) => item.id)).toEqual(
      expectedOrder.slice(4, 6),
    );
    expect(body3.nextCursor).toBeNull();

    const all = [...body1.items, ...body2.items, ...body3.items].map(
      (item) => item.id,
    );
    expect(new Set(all).size).toBe(5);
    expect(all).toEqual(expectedOrder);
    await app.close();
  });

  it("returns 400 for invalid cursor, status, and limit", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    core.ensureSelfHostedTenant();
    const app = await buildTestApp(sqlite);

    const badCursor = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?cursor=not-valid",
    });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json()).toEqual({ error: "invalid_cursor" });

    const badStatus = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?status=open,nope",
    });
    expect(badStatus.statusCode).toBe(400);
    expect(badStatus.json()).toEqual({ error: "invalid_status" });

    const badLimit = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?limit=101",
    });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json()).toEqual({ error: "invalid_limit" });

    const zeroLimit = await app.inject({
      method: "GET",
      url: "/api/v1/incidents?limit=0",
    });
    expect(zeroLimit.statusCode).toBe(400);

    await app.close();
  });

  it("acknowledges recovered incidents idempotently with review metadata", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const workflow = seedWorkflow(core, tenant.id);
    const incident = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId: workflow,
      incidentType: "hard_failure",
      severity: "critical",
      summary: "to triage",
      observedAt: "2026-07-26T12:00:00.000Z",
    });

    const app = await buildTestApp(sqlite);
    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/incidents/${incident.id}/resolve`,
      payload: { actor: "ops" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      incident: {
        id: incident.id,
        lifecycleStatus: "recovered",
        acknowledgmentStatus: "unacknowledged",
      },
    });
    const ack = await app.inject({
      method: "POST",
      url: `/api/v1/incidents/${incident.id}/acknowledge`,
      payload: { actor: "forged-user", note: "Reviewed" },
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toMatchObject({
      incident: {
        id: incident.id,
        status: "resolved",
        lifecycleStatus: "recovered",
        acknowledgmentStatus: "acknowledged",
        acknowledgedBy: "api:authenticated",
        acknowledgmentNote: "Reviewed",
      },
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/incidents/${incident.id}/acknowledge`,
      payload: { actor: "other", note: "Overwrite" },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({
      incident: {
        acknowledgedBy: "api:authenticated",
        acknowledgmentNote: "Reviewed",
      },
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM notification_outbox
             WHERE incident_id = ? AND event_type = 'acknowledged'`,
          )
          .get(incident.id) as { count: number }
      ).count,
    ).toBe(1);
    await app.close();
  });

  it("acknowledges active incidents without recovering them", async () => {
    const sqlite = openDb();
    const core = new SqliteCoreRepositories(sqlite);
    const alerting = new SqliteAlertingRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const workflow = seedWorkflow(core, tenant.id);
    const incident = alerting.openOrObserveIncident(tenant.id, {
      id: createId(),
      contractKind: "workflow",
      workflowId: workflow,
      incidentType: "hard_failure",
      severity: "critical",
      summary: "active fail",
      observedAt: "2026-07-26T12:00:00.000Z",
    });

    const app = await buildTestApp(sqlite);
    const ack = await app.inject({
      method: "POST",
      url: `/api/v1/incidents/${incident.id}/acknowledge`,
      payload: { note: "On it" },
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toMatchObject({
      incident: {
        id: incident.id,
        status: "acknowledged",
        lifecycleStatus: "active",
        acknowledgmentStatus: "acknowledged",
        acknowledgedBy: "api:authenticated",
        acknowledgmentNote: "On it",
        recoveredAt: null,
        resolvedAt: null,
      },
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/incidents/${incident.id}/acknowledge`,
      payload: { note: "Overwrite" },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({
      incident: {
        acknowledgmentNote: "On it",
        lifecycleStatus: "active",
      },
    });
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM notification_outbox
             WHERE incident_id = ? AND event_type = 'acknowledged'`,
          )
          .get(incident.id) as { count: number }
      ).count,
    ).toBe(1);

    const recovered = await app.inject({
      method: "POST",
      url: `/api/v1/incidents/${incident.id}/resolve`,
      payload: {},
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      incident: {
        lifecycleStatus: "recovered",
        acknowledgmentStatus: "acknowledged",
        acknowledgedBy: "api:authenticated",
        acknowledgmentNote: "On it",
      },
    });
    await app.close();
  });
});
