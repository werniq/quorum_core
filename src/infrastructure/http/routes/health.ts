import type { FastifyInstance } from "fastify";
import type { SchemaReadinessState } from "../../../application/schema-readiness.js";
import { assertApplicationReady } from "../../../application/processors.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: {
    getSchemaReadiness: () =>
      | SchemaReadinessState
      | Promise<SchemaReadinessState>;
    getWatcherHealth: () => {
      lastSuccessAt: string | null;
      staleAfterMs: number;
      nowMs: number;
    };
  },
): void {
  app.get("/health/live", async () => ({
    status: "ok",
    check: "live",
  }));

  app.get("/health/ready", async (_request, reply) => {
    const readiness = await deps.getSchemaReadiness();
    try {
      assertApplicationReady(readiness);
      return {
        status: "ready",
        check: "ready",
        appliedMigrations: readiness.appliedMigrations,
      };
    } catch {
      return reply.code(503).send({
        status: "not_ready",
        check: "ready",
        readiness,
      });
    }
  });

  app.get("/health/watcher", async (_request, reply) => {
    const health = deps.getWatcherHealth();
    if (!health.lastSuccessAt) {
      return reply.code(503).send({
        status: "stale",
        check: "watcher",
        reason: "never_succeeded",
        documentation:
          "Require an external uptime check against GET /health/watcher.",
      });
    }
    const ageMs = health.nowMs - new Date(health.lastSuccessAt).getTime();
    if (ageMs > health.staleAfterMs) {
      return reply.code(503).send({
        status: "stale",
        check: "watcher",
        lastSuccessAt: health.lastSuccessAt,
        ageMs,
        staleAfterMs: health.staleAfterMs,
        documentation:
          "Require an external uptime check against GET /health/watcher.",
      });
    }
    return {
      status: "ok",
      check: "watcher",
      lastSuccessAt: health.lastSuccessAt,
      ageMs,
      documentation:
        "Require an external uptime check against GET /health/watcher.",
    };
  });
}
