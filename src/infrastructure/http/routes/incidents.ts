import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { SqliteAlertingRepositories } from "../../db/repositories/sqlite-alerting-repositories.js";
import { createId } from "../../../domain/ids.js";
import { InvalidIncidentTransitionError } from "../../../domain/incidents/lifecycle.js";
import type { QuorumEnv } from "../../config/env.js";
import type {
  IncidentSeverity,
  ListIncidentsQuery,
} from "../../../application/repositories/alerting-repositories.js";
import {
  INCIDENT_STATUSES,
  type IncidentStatus,
} from "../../../domain/terminology.js";
import {
  decodeIncidentListCursor,
  encodeIncidentListCursor,
} from "../incident-list-cursor.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SEVERITIES = new Set<IncidentSeverity>(["warning", "critical"]);
const STATUS_SET = new Set<string>(INCIDENT_STATUSES);

function parseStatuses(
  raw: string | undefined,
): { ok: true; statuses?: IncidentStatus[] } | { ok: false } {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true };
  }
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { ok: false };
  }
  const statuses: IncidentStatus[] = [];
  for (const part of parts) {
    if (!STATUS_SET.has(part)) {
      return { ok: false };
    }
    statuses.push(part as IncidentStatus);
  }
  return { ok: true, statuses };
}

function parseLimit(
  raw: string | undefined,
): { ok: true; limit: number } | { ok: false } {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, limit: DEFAULT_LIMIT };
  }
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false };
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false };
  }
  return { ok: true, limit };
}

function parseUpdatedAfter(
  raw: string | undefined,
): { ok: true; updatedAfter?: string } | { ok: false } {
  if (raw === undefined || raw.trim() === "") {
    return { ok: true };
  }
  const value = raw.trim();
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return { ok: false };
  }
  return { ok: true, updatedAfter: value };
}

export function registerIncidentRoutes(
  app: FastifyInstance,
  deps: {
    alerting: SqliteAlertingRepositories;
    sqlite: Database.Database;
    env: QuorumEnv;
    resolveTenantId: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => string | null;
  },
): void {
  function presentIncident(
    tenantId: string,
    incident: ReturnType<
      SqliteAlertingRepositories["getIncident"]
    > extends infer T
      ? NonNullable<T>
      : never,
  ) {
    const workflow = incident.workflowId
      ? (deps.sqlite
          .prepare(
            `SELECT w.id, w.name, w.external_workflow_id FROM workflows w WHERE w.tenant_id = ? AND w.id = ?`,
          )
          .get(tenantId, incident.workflowId) as
          | { id: string; name: string; external_workflow_id: string }
          | undefined)
      : undefined;
    let externalExecutionRef: string | null = null;
    if (incident.detailsJson) {
      try {
        const parsed: unknown = JSON.parse(incident.detailsJson);
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as Record<string, unknown>).externalExecutionRef ===
            "string"
        ) {
          externalExecutionRef =
            (parsed as Record<string, string>).externalExecutionRef ?? null;
        }
      } catch {
        // Historical details may be absent or malformed; structured fields still render.
      }
    }
    return {
      ...incident,
      quorumWorkflowId: workflow?.id ?? incident.workflowId,
      quorumWorkflowName: workflow?.name ?? null,
      n8nWorkflowId: workflow?.external_workflow_id ?? null,
      n8nWorkflowName: workflow?.name ?? null,
      externalExecutionRef,
    };
  }

  app.get("/api/v1/incidents", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }

    const query = request.query as {
      status?: string;
      severity?: string;
      workflowId?: string;
      contractId?: string;
      clientId?: string;
      updatedAfter?: string;
      limit?: string;
      cursor?: string;
    };

    const statuses = parseStatuses(query.status);
    if (!statuses.ok) {
      return reply.code(400).send({ error: "invalid_status" });
    }

    let severity: IncidentSeverity | undefined;
    if (query.severity !== undefined && query.severity.trim() !== "") {
      const value = query.severity.trim() as IncidentSeverity;
      if (!SEVERITIES.has(value)) {
        return reply.code(400).send({ error: "invalid_severity" });
      }
      severity = value;
    }

    const limit = parseLimit(query.limit);
    if (!limit.ok) {
      return reply.code(400).send({ error: "invalid_limit" });
    }

    const updatedAfter = parseUpdatedAfter(query.updatedAfter);
    if (!updatedAfter.ok) {
      return reply.code(400).send({ error: "invalid_updated_after" });
    }

    let cursor: ListIncidentsQuery["cursor"];
    if (query.cursor !== undefined && query.cursor.trim() !== "") {
      const decoded = decodeIncidentListCursor(query.cursor.trim());
      if (!decoded) {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
      cursor = decoded;
    }

    const listQuery: ListIncidentsQuery = {
      limit: limit.limit,
    };
    if (statuses.statuses) {
      listQuery.statuses = statuses.statuses;
    }
    if (severity) {
      listQuery.severity = severity;
    }
    if (query.workflowId?.trim()) {
      listQuery.workflowId = query.workflowId.trim();
    }
    if (query.contractId?.trim()) {
      listQuery.contractId = query.contractId.trim();
    }
    if (query.clientId?.trim()) {
      listQuery.clientId = query.clientId.trim();
    }
    if (updatedAfter.updatedAfter) {
      listQuery.updatedAfter = updatedAfter.updatedAfter;
    }
    if (cursor) {
      listQuery.cursor = cursor;
    }

    const result = deps.alerting.queryIncidents(tenantId, listQuery);
    return reply.send({
      items: result.items.map((incident) =>
        presentIncident(tenantId, incident),
      ),
      nextCursor: result.nextCursor
        ? encodeIncidentListCursor(result.nextCursor)
        : null,
    });
  });

  app.get("/api/v1/incidents/:incidentId", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const incidentId = (request.params as { incidentId: string }).incidentId;
    const incident = deps.alerting.getIncident(tenantId, incidentId);
    if (!incident) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send({ incident: presentIncident(tenantId, incident) });
  });

  app.post(
    "/api/v1/incidents/:incidentId/acknowledge",
    async (request, reply) => {
      const tenantId = deps.resolveTenantId(request, reply);
      if (!tenantId) {
        return;
      }
      const incidentId = (request.params as { incidentId: string }).incidentId;
      const body = (request.body ?? {}) as { note?: string };
      try {
        const before = deps.alerting.getIncident(tenantId, incidentId);
        const incident = deps.alerting.acknowledgeIncident(
          tenantId,
          incidentId,
          {
            actor: "api:authenticated",
            note: body.note ?? null,
            edition: deps.env.QUORUM_EDITION,
          },
        );
        if (before?.acknowledgmentStatus !== "acknowledged") {
          deps.alerting.enqueueOutbox(tenantId, {
            id: createId(),
            incidentId,
            eventType: "acknowledged",
            payloadJson: JSON.stringify({ incidentId }),
            availableAt: new Date().toISOString(),
          });
        }
        return reply.send({ incident: presentIncident(tenantId, incident) });
      } catch (error) {
        if (error instanceof InvalidIncidentTransitionError) {
          return reply.code(409).send({ error: "invalid_transition" });
        }
        if (error instanceof Error && error.message.includes("not visible")) {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );

  app.post("/api/v1/incidents/:incidentId/resolve", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const incidentId = (request.params as { incidentId: string }).incidentId;
    const body = (request.body ?? {}) as { actor?: string };
    try {
      const incident = deps.alerting.resolveIncident(tenantId, incidentId, {
        actor: body.actor ?? null,
        edition: deps.env.QUORUM_EDITION,
      });
      deps.alerting.enqueueOutbox(tenantId, {
        id: createId(),
        incidentId,
        eventType: "resolved",
        payloadJson: JSON.stringify({ incidentId }),
        availableAt: new Date().toISOString(),
      });
      return reply.send({ incident: presentIncident(tenantId, incident) });
    } catch (error) {
      if (error instanceof InvalidIncidentTransitionError) {
        return reply.code(409).send({ error: "invalid_transition" });
      }
      if (error instanceof Error && error.message.includes("not visible")) {
        return reply.code(404).send({ error: "not_found" });
      }
      throw error;
    }
  });
}
