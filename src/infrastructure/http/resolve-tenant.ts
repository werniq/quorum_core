import type { FastifyReply, FastifyRequest } from "fastify";
import type { QuorumEnv } from "../config/env.js";
import { SqliteCoreRepositories } from "../db/repositories/sqlite-core-repositories.js";

/**
 * Resolve tenant for JSON APIs (self-hosted only).
 * Always the local tenant; forged foreign headers are rejected.
 * Never trust client-supplied tenant alone.
 */
export function resolveTrustedTenantId(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  env: QuorumEnv;
  core: SqliteCoreRepositories;
}): string | null {
  if (input.env.QUORUM_EDITION !== "self_hosted") {
    void input.reply.code(501).send({ error: "edition_not_supported" });
    return null;
  }

  const localId = input.core.ensureSelfHostedTenant().id;
  const header = input.request.headers["x-quorum-tenant-id"];
  if (typeof header === "string" && header.length > 0 && header !== localId) {
    void input.reply.code(403).send({ error: "forbidden" });
    return null;
  }
  const queryTenant = (input.request.query as { tenantId?: string } | undefined)
    ?.tenantId;
  if (
    typeof queryTenant === "string" &&
    queryTenant.length > 0 &&
    queryTenant !== localId
  ) {
    void input.reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return localId;
}
