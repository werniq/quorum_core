import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { SqliteN8nConnectorRepositories } from "../../src/infrastructure/db/repositories/sqlite-n8n-connector-repositories.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import { createIngestPolledEvidenceHandler } from "../../src/infrastructure/ingestion/ingest-polled-evidence.js";
import { createN8nPollingAdapter } from "../../src/infrastructure/n8n/poll-workflow.js";
import { createN8nPollScheduler } from "../../src/infrastructure/n8n/run-poll-scheduler.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";
const API_KEY = "n8n-test-api-key-value-xyz";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-poll-sched-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function seedPollWorkflow(
  sqlite: BetterSqliteDatabase.Database,
  options?: {
    connectorStatus?: "active" | "disabled";
    pollIntervalMs?: number;
  },
) {
  const core = new SqliteCoreRepositories(sqlite);
  const connectors = new SqliteN8nConnectorRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
  const now = clock.now().toISOString();
  const workflowId = createId();

  const connector = connectors.createConnector(tenant.id, {
    name: "Prod n8n",
    baseUrl: "https://n8n.example.com",
    encryptedApiKey: encryptCredentialSecret(API_KEY, KEK),
    status: options?.connectorStatus ?? "active",
    pollIntervalMs: options?.pollIntervalMs ?? 60_000,
    nowIso: now,
  });

  core.createWorkflow(tenant.id, {
    id: workflowId,
    clientId: null,
    name: "Invoices",
    externalWorkflowId: "wf-ext-1",
    description: null,
    monitoringMethod: "poll",
    isActive: true,
    monitoringStartedAt: now,
  });
  connectors.bindWorkflowConnector(tenant.id, workflowId, connector.id);

  core.createWorkflowContract(tenant.id, {
    id: createId(),
    workflowId,
    name: "Heartbeat",
    businessPurpose: "Invoice sync",
    cadenceType: "event_driven",
    cadenceValue: "event",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: null,
    allowedLatenessMinutes: 0,
    maxQuietWindowMinutes: 60,
    initialGraceMinutes: 0,
    emptyResultPolicy: "allowed",
    countLessSuccessAllowed: true,
    notificationBackoffMinutes: 240,
    evidenceLevel: "basic",
    schemaVersion: 1,
    isActive: true,
    activatedAt: now,
  });

  const ingestPolledEvidence = createIngestPolledEvidenceHandler({
    sqlite,
    clock,
    getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
  });

  function createAdapter(fetchImpl: typeof fetch) {
    return createN8nPollingAdapter({
      sqlite,
      clock,
      kek: KEK,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      ingestPolledEvidence,
      httpOptions: {
        connectTimeoutMs: 1_000,
        readTimeoutMs: 1_000,
        maxResponseBytes: 65_536,
        maxRedirects: 2,
        resolveAddresses: async () => ["203.0.113.50"],
        fetchImpl,
      },
    });
  }

  return {
    tenant,
    workflowId,
    connector,
    connectors,
    clock,
    createAdapter,
  };
}

describe("n8n poll scheduler", () => {
  it("polls after tick when connector is active", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    const pollWorkflow = vi.fn(async () => ({
      status: "polled" as const,
      ingested: 1,
      skipped: 0,
      replays: 0,
    }));

    const scheduler = createN8nPollScheduler({
      sqlite,
      clock: seeded.clock,
      claimOwner: "owner-a",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      pollWorkflow,
    });

    const result = await scheduler.runTick();
    expect(result.claimed).toBe(1);
    expect(result.polled).toBe(1);
    expect(pollWorkflow).toHaveBeenCalledWith({
      tenantId: seeded.tenant.id,
      workflowId: seeded.workflowId,
    });
    expect(scheduler.getRunState().lastSuccessAt).not.toBeNull();
    expect(scheduler.getRunState().lastTickAt).not.toBeNull();
  });

  it("skips disabled connectors", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite, { connectorStatus: "disabled" });
    const pollWorkflow = vi.fn(async () => ({
      status: "polled" as const,
      ingested: 0,
      skipped: 0,
      replays: 0,
    }));

    const scheduler = createN8nPollScheduler({
      sqlite,
      clock: seeded.clock,
      claimOwner: "owner-a",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      pollWorkflow,
    });

    const result = await scheduler.runTick();
    expect(result.considered).toBe(0);
    expect(result.claimed).toBe(0);
    expect(pollWorkflow).not.toHaveBeenCalled();
  });

  it("prevents a second claim owner while the first holds the claim", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    const now = seeded.clock.now().toISOString();
    const expires = new Date(
      seeded.clock.now().getTime() + 55_000,
    ).toISOString();

    expect(
      seeded.connectors.tryClaimPoll(
        seeded.tenant.id,
        seeded.workflowId,
        "owner-1",
        now,
        expires,
      ),
    ).toBe(true);

    expect(
      seeded.connectors.tryClaimPoll(
        seeded.tenant.id,
        seeded.workflowId,
        "owner-2",
        now,
        expires,
      ),
    ).toBe(false);

    const pollWorkflow = vi.fn(async () => ({
      status: "polled" as const,
      ingested: 0,
      skipped: 0,
      replays: 0,
    }));
    const scheduler = createN8nPollScheduler({
      sqlite,
      clock: seeded.clock,
      claimOwner: "owner-2",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      pollWorkflow,
    });

    const result = await scheduler.runTick();
    expect(result.claimed).toBe(0);
    expect(pollWorkflow).not.toHaveBeenCalled();
  });

  it("preserves checkpoints across scheduler ticks", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    const payload = {
      data: [
        {
          id: 5,
          finished: true,
          status: "success",
          stoppedAt: "2026-07-19T11:00:00.000Z",
          workflowId: "wf-ext-1",
        },
      ],
    };
    const adapter = seeded.createAdapter(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const scheduler = createN8nPollScheduler({
      sqlite,
      clock: seeded.clock,
      claimOwner: "owner-a",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      pollWorkflow: adapter.pollWorkflow,
    });

    await scheduler.runTick();
    const checkpoint = seeded.connectors.getCheckpoint(
      seeded.tenant.id,
      seeded.workflowId,
    );
    expect(checkpoint?.lastSeenExecutionId).toBe("5");

    // Advance past poll interval so a second tick can claim again.
    const later = new FixedClock(new Date("2026-07-19T12:02:00.000Z"));
    const second = createN8nPollScheduler({
      sqlite,
      clock: later,
      claimOwner: "owner-a",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      pollWorkflow: adapter.pollWorkflow,
    });
    await second.runTick();

    const after = seeded.connectors.getCheckpoint(
      seeded.tenant.id,
      seeded.workflowId,
    );
    expect(after?.lastSeenExecutionId).toBe("5");
    expect(
      (
        sqlite
          .prepare(
            `SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ?`,
          )
          .get(seeded.workflowId) as { c: number }
      ).c,
    ).toBe(1);
  });

  it("does not retry forever when connector health is auth_failed", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    seeded.connectors.updateConnectorHealth(
      seeded.tenant.id,
      seeded.connector.id,
      {
        health: "auth_failed",
        checkedAtIso: seeded.clock.now().toISOString(),
        errorCode: "auth_failed",
        errorSummary: "unauthorized",
      },
    );

    const pollWorkflow = vi.fn(async () => ({
      status: "polled" as const,
      ingested: 0,
      skipped: 0,
      replays: 0,
    }));

    const scheduler = createN8nPollScheduler({
      sqlite,
      clock: seeded.clock,
      claimOwner: "owner-a",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      pollWorkflow,
    });

    const first = await scheduler.runTick();
    const second = await scheduler.runTick();
    expect(first.claimed).toBe(0);
    expect(second.claimed).toBe(0);
    expect(pollWorkflow).not.toHaveBeenCalled();
  });

  it("stop() prevents starting new poll work", async () => {
    const sqlite = openDb();
    const seeded = seedPollWorkflow(sqlite);
    const pollWorkflow = vi.fn(async () => ({
      status: "polled" as const,
      ingested: 0,
      skipped: 0,
      replays: 0,
    }));

    const scheduler = createN8nPollScheduler({
      sqlite,
      clock: seeded.clock,
      claimOwner: "owner-a",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      pollWorkflow,
    });

    scheduler.stop();
    const result = await scheduler.runTick();
    expect(result).toEqual({
      considered: 0,
      claimed: 0,
      polled: 0,
      skipped: 0,
      failed: 0,
    });
    expect(pollWorkflow).not.toHaveBeenCalled();
  });
});
