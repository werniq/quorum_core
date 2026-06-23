import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "../../../domain/clock.js";
import { queryContractCatalog } from "../../catalog/query-catalog.js";
import type Database from "better-sqlite3";

export function registerCatalogRoutes(
  app: FastifyInstance,
  deps: {
    sqlite: Database.Database;
    clock: Clock;
    publicBaseUrl: string;
    resolveTenantId: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => string | null;
  },
): void {
  app.get("/api/v1/catalog/contracts", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const query = request.query as {
      clientId?: string;
      limit?: string;
      offset?: string;
    };
    const catalogInput: Parameters<typeof queryContractCatalog>[0] = {
      sqlite: deps.sqlite,
      tenantId,
      clock: deps.clock,
      publicBaseUrl: deps.publicBaseUrl,
      limit: query.limit ? Number(query.limit) : 100,
      offset: query.offset ? Number(query.offset) : 0,
    };
    if (query.clientId) {
      catalogInput.clientId = query.clientId;
    }
    const contracts = queryContractCatalog(catalogInput);
    return reply.send({
      question:
        "What should happen, is it happening, how sure are we, and what should I do?",
      contracts,
    });
  });
}
