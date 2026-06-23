import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { loadEnv } from "./infrastructure/config/env.js";
import { buildApp } from "./infrastructure/http/app.js";
import {
  evaluateSqliteReadiness,
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "./infrastructure/db/sqlite-migrator.js";
import { SqliteAuthRepositories } from "./infrastructure/db/repositories/sqlite-auth-repositories.js";
import { SqliteCoreRepositories } from "./infrastructure/db/repositories/sqlite-core-repositories.js";
import { SystemClock } from "./infrastructure/time/system-clock.js";
import { createWatcher } from "./infrastructure/watcher/run-watcher.js";
import { createOutboxProcessor } from "./infrastructure/alerting/process-outbox.js";
import { createDefaultAlertDeliveryProviders } from "./infrastructure/alerting/delivery-providers.js";
import { createIngestHeartbeatHandler } from "./infrastructure/ingestion/ingest-heartbeat.js";
import { createIngestPolledEvidenceHandler } from "./infrastructure/ingestion/ingest-polled-evidence.js";
import { createN8nPollingAdapter } from "./infrastructure/n8n/poll-workflow.js";
import { createN8nPollScheduler } from "./infrastructure/n8n/run-poll-scheduler.js";
import { SqliteOutboundDestinationRepositories } from "./infrastructure/db/repositories/sqlite-outbound-destinations.js";
import { createGracefulShutdownController } from "./infrastructure/runtime/graceful-shutdown.js";

import type {
  AlertDeliveryProviders,
  DeliveryResult,
  SmtpChannelConfig,
  WebhookChannelConfig,
} from "./infrastructure/alerting/delivery-providers.js";

function resolveSqlitePath(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) {
    return path.resolve(databaseUrl.slice("file:".length));
  }
  return path.resolve(databaseUrl);
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const clock = new SystemClock();
  const dbPath = resolveSqlitePath(env.DATABASE_URL);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const { sqlite } = openSqliteDatabase(dbPath);
  try {
    migrateSqliteToLatest(sqlite);
  } catch (error) {
    console.error(
      "Migration failed; refusing to start application processors.",
    );
    console.error(error);
    process.exit(1);
  }

  const readiness = () => evaluateSqliteReadiness(sqlite);
  if (readiness().status !== "ready") {
    console.error("Schema not ready after migrate; exiting.");
    process.exit(1);
  }

  const core = new SqliteCoreRepositories(sqlite);
  const tenant = core.ensureSelfHostedTenant();
  const auth = new SqliteAuthRepositories(sqlite);
  const outbound = new SqliteOutboundDestinationRepositories(sqlite);

  if (!auth.hasAdminUser()) {
    const envToken = process.env.QUORUM_SETUP_TOKEN;
    if (envToken && envToken.length >= 24) {
      auth.registerSetupTokenFromEnv(envToken, clock.now());
      console.info(
        "Setup: using QUORUM_SETUP_TOKEN from environment (value not logged). Container log retention can keep a generated token if one was printed earlier; prefer an operator-supplied env token.",
      );
    } else {
      const issued = auth.issueSetupToken(clock.now());
      if (issued) {
        console.info(
          `Setup token (copy once; not stored in plaintext; never printed again): ${issued.token}`,
        );
      }
    }
  }

  const claimOwner = `quorum-${hostname()}-${process.pid}`;
  const watcher = createWatcher({
    sqlite,
    clock,
    claimOwner,
    claimTtlMs: env.WATCHER_CLAIM_TTL_MS,
    getSchemaReadiness: readiness,
  });

  const baseProviders = createDefaultAlertDeliveryProviders();
  const providers: AlertDeliveryProviders = {
    async deliverWebhook(
      config: WebhookChannelConfig,
      payload: unknown,
      options: { timeoutMs: number; existingThreadId: string | null },
    ): Promise<DeliveryResult> {
      const result = await baseProviders.deliverWebhook(
        config,
        payload,
        options,
      );
      outbound.recordAttempt({
        tenantId: tenant.id,
        kind: "webhook",
        destination: config.url,
        status: result.ok ? "success" : "failure",
        errorSummary: result.ok ? null : result.errorMessage,
        nowIso: clock.now().toISOString(),
      });
      return result;
    },
    async deliverSmtp(
      config: SmtpChannelConfig,
      payload: unknown,
      options: { timeoutMs: number; existingThreadId: string | null },
    ): Promise<DeliveryResult> {
      const result = await baseProviders.deliverSmtp(config, payload, options);
      outbound.recordAttempt({
        tenantId: tenant.id,
        kind: "smtp",
        destination: `${config.host}:${config.port}`,
        status: result.ok ? "success" : "failure",
        errorSummary: result.ok ? null : result.errorMessage,
        nowIso: clock.now().toISOString(),
      });
      return result;
    },
  };

  const processOutbox = createOutboxProcessor({
    sqlite,
    clock,
    kek: env.QUORUM_CREDENTIAL_KEK,
    claimOwner,
    claimTtlMs: env.OUTBOX_CLAIM_TTL_MS,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    retryBaseMs: env.OUTBOX_RETRY_BASE_MS,
    deliveryTimeoutMs: env.ALERT_DELIVERY_TIMEOUT_MS,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    providers,
    getSchemaReadiness: readiness,
    edition: env.QUORUM_EDITION,
  });

  const ingestHeartbeat = createIngestHeartbeatHandler({
    sqlite,
    clock,
    env,
    getSchemaReadiness: readiness,
  });

  const ingestPolledEvidence = createIngestPolledEvidenceHandler({
    sqlite,
    clock,
    getSchemaReadiness: readiness,
  });

  const n8nPolling = createN8nPollingAdapter({
    sqlite,
    clock,
    kek: env.QUORUM_CREDENTIAL_KEK,
    getSchemaReadiness: readiness,
    ingestPolledEvidence,
    httpOptions: {
      connectTimeoutMs: env.N8N_CONNECTOR_CONNECT_TIMEOUT_MS,
      readTimeoutMs: env.N8N_CONNECTOR_READ_TIMEOUT_MS,
      maxResponseBytes: env.N8N_CONNECTOR_MAX_RESPONSE_BYTES,
      maxRedirects: env.N8N_CONNECTOR_MAX_REDIRECTS,
      networkPolicy: "self_hosted_local",
    },
  });

  const pollScheduler = createN8nPollScheduler({
    sqlite,
    clock,
    claimOwner,
    claimTtlMs: env.N8N_POLL_CLAIM_TTL_MS,
    defaultPollIntervalMs: env.N8N_POLL_DEFAULT_INTERVAL_MS,
    getSchemaReadiness: readiness,
    pollWorkflow: n8nPolling.pollWorkflow,
  });

  const app = await buildApp({
    env,
    clock,
    sqlite,
    processOutbox,
    getSchemaReadiness: readiness,
    getWatcherHealth: () => {
      const state = watcher.getRunState();
      return {
        lastSuccessAt: state.lastSuccessAt,
        staleAfterMs: env.WATCHER_STALE_MS,
        nowMs: clock.now().getTime(),
      };
    },
    ingestHeartbeat,
    enableUi: true,
  });

  const shutdownCtl = createGracefulShutdownController({
    graceMs: env.SHUTDOWN_GRACE_MS,
  });

  const watcherTimer = setInterval(() => {
    if (shutdownCtl.isShuttingDown()) {
      return;
    }
    shutdownCtl
      .track(
        Promise.resolve().then(() => {
          if (shutdownCtl.isShuttingDown()) {
            return;
          }
          watcher.runTick(tenant.id);
        }),
      )
      .catch((error: unknown) => {
        console.error("watcher_tick_failed", error);
      });
  }, env.WATCHER_INTERVAL_MS);
  watcherTimer.unref?.();

  const outboxTimer = setInterval(() => {
    if (shutdownCtl.isShuttingDown()) {
      return;
    }
    void shutdownCtl
      .track(processOutbox.processBatch(20))
      .catch((error: unknown) => {
        console.error("outbox_tick_failed", error);
      });
  }, env.OUTBOX_INTERVAL_MS);
  outboxTimer.unref?.();

  const pollTimer = setInterval(() => {
    if (shutdownCtl.isShuttingDown()) {
      return;
    }
    void shutdownCtl.track(pollScheduler.runTick()).catch((error: unknown) => {
      console.error("n8n_poll_scheduler_tick_failed", error);
    });
  }, env.N8N_POLL_SCHEDULER_INTERVAL_MS);
  pollTimer.unref?.();

  // Warm watcher state immediately so /health/watcher is meaningful after start.
  try {
    watcher.runTick(tenant.id);
  } catch (error) {
    console.error("watcher_initial_tick_failed", error);
  }

  await app.listen({ host: env.HOST, port: env.PORT });
  console.info(
    `Quorum self-hosted listening on http://${env.HOST}:${env.PORT} (catalog at /catalog)`,
  );

  const shutdown = async (signal: string) => {
    const result = await shutdownCtl.shutdown({
      signal,
      stopAccepting: () => {
        clearInterval(watcherTimer);
        clearInterval(outboxTimer);
        clearInterval(pollTimer);
        pollScheduler.stop();
      },
      close: async () => {
        try {
          await app.close();
        } catch (error) {
          console.error("http_close_failed", error);
        }
        try {
          sqlite.close();
        } catch {
          // ignore
        }
      },
    });
    // forced path already invoked forceExit(1) inside the controller
    if (result === "completed") {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
