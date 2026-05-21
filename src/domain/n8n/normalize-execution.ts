import type { HeartbeatEvidenceStatus } from "../evidence/empty-result.js";

export interface N8nExecutionRecord {
  id: string | number;
  finished?: boolean;
  status?: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
  workflowId?: string | number;
  /** Optional item count when available without storing full payloads. */
  itemsProcessed?: number | null;
}

export interface NormalizedN8nEvidence {
  executedAt: Date;
  status: "success" | "failure";
  evidenceStatus: HeartbeatEvidenceStatus;
  itemsProcessed: number | null;
  externalExecutionRef: string;
  idempotencyKey: string;
  metadata: {
    source: "n8n_poll";
    n8nStatus: string | null;
  };
}

export type NormalizeN8nExecutionResult =
  | { ok: true; evidence: NormalizedN8nEvidence }
  | { ok: false; code: "NOT_FINISHED" | "INVALID_EXECUTION" | "INVALID_TIME" };

/**
 * Maps an n8n execution into the same evidence shape used by push heartbeats.
 * Does not claim destination delivery; evidence remains basic.
 */
export function normalizeN8nExecution(
  execution: N8nExecutionRecord,
): NormalizeN8nExecutionResult {
  if (
    execution.id === undefined ||
    execution.id === null ||
    (typeof execution.id !== "string" && typeof execution.id !== "number")
  ) {
    return { ok: false, code: "INVALID_EXECUTION" };
  }

  if (execution.finished === false) {
    return { ok: false, code: "NOT_FINISHED" };
  }

  const rawTime = execution.stoppedAt ?? execution.startedAt;
  if (typeof rawTime !== "string" || rawTime.length === 0) {
    return { ok: false, code: "INVALID_TIME" };
  }
  const executedAt = new Date(rawTime);
  if (Number.isNaN(executedAt.getTime())) {
    return { ok: false, code: "INVALID_TIME" };
  }

  const n8nStatus =
    typeof execution.status === "string"
      ? execution.status.toLowerCase()
      : null;
  const success =
    n8nStatus === "success" ||
    n8nStatus === "ok" ||
    (n8nStatus === null && execution.finished === true);

  const status: "success" | "failure" = success ? "success" : "failure";
  let evidenceStatus: HeartbeatEvidenceStatus =
    status === "success" ? "success" : "failure";
  let itemsProcessed =
    execution.itemsProcessed === undefined ? null : execution.itemsProcessed;

  if (
    status === "success" &&
    itemsProcessed !== null &&
    Number.isInteger(itemsProcessed) &&
    itemsProcessed === 0
  ) {
    evidenceStatus = "empty_result";
  }

  if (
    itemsProcessed !== null &&
    (!Number.isInteger(itemsProcessed) || itemsProcessed < 0)
  ) {
    itemsProcessed = null;
  }

  const externalExecutionRef = String(execution.id);
  return {
    ok: true,
    evidence: {
      executedAt,
      status,
      evidenceStatus,
      itemsProcessed,
      externalExecutionRef,
      idempotencyKey: `n8n:execution:${externalExecutionRef}`,
      metadata: {
        source: "n8n_poll",
        n8nStatus,
      },
    },
  };
}
