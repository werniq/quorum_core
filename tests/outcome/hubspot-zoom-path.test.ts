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
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { buildApp } from "../../src/infrastructure/http/app.js";
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import { SqliteOutcomeConnectorRepositories } from "../../src/infrastructure/db/repositories/sqlite-outcome-connector-repositories.js";
import { SqliteOutcomeContractRepositories } from "../../src/infrastructure/db/repositories/sqlite-outcome-contract-repositories.js";
import { FIRST_SUPPORTED_PATH } from "../../src/domain/outcome/types.js";
import { queryContractCatalog } from "../../src/infrastructure/catalog/query-catalog.js";
import { createReconciliationRunner } from "../../src/infrastructure/connectors/run-reconciliation.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-outcome-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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

function mockFetch(
  sequence: Array<{ urlIncludes: string; body: unknown; status?: number }>,
): typeof fetch {
  return async (input) => {
    const url = String(input);
    const next = sequence.find((entry) => url.includes(entry.urlIncludes));
    if (!next) {
      return new Response(JSON.stringify({ error: "unexpected", url }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("HubSpot→Zoom outcome path", () => {
  it("reconciles registrations, stores hashes only, elevates high evidence, and stops after revoke", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const connectors = new SqliteOutcomeConnectorRepositories(sqlite);
    const contracts = new SqliteOutcomeContractRepositories(sqlite);
    const nowIso = clock.now().toISOString();

    const source = connectors.create(tenant.id, {
      provider: "hubspot",
      connectorType: "source",
      name: "HubSpot webinars",
      encryptedCredentials: encryptCredentialSecret(
        JSON.stringify({ accessToken: "hs-token" }),
        KEK,
      ),
      status: "active",
      nowIso,
    });
    const destination = connectors.create(tenant.id, {
      provider: "zoom",
      connectorType: "destination",
      name: "Zoom webinars",
      encryptedCredentials: encryptCredentialSecret(
        JSON.stringify({
          accountId: "acct",
          clientId: "cid",
          clientSecret: "csecret",
        }),
        KEK,
      ),
      status: "active",
      nowIso,
    });

    const contract = contracts.create(tenant.id, {
      clientId: null,
      name: "Webinar delivery",
      businessPurpose: "HubSpot registrations reach Zoom",
      contractType: "reconciliation",
      sourceConnectorId: source.id,
      destinationConnectorId: destination.id,
      sourceObjectType: FIRST_SUPPORTED_PATH.sourceObjectType,
      destinationObjectType: FIRST_SUPPORTED_PATH.destinationObjectType,
      matchKeyDefinition: {
        strategy: "normalized_email",
        sourceField: "email",
        destinationField: "email",
        sourceObjectId: "evt-1",
        destinationObjectId: "wb-9",
      },
      sourceTimeField: "registeredAt",
      destinationTimeField: "create_time",
      maximumDeliveryDelayMinutes: 5,
      acceptableMissingCount: 0,
      acceptableMissingPercentage: 0,
      scheduleExpression: "0 * * * *",
      timezone: "UTC",
      evidenceLevelTarget: "high",
      retentionDays: 30,
      nowIso,
      explicitlyConfirmed: true,
    });
    contracts.activate(tenant.id, contract.id, nowIso, true);

    const fetchImpl = mockFetch([
      {
        urlIncludes: "oauth/token",
        body: { access_token: "zoom-access" },
      },
      {
        urlIncludes: "marketing-events",
        body: {
          results: [
            {
              id: "r1",
              email: "alpha@example.com",
              registeredAt: "2026-07-19T11:10:00.000Z",
            },
            {
              id: "r2",
              email: "missing@example.com",
              registeredAt: "2026-07-19T11:20:00.000Z",
            },
          ],
        },
      },
      {
        urlIncludes: "api.zoom.us",
        body: {
          registrants: [
            {
              id: "z1",
              email: "alpha@example.com",
              create_time: "2026-07-19T11:12:00.000Z",
            },
          ],
        },
      },
    ]);

    const runner = createReconciliationRunner({
      sqlite,
      clock,
      kek: KEK,
      identifierHmacKey: "test-identifier-hmac-key-32chars!!",
      http: {
        connectTimeoutMs: 1000,
        readTimeoutMs: 1000,
        maxResponseBytes: 1_000_000,
        maxRedirects: 0,
        fetchImpl,
        resolveAddresses: async () => ["93.184.216.34"],
      },
    });

    const run = await runner.runWindow({
      tenantId: tenant.id,
      outcomeContractId: contract.id,
      windowStart: new Date("2026-07-19T11:00:00.000Z"),
      windowEnd: new Date("2026-07-19T12:00:00.000Z"),
    });

    expect(run.status).toBe("failed");
    expect(run.matchedCount).toBe(1);
    expect(run.missingCount).toBe(1);
    expect(run.evidenceLevelAchieved).toBe("medium");

    const items = sqlite
      .prepare(
        `SELECT source_identifier_hash, match_status, metadata_json_sanitized
         FROM reconciliation_items WHERE reconciliation_run_id = ?`,
      )
      .all(run.id) as Array<{
      source_identifier_hash: string;
      match_status: string;
      metadata_json_sanitized: string;
    }>;
    expect(items.length).toBe(2);
    expect(items.every((i) => !i.metadata_json_sanitized.includes("@"))).toBe(
      true,
    );
    expect(items.some((i) => i.match_status === "missing")).toBe(true);

    // Perfect match run elevates high
    const fetchPerfect = mockFetch([
      { urlIncludes: "oauth/token", body: { access_token: "zoom-access" } },
      {
        urlIncludes: "marketing-events",
        body: {
          results: [
            {
              id: "r1",
              email: "alpha@example.com",
              registeredAt: "2026-07-19T11:10:00.000Z",
            },
          ],
        },
      },
      {
        urlIncludes: "api.zoom.us",
        body: {
          registrants: [
            {
              id: "z1",
              email: "alpha@example.com",
              create_time: "2026-07-19T11:12:00.000Z",
            },
          ],
        },
      },
    ]);
    const runner2 = createReconciliationRunner({
      sqlite,
      clock,
      kek: KEK,
      identifierHmacKey: "test-identifier-hmac-key-32chars!!",
      http: {
        connectTimeoutMs: 1000,
        readTimeoutMs: 1000,
        maxResponseBytes: 1_000_000,
        maxRedirects: 0,
        fetchImpl: fetchPerfect,
        resolveAddresses: async () => ["93.184.216.34"],
      },
    });
    const healthy = await runner2.runWindow({
      tenantId: tenant.id,
      outcomeContractId: contract.id,
      windowStart: new Date("2026-07-19T11:00:00.000Z"),
      windowEnd: new Date("2026-07-19T12:00:00.000Z"),
      force: true,
    });
    expect(healthy.status).toBe("healthy");
    expect(healthy.evidenceLevelAchieved).toBe("high");

    const catalog = queryContractCatalog({
      sqlite,
      clock,
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    const outcomeRow = catalog.find((r) => r.contractKind === "outcome");
    expect(outcomeRow?.evidenceLevel).toBe("high");
    expect(outcomeRow?.unverifiedDimensions).not.toContain(
      "destination_delivery_not_checked",
    );

    connectors.revoke(tenant.id, source.id, clock.now().toISOString());
    await expect(
      runner2.runWindow({
        tenantId: tenant.id,
        outcomeContractId: contract.id,
        windowStart: new Date("2026-07-19T11:00:00.000Z"),
        windowEnd: new Date("2026-07-19T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/revoked|unreadable/);

    const catalogAfter = queryContractCatalog({
      sqlite,
      clock,
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    const stale = catalogAfter.find((r) => r.contractKind === "outcome");
    expect(stale?.evidenceLevel).toBe("basic");
  });

  it("exposes outcome APIs and keeps heartbeat contracts basic when no outcome path", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const workflowId = createId();
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "Other n8n flow",
      externalWorkflowId: "n8n-x",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: clock.now().toISOString(),
    });
    core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId,
      name: "HB",
      businessPurpose: "Unverified destination path",
      cadenceType: "event_driven",
      cadenceValue: "event",
      intervalMode: null,
      scheduleAnchorAt: null,
      timezone: null,
      allowedLatenessMinutes: 0,
      maxQuietWindowMinutes: 60,
      initialGraceMinutes: 5,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 30,
      evidenceLevel: "high",
      schemaVersion: 1,
      isActive: true,
      activatedAt: clock.now().toISOString(),
    });

    const app = await buildApp({
      env: loadEnv({ NODE_ENV: "test", QUORUM_CREDENTIAL_KEK: KEK }),
      clock,
      sqlite,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0008_outcome_connectors_reconciliation"],
      }),
    });

    const supported = await app.inject({
      method: "GET",
      url: "/api/v1/outcome/supported-path",
      headers: { "x-quorum-tenant-id": tenant.id },
    });
    expect(supported.statusCode).toBe(200);
    expect(supported.json()).toMatchObject({
      path: { id: FIRST_SUPPORTED_PATH.id },
    });

    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/catalog/contracts",
      headers: { "x-quorum-tenant-id": tenant.id },
    });
    const body = catalog.json() as {
      contracts: Array<{ contractKind: string; evidenceLevel: string }>;
    };
    const heartbeat = body.contracts.find((c) => c.contractKind === "workflow");
    expect(heartbeat?.evidenceLevel).toBe("basic");

    await app.close();
  });

  it("persists waiting match_status during delivery delay (not ignored)", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const connectors = new SqliteOutcomeConnectorRepositories(sqlite);
    const contracts = new SqliteOutcomeContractRepositories(sqlite);
    const nowIso = clock.now().toISOString();

    const source = connectors.create(tenant.id, {
      provider: "hubspot",
      connectorType: "source",
      name: "HubSpot webinars",
      encryptedCredentials: encryptCredentialSecret(
        JSON.stringify({ accessToken: "hs-token" }),
        KEK,
      ),
      status: "active",
      nowIso,
    });
    const destination = connectors.create(tenant.id, {
      provider: "zoom",
      connectorType: "destination",
      name: "Zoom webinars",
      encryptedCredentials: encryptCredentialSecret(
        JSON.stringify({
          accountId: "acct",
          clientId: "cid",
          clientSecret: "csecret",
        }),
        KEK,
      ),
      status: "active",
      nowIso,
    });

    const contract = contracts.create(tenant.id, {
      clientId: null,
      name: "Webinar delivery",
      businessPurpose: "HubSpot registrations reach Zoom",
      contractType: "reconciliation",
      sourceConnectorId: source.id,
      destinationConnectorId: destination.id,
      sourceObjectType: FIRST_SUPPORTED_PATH.sourceObjectType,
      destinationObjectType: FIRST_SUPPORTED_PATH.destinationObjectType,
      matchKeyDefinition: {
        strategy: "normalized_email",
        sourceField: "email",
        destinationField: "email",
        sourceObjectId: "evt-wait",
        destinationObjectId: "wb-wait",
      },
      sourceTimeField: "registeredAt",
      destinationTimeField: "create_time",
      maximumDeliveryDelayMinutes: 5,
      acceptableMissingCount: 0,
      acceptableMissingPercentage: 0,
      scheduleExpression: "0 * * * *",
      timezone: "UTC",
      evidenceLevelTarget: "high",
      retentionDays: 30,
      nowIso,
      explicitlyConfirmed: true,
    });
    contracts.activate(tenant.id, contract.id, nowIso, true);

    // Source observed 2 minutes ago — still inside the 5-minute delay window
    const fetchImpl = mockFetch([
      { urlIncludes: "oauth/token", body: { access_token: "zoom-access" } },
      {
        urlIncludes: "marketing-events",
        body: {
          results: [
            {
              id: "r-wait",
              email: "pending@example.com",
              registeredAt: "2026-07-19T11:58:00.000Z",
            },
          ],
        },
      },
      {
        urlIncludes: "api.zoom.us",
        body: { registrants: [] },
      },
    ]);

    const runner = createReconciliationRunner({
      sqlite,
      clock,
      kek: KEK,
      identifierHmacKey: "test-identifier-hmac-key-32chars!!",
      http: {
        connectTimeoutMs: 1000,
        readTimeoutMs: 1000,
        maxResponseBytes: 1_000_000,
        maxRedirects: 0,
        fetchImpl,
        resolveAddresses: async () => ["93.184.216.34"],
      },
    });

    const run = await runner.runWindow({
      tenantId: tenant.id,
      outcomeContractId: contract.id,
      windowStart: new Date("2026-07-19T11:00:00.000Z"),
      windowEnd: new Date("2026-07-19T12:00:00.000Z"),
    });

    expect(run.status).toBe("warning");
    expect(run.missingCount).toBe(0);

    const items = sqlite
      .prepare(
        `SELECT match_status FROM reconciliation_items WHERE reconciliation_run_id = ?`,
      )
      .all(run.id) as Array<{ match_status: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.match_status).toBe("waiting");
    expect(items.every((i) => i.match_status !== "ignored")).toBe(true);

    const details = JSON.parse(
      String(
        (
          sqlite
            .prepare(
              `SELECT details_location_or_json FROM reconciliation_runs WHERE id = ?`,
            )
            .get(run.id) as { details_location_or_json: string }
        ).details_location_or_json,
      ),
    ) as { waitingCount?: number };
    expect(details.waitingCount).toBe(1);
  });
});
