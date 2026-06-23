import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import type { Clock } from "../../../domain/clock.js";
import { createId } from "../../../domain/ids.js";
import { FIRST_SUPPORTED_PATH } from "../../../domain/outcome/types.js";
import { encryptCredentialSecret } from "../../security/credential-secrets.js";
import { SqliteOutcomeConnectorRepositories } from "../../db/repositories/sqlite-outcome-connector-repositories.js";
import { SqliteOutcomeContractRepositories } from "../../db/repositories/sqlite-outcome-contract-repositories.js";
import { SqliteOpsAuditRepositories } from "../../db/repositories/sqlite-ops-audit-repositories.js";
import { SqliteReconciliationRepositories } from "../../db/repositories/sqlite-reconciliation-repositories.js";
import { SqliteAuthRepositories } from "../../db/repositories/sqlite-auth-repositories.js";
import {
  ConnectorRevokedError,
  createReconciliationRunner,
} from "../../connectors/run-reconciliation.js";
import type { QuorumEnv } from "../../config/env.js";
import type { SecureOutboundHttpOptions } from "../../security/secure-outbound-http.js";
import {
  generateOpaqueToken,
  hashToken,
} from "../../../domain/auth/passwords.js";
import { resolveIdentifierHmacKey } from "../../security/identifier-hmac.js";
import { parseCookieHeader, SESSION_COOKIE } from "../cookies.js";

function tryActorUserId(
  request: FastifyRequest,
  auth: SqliteAuthRepositories,
  now: Date,
): string | null {
  const cookies = parseCookieHeader(
    typeof request.headers.cookie === "string"
      ? request.headers.cookie
      : undefined,
  );
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) {
    return null;
  }
  return auth.getSession(sessionId, now)?.adminUserId ?? null;
}

export function registerOutcomeRoutes(
  app: FastifyInstance,
  deps: {
    sqlite: Database.Database;
    clock: Clock;
    env: QuorumEnv;
    http?: SecureOutboundHttpOptions;
    resolveTenantId: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => string | null;
  },
): void {
  const connectors = new SqliteOutcomeConnectorRepositories(deps.sqlite);
  const contracts = new SqliteOutcomeContractRepositories(deps.sqlite);
  const runs = new SqliteReconciliationRepositories(deps.sqlite);
  const opsAudit = new SqliteOpsAuditRepositories(deps.sqlite);
  const auth = new SqliteAuthRepositories(deps.sqlite);
  const http: SecureOutboundHttpOptions = deps.http ?? {
    connectTimeoutMs: deps.env.N8N_CONNECTOR_CONNECT_TIMEOUT_MS,
    readTimeoutMs: deps.env.N8N_CONNECTOR_READ_TIMEOUT_MS,
    maxResponseBytes: deps.env.N8N_CONNECTOR_MAX_RESPONSE_BYTES,
    maxRedirects: deps.env.N8N_CONNECTOR_MAX_REDIRECTS,
  };
  const runner = createReconciliationRunner({
    sqlite: deps.sqlite,
    clock: deps.clock,
    kek: deps.env.QUORUM_CREDENTIAL_KEK,
    identifierHmacKey: resolveIdentifierHmacKey(deps.env),
    http,
  });

  app.get("/api/v1/outcome/supported-path", async () => ({
    path: FIRST_SUPPORTED_PATH,
    note: "Unsupported workflows remain basic evidence until a validated path exists.",
  }));

  app.post("/api/v1/outcome/connectors", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const body = request.body as {
      provider?: "hubspot" | "zoom";
      connectorType?: "source" | "destination";
      name?: string;
      credentials?: Record<string, string>;
      clientId?: string | null;
    };
    if (
      !body.provider ||
      !body.connectorType ||
      !body.name ||
      !body.credentials
    ) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    if (body.provider === "hubspot" && body.connectorType !== "source") {
      return reply.code(400).send({ error: "hubspot_must_be_source" });
    }
    if (body.provider === "zoom" && body.connectorType !== "destination") {
      return reply.code(400).send({ error: "zoom_must_be_destination" });
    }
    const nowIso = deps.clock.now().toISOString();
    const created = connectors.create(tenantId, {
      id: createId(),
      clientId: body.clientId ?? null,
      provider: body.provider,
      connectorType: body.connectorType,
      name: body.name,
      encryptedCredentials: encryptCredentialSecret(
        JSON.stringify(body.credentials),
        deps.env.QUORUM_CREDENTIAL_KEK,
      ),
      status: "pending",
      nowIso,
    });
    opsAudit.recordOpsAudit({
      tenantId,
      actorUserId: tryActorUserId(request, auth, deps.clock.now()),
      action: "connector.created",
      resourceType: "outcome_connector",
      resourceId: created.id,
      details: {
        provider: created.provider,
        connectorType: created.connectorType,
        name: created.name,
      },
      nowIso,
    });
    return reply.code(201).send({
      id: created.id,
      provider: created.provider,
      connectorType: created.connectorType,
      status: created.status,
    });
  });

  app.post("/api/v1/outcome/connectors/:id/probe", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const result = await runner.probeConnector(tenantId, id);
    const connector = connectors.get(tenantId, id);
    return reply.send({ result, status: connector?.status ?? null });
  });

  app.post("/api/v1/outcome/connectors/:id/revoke", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const nowIso = deps.clock.now().toISOString();
    connectors.revoke(tenantId, id, nowIso);
    opsAudit.recordOpsAudit({
      tenantId,
      actorUserId: tryActorUserId(request, auth, deps.clock.now()),
      action: "connector.disabled",
      resourceType: "outcome_connector",
      resourceId: id,
      details: { status: "disconnected" },
      nowIso,
    });
    return reply.send({ id, status: "disconnected" });
  });

  app.post("/api/v1/outcome/contracts", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const body = request.body as Record<string, unknown>;
    try {
      const created = contracts.create(tenantId, {
        clientId: (body.clientId as string | null) ?? null,
        name: String(body.name ?? ""),
        businessPurpose: String(body.businessPurpose ?? ""),
        contractType:
          body.contractType === "aggregate_check"
            ? "aggregate_check"
            : "reconciliation",
        sourceConnectorId: String(body.sourceConnectorId ?? ""),
        destinationConnectorId: String(body.destinationConnectorId ?? ""),
        sourceObjectType: String(
          body.sourceObjectType ?? FIRST_SUPPORTED_PATH.sourceObjectType,
        ),
        destinationObjectType: String(
          body.destinationObjectType ??
            FIRST_SUPPORTED_PATH.destinationObjectType,
        ),
        matchKeyDefinition: body.matchKeyDefinition as {
          strategy: "normalized_email";
          sourceField: string;
          destinationField: string;
          sourceObjectId: string;
          destinationObjectId: string;
        },
        sourceTimeField: String(body.sourceTimeField ?? "registeredAt"),
        destinationTimeField: String(
          body.destinationTimeField ?? "create_time",
        ),
        maximumDeliveryDelayMinutes: Number(
          body.maximumDeliveryDelayMinutes ??
            FIRST_SUPPORTED_PATH.defaultMaximumDeliveryDelayMinutes,
        ),
        acceptableMissingCount: Number(body.acceptableMissingCount ?? 0),
        acceptableMissingPercentage: Number(
          body.acceptableMissingPercentage ?? 0,
        ),
        scheduleExpression: String(body.scheduleExpression ?? "0 * * * *"),
        timezone: String(body.timezone ?? "UTC"),
        evidenceLevelTarget:
          body.evidenceLevelTarget === "medium" ? "medium" : "high",
        retentionDays: Number(body.retentionDays ?? 30),
        nowIso: deps.clock.now().toISOString(),
        explicitlyConfirmed: body.explicitlyConfirmed === true,
      });
      return reply
        .code(201)
        .send({ id: created.id, isActive: created.isActive });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "create_failed",
      });
    }
  });

  app.post("/api/v1/outcome/contracts/:id/activate", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { explicitlyConfirmed?: boolean };
    try {
      const activated = contracts.activate(
        tenantId,
        id,
        deps.clock.now().toISOString(),
        body.explicitlyConfirmed === true,
      );
      return reply.send({ id: activated.id, isActive: activated.isActive });
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "activate_failed",
      });
    }
  });

  app.post(
    "/api/v1/outcome/contracts/:id/reconcile",
    async (request, reply) => {
      const tenantId = deps.resolveTenantId(request, reply);
      if (!tenantId) {
        return;
      }
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as {
        windowStart?: string;
        windowEnd?: string;
      };
      const windowEnd = body.windowEnd
        ? new Date(body.windowEnd)
        : deps.clock.now();
      const windowStart = body.windowStart
        ? new Date(body.windowStart)
        : new Date(windowEnd.getTime() - 60 * 60 * 1000);
      try {
        const run = await runner.runWindow({
          tenantId,
          outcomeContractId: id,
          windowStart,
          windowEnd,
        });
        return reply.send(run);
      } catch (error) {
        if (error instanceof ConnectorRevokedError) {
          return reply.code(409).send({ error: "connector_revoked" });
        }
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "reconcile_failed",
        });
      }
    },
  );

  app.get(
    "/api/v1/outcome/contracts/:id/runs/latest",
    async (request, reply) => {
      const tenantId = deps.resolveTenantId(request, reply);
      if (!tenantId) {
        return;
      }
      const id = (request.params as { id: string }).id;
      const latest = runs.latestRunForContract(tenantId, id);
      if (!latest) {
        return reply.code(404).send({ error: "not_found" });
      }
      const items = runs.listItems(tenantId, latest.id);
      return reply.send({
        run: latest,
        items: items.map((item) => ({
          ...item,
          // hashes only — raw emails never returned
        })),
      });
    },
  );

  app.post("/api/v1/outcome/contracts/:id/exports", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { runId?: string };
    const runId = body.runId ?? runs.latestRunForContract(tenantId, id)?.id;
    if (!runId) {
      return reply.code(404).send({ error: "run_not_found" });
    }
    const token = generateOpaqueToken(24);
    const now = deps.clock.now();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    runs.createExportToken({
      tokenHash: hashToken(token),
      tenantId,
      outcomeContractId: id,
      reconciliationRunId: runId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    runs.recordAudit({
      tenantId,
      outcomeContractId: id,
      reconciliationRunId: runId,
      eventType: "export",
      actor: "api",
      createdAt: now.toISOString(),
      expiresAt,
      detailsJson: JSON.stringify({ scope: "missing_hashes" }),
    });
    return reply.code(201).send({
      token,
      expiresAt,
      note: "One-time token; returns identifier hashes only.",
    });
  });

  app.get("/api/v1/outcome/exports/:token", async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const consumed = runs.consumeExportToken(
      hashToken(token),
      deps.clock.now().toISOString(),
    );
    if (!consumed) {
      return reply.code(404).send({ error: "invalid_or_expired_token" });
    }
    const hashes = runs.listMissingHashes(
      consumed.tenantId,
      consumed.reconciliationRunId,
    );
    return reply.send({
      outcomeContractId: consumed.outcomeContractId,
      reconciliationRunId: consumed.reconciliationRunId,
      missingSourceIdentifierHashes: hashes,
    });
  });

  app.post("/api/v1/outcome/contracts/:id/waive", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const body = (request.body ?? {}) as { actor?: string };
    runner.waiveMissing({
      tenantId,
      outcomeContractId: id,
      actor: body.actor ?? "api",
    });
    return reply.send({ waived: true });
  });
}
