import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import {
  assertProcessingAllowed,
  type SchemaReadinessState,
} from "../../application/schema-readiness.js";
import { SqliteN8nConnectorRepositories } from "../db/repositories/sqlite-n8n-connector-repositories.js";
import type {
  PollN8nWorkflowResult,
  createN8nPollingAdapter,
} from "./poll-workflow.js";

/** Stop permanent retries after this many consecutive temporary failures. */
export const N8N_POLL_MAX_CONSECUTIVE_FAILURES = 8;

/** Cap exponential backoff at 30 minutes. */
const MAX_BACKOFF_MS = 30 * 60 * 1000;

export interface N8nPollSchedulerTickResult {
  considered: number;
  claimed: number;
  polled: number;
  skipped: number;
  failed: number;
}

export function createN8nPollScheduler(deps: {
  sqlite: Database.Database;
  clock: Clock;
  claimOwner: string;
  claimTtlMs: number;
  defaultPollIntervalMs?: number;
  maxConsecutiveFailures?: number;
  getSchemaReadiness: () => SchemaReadinessState;
  pollWorkflow: ReturnType<typeof createN8nPollingAdapter>["pollWorkflow"];
}) {
  const connectors = new SqliteN8nConnectorRepositories(deps.sqlite);
  const maxFailures =
    deps.maxConsecutiveFailures ?? N8N_POLL_MAX_CONSECUTIVE_FAILURES;
  const defaultInterval = deps.defaultPollIntervalMs ?? 60_000;

  let stopped = false;
  let lastSuccessAt: string | null = null;
  let lastTickAt: string | null = null;
  let tickInFlight: Promise<N8nPollSchedulerTickResult> | null = null;

  function getRunState(): {
    lastSuccessAt: string | null;
    lastTickAt: string | null;
  } {
    return { lastSuccessAt, lastTickAt };
  }

  function stop(): void {
    stopped = true;
  }

  async function runTick(): Promise<N8nPollSchedulerTickResult> {
    if (stopped) {
      return { considered: 0, claimed: 0, polled: 0, skipped: 0, failed: 0 };
    }

    assertProcessingAllowed(deps.getSchemaReadiness(), "ingestion");

    if (tickInFlight) {
      return tickInFlight;
    }

    tickInFlight = executeTick().finally(() => {
      tickInFlight = null;
    });
    return tickInFlight;
  }

  async function executeTick(): Promise<N8nPollSchedulerTickResult> {
    const now = deps.clock.now();
    const nowIso = now.toISOString();
    lastTickAt = nowIso;

    const candidates = connectors.listPollableWorkflows();
    let considered = 0;
    let claimed = 0;
    let polled = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of candidates) {
      if (stopped) {
        break;
      }

      considered += 1;

      if (
        shouldSkipPermanently(row.health, row.consecutiveFailures, maxFailures)
      ) {
        skipped += 1;
        continue;
      }

      if (!isDue(row, now, defaultInterval)) {
        skipped += 1;
        continue;
      }

      const expiresIso = new Date(
        now.getTime() + deps.claimTtlMs,
      ).toISOString();
      if (
        !connectors.tryClaimPoll(
          row.tenantId,
          row.workflowId,
          deps.claimOwner,
          nowIso,
          expiresIso,
        )
      ) {
        skipped += 1;
        continue;
      }

      claimed += 1;

      try {
        const result = await deps.pollWorkflow({
          tenantId: row.tenantId,
          workflowId: row.workflowId,
        });
        const finishedAt = deps.clock.now().toISOString();
        const success = isPollSuccess(result);
        connectors.finishPollClaim(
          row.tenantId,
          row.workflowId,
          deps.claimOwner,
          { finishedAtIso: finishedAt, success },
        );

        if (success) {
          polled += 1;
          lastSuccessAt = finishedAt;
        } else {
          failed += 1;
        }
      } catch {
        const finishedAt = deps.clock.now().toISOString();
        connectors.finishPollClaim(
          row.tenantId,
          row.workflowId,
          deps.claimOwner,
          { finishedAtIso: finishedAt, success: false },
        );
        failed += 1;
      }
    }

    return { considered, claimed, polled, skipped, failed };
  }

  return {
    runTick,
    getRunState,
    stop,
    repositories: connectors,
  };
}

function shouldSkipPermanently(
  health: string,
  consecutiveFailures: number,
  maxFailures: number,
): boolean {
  if (health === "auth_failed") {
    return true;
  }
  return consecutiveFailures >= maxFailures;
}

function isDue(
  row: {
    pollIntervalMs: number;
    lastPollFinishedAt: string | null;
    consecutiveFailures: number;
  },
  now: Date,
  defaultInterval: number,
): boolean {
  if (!row.lastPollFinishedAt) {
    return true;
  }
  const baseInterval =
    row.pollIntervalMs > 0 ? row.pollIntervalMs : defaultInterval;
  const backoffMs = Math.min(
    baseInterval * 2 ** Math.min(row.consecutiveFailures, 8),
    MAX_BACKOFF_MS,
  );
  const nextDueMs = new Date(row.lastPollFinishedAt).getTime() + backoffMs;
  return now.getTime() >= nextDueMs;
}

function isPollSuccess(result: PollN8nWorkflowResult): boolean {
  return result.status === "polled";
}
