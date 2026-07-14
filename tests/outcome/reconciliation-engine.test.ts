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
import { encryptCredentialSecret } from "../../src/infrastructure/security/credential-secrets.js";
import { SqliteOutcomeConnectorRepositories } from "../../src/infrastructure/db/repositories/sqlite-outcome-connector-repositories.js";
import { SqliteOutcomeContractRepositories } from "../../src/infrastructure/db/repositories/sqlite-outcome-contract-repositories.js";
import { FIRST_SUPPORTED_PATH } from "../../src/domain/outcome/types.js";
import { createReconciliationRunner } from "../../src/infrastructure/connectors/run-reconciliation.js";
import { queryContractCatalog } from "../../src/infrastructure/catalog/query-catalog.js";
import { SqliteAlertingRepositories } from "../../src/infrastructure/db/repositories/sqlite-alerting-repositories.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import { buildApp } from "../../src/infrastructure/http/app.js";
import {
  buildHeartbeatSigningPayload,
  sha256Hex,
  signHeartbeatHmacSha256,
} from "../../src/infrastructure/security/heartbeat-hmac.js";
import { createIngestHeartbeatHandler } from "../../src/infrastructure/ingestion/ingest-heartbeat.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];
const KEK = "quorum-test-credential-kek";

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-recon-eng-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
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
        if (fs.existsSync(`${filePath}${suffix}`)) {
          fs.unlinkSync(`${filePath}${suffix}`);
        }
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

describe("reconciliation engine integration", () => {
  it("detects missing destinations while heartbeat stays healthy/basic, exports hashes, resolves on recovery", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const tenant = core.ensureSelfHostedTenant();
    const alerting = new SqliteAlertingRepositories(sqlite);
    const connectors = new SqliteOutcomeConnectorRepositories(sqlite);
    const contracts = new SqliteOutcomeContractRepositories(sqlite);
    const nowIso = clock.now().toISOString();

    // Green n8n heartbeat path
    const workflowId = createId();
    const secret = "hb-secret-value-xxxxxxxxxxxx";
    core.createWorkflow(tenant.id, {
      id: workflowId,
      clientId: null,
      name: "Lead routing workflow",
      externalWorkflowId: "n8n-green",
      description: null,
      monitoringMethod: "push",
      isActive: true,
      monitoringStartedAt: nowIso,
    });
    core.createWorkflowContract(tenant.id, {
      id: createId(),
      workflowId,
      name: "HB",
      businessPurpose: "Lead routing workflow",
      cadenceType: "event_driven",
      cadenceValue: "event",
      intervalMode: null,
      scheduleAnchorAt: null,
      timezone: null,
      allowedLatenessMinutes: 0,
      maxQuietWindowMinutes: 120,
      initialGraceMinutes: 5,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 30,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: true,
      activatedAt: nowIso,
    });
    const keyId = "hk1";
    core.createCredential(tenant.id, {
      id: createId(),
      workflowId,
      keyId,
      encryptedSecretOrVerificationMaterial: encryptCredentialSecret(
        secret,
        KEK,
      ),
      status: "active",
      rotatedFromId: null,
      revokedAt: null,
    });
    const env = loadEnv({ NODE_ENV: "test", QUORUM_CREDENTIAL_KEK: KEK });
    const ingest = createIngestHeartbeatHandler({
      sqlite,
      env,
      clock,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0009"],
      }),
    });
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: nowIso,
        status: "success",
        itemsProcessed: 2,
        externalExecutionRef: "exec-green",
      }),
    );
    const ts = Math.floor(clock.now().getTime() / 1000);
    const pathName = `/api/v1/workflows/${workflowId}/heartbeats`;
    const sig = signHeartbeatHmacSha256(
      secret,
      buildHeartbeatSigningPayload({
        method: "POST",
        path: pathName,
        timestampSeconds: String(ts),
        idempotencyKey: "idem-green",
        bodySha256Hex: sha256Hex(body),
      }),
    );
    expect(
      ingest({
        workflowId,
        method: "POST",
        path: pathName,
        keyId,
        timestampSeconds: String(ts),
        idempotencyKey: "idem-green",
        signatureHex: sig,
        rawBody: body,
      }).status,
    ).toBe("accepted");

    const source = connectors.create(tenant.id, {
      provider: "hubspot",
      connectorType: "source",
      name: "HS",
      encryptedCredentials: encryptCredentialSecret(
        JSON.stringify({ accessToken: "t" }),
        KEK,
      ),
      status: "active",
      nowIso,
    });
    const destination = connectors.create(tenant.id, {
      provider: "zoom",
      connectorType: "destination",
      name: "Zoom",
      encryptedCredentials: encryptCredentialSecret(
        JSON.stringify({
          accountId: "a",
          clientId: "c",
          clientSecret: "s",
        }),
        KEK,
      ),
      status: "active",
      nowIso,
    });
    const contract = contracts.create(tenant.id, {
      clientId: null,
      name: "Webinar delivery",
      businessPurpose: "HubSpot webinar → Zoom registrants",
      contractType: "reconciliation",
      sourceConnectorId: source.id,
      destinationConnectorId: destination.id,
      sourceObjectType: FIRST_SUPPORTED_PATH.sourceObjectType,
      destinationObjectType: FIRST_SUPPORTED_PATH.destinationObjectType,
      matchKeyDefinition: {
        strategy: "normalized_email",
        sourceField: "email",
        destinationField: "email",
        sourceObjectId: "evt",
        destinationObjectId: "wb",
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

    const fetchMissing = mockFetch([
      { urlIncludes: "oauth/token", body: { access_token: "z" } },
      {
        urlIncludes: "marketing-events",
        body: {
          results: [
            {
              id: "1",
              email: "a@ex.com",
              registeredAt: "2026-07-19T11:00:00.000Z",
            },
            {
              id: "2",
              email: "b@ex.com",
              registeredAt: "2026-07-19T11:00:00.000Z",
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
              email: "a@ex.com",
              create_time: "2026-07-19T11:01:00.000Z",
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
        fetchImpl: fetchMissing,
        resolveAddresses: async () => ["93.184.216.34"],
      },
    });

    const windowStart = new Date("2026-07-19T10:00:00.000Z");
    const windowEnd = new Date("2026-07-19T12:00:00.000Z");
    const run1 = await runner.runWindow({
      tenantId: tenant.id,
      outcomeContractId: contract.id,
      windowStart,
      windowEnd,
    });
    expect(run1.missingCount).toBe(1);
    expect(run1.evidenceLevelAchieved).toBe("medium");

    const incident = alerting.getUnresolvedIncident(
      tenant.id,
      "outcome",
      contract.id,
      "partial_delivery",
    );
    expect(incident).toBeTruthy();
    expect(incident?.summary).toMatch(/missing/i);

    // Idempotent re-run does not create a second outbox spam row for same window
    const outboxBefore = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM notification_outbox WHERE tenant_id = ?`,
      )
      .get(tenant.id) as { c: number };
    const again = await runner.runWindow({
      tenantId: tenant.id,
      outcomeContractId: contract.id,
      windowStart,
      windowEnd,
    });
    expect(again.id).toBe(run1.id);
    const outboxAfter = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM notification_outbox WHERE tenant_id = ?`,
      )
      .get(tenant.id) as { c: number };
    expect(outboxAfter.c).toBe(outboxBefore.c);

    const catalog = queryContractCatalog({
      sqlite,
      clock,
      tenantId: tenant.id,
      publicBaseUrl: "http://127.0.0.1:3000",
    });
    const hb = catalog.find((r) => r.contractKind === "workflow");
    const oc = catalog.find((r) => r.contractKind === "outcome");
    expect(hb?.evidenceLevel).toBe("basic");
    expect(hb?.health).toBe("healthy");
    expect(oc?.missingCount).toBe(1);
    expect(oc?.sourceCount).toBe(2);

    const app = await buildApp({
      env,
      clock,
      sqlite,
      outcomeHttp: {
        connectTimeoutMs: 1000,
        readTimeoutMs: 1000,
        maxResponseBytes: 1_000_000,
        maxRedirects: 0,
        fetchImpl: fetchMissing,
        resolveAddresses: async () => ["93.184.216.34"],
      },
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0009"],
      }),
    });
    const exportRes = await app.inject({
      method: "POST",
      url: `/api/v1/outcome/contracts/${contract.id}/exports`,
      headers: { "x-quorum-tenant-id": tenant.id },
      payload: { runId: run1.id },
    });
    expect(exportRes.statusCode).toBe(201);
    const token = (exportRes.json() as { token: string }).token;
    const exported = await app.inject({
      method: "GET",
      url: `/api/v1/outcome/exports/${token}`,
    });
    expect(exported.statusCode).toBe(200);
    const hashes = (
      exported.json() as { missingSourceIdentifierHashes: string[] }
    ).missingSourceIdentifierHashes;
    expect(hashes.length).toBe(1);
    expect(hashes[0]).toHaveLength(64);

    // Recovery: destination catches up
    const fetchRecovered = mockFetch([
      { urlIncludes: "oauth/token", body: { access_token: "z" } },
      {
        urlIncludes: "marketing-events",
        body: {
          results: [
            {
              id: "1",
              email: "a@ex.com",
              registeredAt: "2026-07-19T11:00:00.000Z",
            },
            {
              id: "2",
              email: "b@ex.com",
              registeredAt: "2026-07-19T11:00:00.000Z",
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
              email: "a@ex.com",
              create_time: "2026-07-19T11:01:00.000Z",
            },
            {
              id: "z2",
              email: "b@ex.com",
              create_time: "2026-07-19T11:02:00.000Z",
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
        fetchImpl: fetchRecovered,
        resolveAddresses: async () => ["93.184.216.34"],
      },
    });
    const recovered = await runner2.runWindow({
      tenantId: tenant.id,
      outcomeContractId: contract.id,
      windowStart,
      windowEnd,
      force: true,
    });
    expect(recovered.status).toBe("healthy");
    expect(recovered.evidenceLevelAchieved).toBe("high");
    expect(
      alerting.getUnresolvedIncident(
        tenant.id,
        "outcome",
        contract.id,
        "partial_delivery",
      ),
    ).toBeNull();

    await app.close();
  });
});
