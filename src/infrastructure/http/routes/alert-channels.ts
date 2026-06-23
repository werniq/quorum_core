import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { createId } from "../../../domain/ids.js";
import type { Clock } from "../../../domain/clock.js";
import { SqliteAlertingRepositories } from "../../db/repositories/sqlite-alerting-repositories.js";
import { SqliteAuthRepositories } from "../../db/repositories/sqlite-auth-repositories.js";
import { SqliteOpsAuditRepositories } from "../../db/repositories/sqlite-ops-audit-repositories.js";
import type { QuorumEnv } from "../../config/env.js";
import type { createOutboxProcessor } from "../../alerting/process-outbox.js";
import { parseCookieHeader, SESSION_COOKIE } from "../cookies.js";

export function registerAlertChannelRoutes(
  app: FastifyInstance,
  deps: {
    alerting: SqliteAlertingRepositories;
    env: QuorumEnv;
    clock: Clock;
    processOutbox?: ReturnType<typeof createOutboxProcessor>;
    sqlite?: Database.Database;
    resolveTenantId: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => string | null;
  },
): void {
  const opsAudit = deps.sqlite
    ? new SqliteOpsAuditRepositories(deps.sqlite)
    : null;
  const auth = deps.sqlite ? new SqliteAuthRepositories(deps.sqlite) : null;

  app.post("/api/v1/alert-channels/:channelId/test", async (request, reply) => {
    const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }
    const channelId = (request.params as { channelId: string }).channelId;
    const channel = deps.alerting.getAlertChannel(tenantId, channelId);
    if (!channel) {
      return reply.code(404).send({ error: "not_found" });
    }

    const nowIso = deps.clock.now().toISOString();
    const outboxId = createId();
    deps.alerting.enqueueOutbox(tenantId, {
      id: outboxId,
      incidentId: null,
      eventType: "channel_test",
      payloadJson: JSON.stringify({ alertChannelId: channelId }),
      availableAt: nowIso,
    });

    if (deps.processOutbox) {
      await deps.processOutbox.processBatch(10);
    } else {
      deps.alerting.applyChannelDeliveryResult(
        tenantId,
        channelId,
        { type: "test_succeeded" },
        nowIso,
      );
      deps.alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
    }

    if (opsAudit && auth) {
      const cookies = parseCookieHeader(
        typeof request.headers.cookie === "string"
          ? request.headers.cookie
          : undefined,
      );
      const sessionId = cookies[SESSION_COOKIE];
      const actorUserId = sessionId
        ? (auth.getSession(sessionId, deps.clock.now())?.adminUserId ?? null)
        : null;
      opsAudit.recordOpsAudit({
        tenantId,
        actorUserId,
        action: "alert_channel.tested",
        resourceType: "alert_channel",
        resourceId: channelId,
        nowIso,
      });
    }

    const state = deps.alerting.getAlertChannelState(tenantId, channelId);
    return reply.send({
      channelId,
      health: state?.currentHealth ?? "unknown",
    });
  });
}
