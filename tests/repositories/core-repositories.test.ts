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
import { createId } from "../../src/domain/ids.js";
import { listMigrationTags } from "../../src/infrastructure/db/migrations.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openRepos(): {
  sqlite: BetterSqliteDatabase.Database;
  repos: SqliteCoreRepositories;
} {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-core-repos-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  const { sqlite } = openSqliteDatabase(filePath);
  openConnections.push(sqlite);
  migrateSqliteToLatest(sqlite);
  return { sqlite, repos: new SqliteCoreRepositories(sqlite) };
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
        // ignore Windows locks
      }
    }
  }
});

describe("core schema repositories", () => {
  it("bootstraps a single self-hosted tenant for reuse", () => {
    const { repos } = openRepos();
    const first = repos.ensureSelfHostedTenant("Local A");
    const second = repos.ensureSelfHostedTenant("Local B");
    expect(first.edition).toBe("self_hosted");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Local A");
  });

  it("scopes workflow reads to the calling tenant", () => {
    const { sqlite, repos } = openRepos();
    const now = new Date().toISOString();
    const tenantA = repos.ensureSelfHostedTenant();
    const tenantB = createId();
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Agency', 'saas', ?, ?)`,
      )
      .run(tenantB, now, now);

    const workflowA = createId();
    const workflowB = createId();
    repos.createWorkflow(tenantA.id, {
      id: workflowA,
      clientId: null,
      name: "A",
      externalWorkflowId: "ext-a",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });
    repos.createWorkflow(tenantB, {
      id: workflowB,
      clientId: null,
      name: "B",
      externalWorkflowId: "ext-b",
      description: null,
      monitoringMethod: "poll",
      isActive: true,
      monitoringStartedAt: now,
    });

    expect(repos.listWorkflows(tenantA.id).map((w) => w.id)).toEqual([
      workflowA,
    ]);
    expect(repos.getWorkflow(tenantA.id, workflowB)).toBeNull();
    expect(repos.getWorkflow(tenantB, workflowB)?.name).toBe("B");
  });

  it("registers credentials, contracts, and opaque ULID ids", () => {
    const { repos } = openRepos();
    const tenant = repos.ensureSelfHostedTenant();
    const now = new Date().toISOString();
    const workflowId = createId();
    const contractId = createId();
    const credentialId = createId();

    expect(tenant.id.length).toBeGreaterThan(10);

    repos.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "Invoices",
      externalWorkflowId: "n8n-1",
      description: "nightly",
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });

    repos.createWorkflowContract(tenant.id, {
      id: contractId,
      workflowId,
      name: "Nightly heartbeat",
      businessPurpose: "Confirm invoice sync ran",
      cadenceType: "cron",
      cadenceValue: "0 2 * * *",
      intervalMode: null,
      scheduleAnchorAt: null,
      timezone: "Europe/Berlin",
      allowedLatenessMinutes: 20,
      maxQuietWindowMinutes: null,
      initialGraceMinutes: 30,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: false,
      notificationBackoffMinutes: 240,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: now,
    });

    repos.createCredential(tenant.id, {
      id: credentialId,
      workflowId,
      keyId: "hk_test",
      encryptedSecretOrVerificationMaterial: "enc:opaque",
      status: "active",
      rotatedFromId: null,
      revokedAt: null,
    });

    expect(repos.getWorkflow(tenant.id, workflowId)?.externalWorkflowId).toBe(
      "n8n-1",
    );
  });

  it("inserts immutable heartbeat evidence with idempotency and metadata guards", () => {
    const { sqlite, repos } = openRepos();
    const tenant = repos.ensureSelfHostedTenant();
    const now = new Date().toISOString();
    const workflowId = createId();
    const eventId = createId();

    repos.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "W",
      externalWorkflowId: "ext",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });

    const inserted = repos.insertHeartbeatEvent(tenant.id, {
      id: eventId,
      workflowId,
      receivedAt: now,
      executedAt: now,
      status: "success",
      itemsProcessed: 3,
      externalExecutionRef: "exec-1",
      idempotencyKey: "idem-1",
      payloadSchemaVersion: 1,
      metadata: { trigger: "schedule" },
    });
    expect(inserted.metadataJson).toContain("schedule");

    expect(() =>
      repos.insertHeartbeatEvent(tenant.id, {
        id: createId(),
        workflowId,
        receivedAt: now,
        executedAt: now,
        status: "success",
        itemsProcessed: 1,
        externalExecutionRef: null,
        idempotencyKey: "idem-1",
        payloadSchemaVersion: 1,
      }),
    ).toThrow();

    expect(() =>
      repos.insertHeartbeatEvent(tenant.id, {
        id: createId(),
        workflowId,
        receivedAt: now,
        executedAt: now,
        status: "success",
        itemsProcessed: 1,
        externalExecutionRef: null,
        idempotencyKey: "idem-2",
        payloadSchemaVersion: 1,
        metadata: { api_key: "secret" },
      }),
    ).toThrow(/secret/i);

    expect(() =>
      sqlite
        .prepare(`UPDATE heartbeat_events SET status = 'failure' WHERE id = ?`)
        .run(eventId),
    ).toThrow(/immutable/);

    expect(
      repos.getHeartbeatByIdempotencyKey(tenant.id, workflowId, "idem-1")?.id,
    ).toBe(eventId);
  });

  it("stores healthy health with basic evidence independently", () => {
    const { repos } = openRepos();
    const tenant = repos.ensureSelfHostedTenant();
    const now = new Date().toISOString();
    const workflowId = createId();

    repos.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "W",
      externalWorkflowId: "ext",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: now,
    });

    repos.upsertWorkflowState(tenant.id, {
      tenantId: tenant.id,
      workflowId,
      lastExecutionAt: now,
      lastNonemptySuccessAt: now,
      lastAcceptableSuccessAt: now,
      lastFailureAt: null,
      lastExternalExecutionRef: "exec-1",
      lastStatus: "success",
      nextExpectedAt: null,
      overdueSince: null,
      currentHealth: "healthy",
      evidenceLevel: "basic",
      evidenceSummaryCode: "heartbeat_only",
      unverifiedDimensionsJson: JSON.stringify([
        "destination_delivery_not_checked",
      ]),
      consecutiveStaleChecks: 0,
      updatedAt: now,
    });

    const state = repos.getWorkflowState(tenant.id, workflowId);
    expect(state).toMatchObject({
      currentHealth: "healthy",
      evidenceLevel: "basic",
    });
  });

  it("includes core schema migrations through credentials and heartbeat state", () => {
    const tags = listMigrationTags("sqlite");
    expect(tags).toEqual(
      expect.arrayContaining([
        "0001_tenants_clients",
        "0002_workflows_contracts",
        "0003_credentials_heartbeats_state",
      ]),
    );
  });
});
