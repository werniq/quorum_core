import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { QuorumEnv } from "../config/env.js";
import type { SchemaReadinessState } from "../../application/schema-readiness.js";
import { assertApplicationReady } from "../../application/processors.js";
import { registerHeartbeatRoutes } from "./routes/heartbeats.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerIncidentRoutes } from "./routes/incidents.js";
import { registerAlertChannelRoutes } from "./routes/alert-channels.js";
import { registerUiRoutes } from "./routes/ui.js";
import { registerOutcomeRoutes } from "./routes/outcome.js";
import type { IngestHeartbeatResult } from "../ingestion/ingest-heartbeat.js";
import type { Clock } from "../../domain/clock.js";
import { SystemClock } from "../time/system-clock.js";
import { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";
import { SqliteCoreRepositories } from "../db/repositories/sqlite-core-repositories.js";
import type { createOutboxProcessor } from "../alerting/process-outbox.js";
import type { SecureOutboundHttpOptions } from "../security/secure-outbound-http.js";
import { applySecurityHeaders } from "../observability/security-headers.js";
import { localMetrics } from "../observability/metrics.js";
import { PINO_REDACT_PATHS } from "../observability/logging.js";
import { resolveTrustedTenantId } from "./resolve-tenant.js";

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace("::ffff:", "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

function assertMetricsAllowed(
  request: {
    ip: string;
    headers: Record<string, string | string[] | undefined>;
  },
  env: QuorumEnv,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): boolean {
  if (!env.METRICS_ENABLED) {
    void reply.code(404).send({ error: "metrics_disabled" });
    return false;
  }
  const token = env.METRICS_AUTH_TOKEN;
  if (token.length > 0) {
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      void reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  }
  if (!isLoopbackAddress(request.ip)) {
    void reply.code(403).send({ error: "metrics_loopback_only" });
    return false;
  }
  return true;
}

export interface AppDeps {
  env: QuorumEnv;
  clock?: Clock;
  sqlite?: Database.Database;
  processOutbox?: ReturnType<typeof createOutboxProcessor>;
  getSchemaReadiness: () =>
    | SchemaReadinessState
    | Promise<SchemaReadinessState>;
  getWatcherHealth?: () => {
    lastSuccessAt: string | null;
    staleAfterMs: number;
    nowMs: number;
  };
  ingestHeartbeat?: (command: {
    workflowId: string;
    method: string;
    path: string;
    keyId: string;
    timestampSeconds: string;
    idempotencyKey: string;
    signatureHex: string;
    rawBody: Buffer;
  }) => IngestHeartbeatResult;
  /** Local admin HTML UI (self-hosted product surface). */
  enableUi?: boolean;
  outcomeHttp?: SecureOutboundHttpOptions;
}

/**
 * HTTP application surface for health, catalog, incidents, and optional heartbeat ingestion.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      deps.env.NODE_ENV === "test"
        ? false
        : {
            redact: { paths: PINO_REDACT_PATHS, remove: true },
          },
    genReqId: () => randomUUID(),
    requestIdHeader: "x-request-id",
    bodyLimit: deps.env.HEARTBEAT_MAX_BODY_BYTES,
  });
  const clock = deps.clock ?? new SystemClock();

  app.addHook("onRequest", async (request, reply) => {
    applySecurityHeaders(request, reply);
    reply.header("x-request-id", request.id);
  });

  app.get("/metrics", async (request, reply) => {
    if (!assertMetricsAllowed(request, deps.env, reply)) {
      return;
    }
    if (deps.sqlite) {
      refreshDurableGauges(deps.sqlite);
    }
    return reply
      .type("text/plain; version=0.0.4")
      .send(localMetrics.toPrometheusText());
  });

  app.get("/metrics.json", async (request, reply) => {
    if (!assertMetricsAllowed(request, deps.env, reply)) {
      return;
    }
    if (deps.sqlite) {
      refreshDurableGauges(deps.sqlite);
    }
    return {
      transmittedByDefault: false,
      authRequired: deps.env.METRICS_AUTH_TOKEN.length > 0,
      loopbackOnlyWhenUnauthenticated: deps.env.METRICS_AUTH_TOKEN.length === 0,
      ...localMetrics.snapshot(),
    };
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        const params = new URLSearchParams(String(body));
        const out: Record<string, string> = {};
        for (const [key, value] of params.entries()) {
          out[key] = value;
        }
        done(null, out);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.get("/healthz", async () => ({
    status: "ok",
    product: "quorum",
    edition: deps.env.QUORUM_EDITION,
  }));

  app.get("/readyz", async (_request, reply) => {
    const readiness = await deps.getSchemaReadiness();
    try {
      assertApplicationReady(readiness);
      localMetrics.setGauge("quorum_schema_ready", 1);
      return {
        status: "ready",
        appliedMigrations: readiness.appliedMigrations,
      };
    } catch {
      localMetrics.setGauge("quorum_schema_ready", 0);
      localMetrics.inc("quorum_migration_readiness_failures_total");
      return reply.code(503).send({
        status: "not_ready",
        readiness,
      });
    }
  });

  registerHealthRoutes(app, {
    getSchemaReadiness: deps.getSchemaReadiness,
    getWatcherHealth:
      deps.getWatcherHealth ??
      (() => ({
        lastSuccessAt: null,
        staleAfterMs: deps.env.WATCHER_STALE_MS,
        nowMs: clock.now().getTime(),
      })),
  });

  if (deps.sqlite) {
    const sqlite = deps.sqlite;
    const alerting = new SqliteAlertingRepositories(sqlite);
    const core = new SqliteCoreRepositories(sqlite);

    const resolveTenantId = (
      request: FastifyRequest,
      reply: FastifyReply,
    ): string | null =>
      resolveTrustedTenantId({
        request,
        reply,
        env: deps.env,
        core,
      });

    registerCatalogRoutes(app, {
      sqlite,
      clock,
      publicBaseUrl: deps.env.PUBLIC_BASE_URL,
      resolveTenantId,
    });

    registerIncidentRoutes(app, {
      alerting,
      env: deps.env,
      resolveTenantId,
    });

    registerAlertChannelRoutes(app, {
      alerting,
      env: deps.env,
      clock,
      ...(deps.processOutbox ? { processOutbox: deps.processOutbox } : {}),
      sqlite,
      resolveTenantId,
    });

    registerOutcomeRoutes(app, {
      sqlite,
      clock,
      env: deps.env,
      ...(deps.outcomeHttp ? { http: deps.outcomeHttp } : {}),
      resolveTenantId,
    });

    if (deps.enableUi) {
      registerUiRoutes(app, {
        env: deps.env,
        sqlite,
        clock,
        ...(deps.processOutbox ? { processOutbox: deps.processOutbox } : {}),
      });
    }
  }

  if (deps.ingestHeartbeat) {
    app.removeContentTypeParser("application/json");
    const ingest = deps.ingestHeartbeat;
    registerHeartbeatRoutes(app, {
      ingest: (command) => {
        const result = ingest(command);
        recordHeartbeatMetrics(result);
        return result;
      },
      maxBodyBytes: deps.env.HEARTBEAT_MAX_BODY_BYTES,
    });
  }

  return app;
}

function recordHeartbeatMetrics(result: IngestHeartbeatResult): void {
  localMetrics.inc("quorum_heartbeat_requests_total", {
    status: result.status,
  });
  if (result.status === "accepted") {
    localMetrics.inc("quorum_heartbeat_accepts_total");
  } else if (result.status === "unauthorized") {
    localMetrics.inc("quorum_heartbeat_signature_failures_total");
  } else if (result.status === "rate_limited") {
    localMetrics.inc("quorum_heartbeat_rate_limit_rejections_total");
  } else {
    localMetrics.inc("quorum_heartbeat_rejects_total", {
      status: result.status,
    });
  }
}

function refreshDurableGauges(sqlite: Database.Database): void {
  try {
    const healthRows = sqlite
      .prepare(
        `SELECT current_health AS h, COUNT(*) AS c
         FROM alert_channel_states
         GROUP BY current_health`,
      )
      .all() as Array<{ h: string; c: number }>;
    for (const row of healthRows) {
      localMetrics.setGauge("quorum_alert_channels", Number(row.c), {
        health: row.h,
      });
    }
    const backlog = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM notification_outbox
         WHERE processed_at IS NULL`,
      )
      .get() as { c: number };
    localMetrics.setGauge("quorum_outbox_backlog", Number(backlog.c));
    const incidents = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM incidents WHERE status IN ('open','acknowledged')`,
      )
      .get() as { c: number };
    localMetrics.setGauge("quorum_open_incidents", Number(incidents.c));
    const evidence = sqlite
      .prepare(
        `SELECT evidence_level AS e, COUNT(*) AS c FROM workflow_states GROUP BY evidence_level`,
      )
      .all() as Array<{ e: string; c: number }>;
    for (const row of evidence) {
      localMetrics.setGauge("quorum_contracts_by_evidence", Number(row.c), {
        level: row.e,
      });
    }
    const health = sqlite
      .prepare(
        `SELECT current_health AS h, COUNT(*) AS c FROM workflow_states GROUP BY current_health`,
      )
      .all() as Array<{ h: string; c: number }>;
    for (const row of health) {
      localMetrics.setGauge("quorum_contracts_by_health", Number(row.c), {
        health: row.h,
      });
    }
  } catch {
    localMetrics.inc("quorum_metrics_refresh_errors_total");
  }
}
