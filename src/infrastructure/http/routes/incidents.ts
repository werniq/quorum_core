import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SqliteAlertingRepositories } from "../../db/repositories/sqlite-alerting-repositories.js";
import { createId } from "../../../domain/ids.js";
import { InvalidIncidentTransitionError } from "../../../domain/incidents/lifecycle.js";
import type { QuorumEnv } from "../../config/env.js";

export function registerIncidentRoutes(
  app: FastifyInstance,
  deps: {
    alerting: SqliteAlertingRepositories;
    env: QuorumEnv;
    resolveTenantId: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => string | null;
  },
): void {
  app.post(
    "/api/v1/incidents/:incidentId/acknowledge",
    async (request, reply) => {
      const tenantId = deps.resolveTenantId(request, reply);
      if (!tenantId) {
        return;
      }
      const incidentId = (request.params as { incidentId: string }).incidentId;
      const body = (request.body ?? {}) as { actor?: string };
      try {
        const incident = deps.alerting.acknowledgeIncident(
          tenantId,
          incidentId,
          {
            actor: body.actor ?? null,
            edition: deps.env.QUORUM_EDITION,
          },
        );
        deps.alerting.enqueueOutbox(tenantId, {
          id: createId(),
          incidentId,
          eventType: "acknowledged",
          payloadJson: JSON.stringify({ incidentId }),
          availableAt: new Date().toISOString(),
        });
        return reply.send({ incident });
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
      return reply.send({ incident });
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
