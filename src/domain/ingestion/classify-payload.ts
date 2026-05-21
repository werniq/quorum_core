import type { HeartbeatEvidenceStatus } from "../evidence/empty-result.js";

export interface InboundHeartbeatPayload {
  schemaVersion: number;
  executedAt: string;
  status: "success" | "failure";
  itemsProcessed?: number;
  externalExecutionRef?: string;
  metadata?: Record<string, unknown>;
}

export type PayloadClassificationResult =
  | {
      ok: true;
      evidenceStatus: HeartbeatEvidenceStatus;
      itemsProcessed: number | null;
      executedAt: Date;
      externalExecutionRef: string | null;
      metadata: Record<string, unknown> | null;
    }
  | {
      ok: false;
      code: "INVALID_SCHEMA" | "INVALID_EXECUTED_AT" | "ITEMS_REQUIRED";
    };

/**
 * Classifies an inbound heartbeat payload into durable evidence status.
 * Does not raise evidence above heartbeat/basic semantics.
 */
export function classifyInboundHeartbeatPayload(
  payload: unknown,
  options: {
    countLessSuccessAllowed: boolean;
  },
): PayloadClassificationResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "INVALID_SCHEMA" };
  }

  const body = payload as Record<string, unknown>;
  if (body.schemaVersion !== 1) {
    return { ok: false, code: "INVALID_SCHEMA" };
  }
  if (body.status !== "success" && body.status !== "failure") {
    return { ok: false, code: "INVALID_SCHEMA" };
  }
  if (typeof body.executedAt !== "string") {
    return { ok: false, code: "INVALID_SCHEMA" };
  }
  const executedAt = new Date(body.executedAt);
  if (Number.isNaN(executedAt.getTime())) {
    return { ok: false, code: "INVALID_EXECUTED_AT" };
  }

  if (
    body.itemsProcessed !== undefined &&
    (typeof body.itemsProcessed !== "number" ||
      !Number.isInteger(body.itemsProcessed) ||
      body.itemsProcessed < 0)
  ) {
    return { ok: false, code: "INVALID_SCHEMA" };
  }

  if (
    body.externalExecutionRef !== undefined &&
    typeof body.externalExecutionRef !== "string"
  ) {
    return { ok: false, code: "INVALID_SCHEMA" };
  }

  if (
    body.metadata !== undefined &&
    (typeof body.metadata !== "object" ||
      body.metadata === null ||
      Array.isArray(body.metadata))
  ) {
    return { ok: false, code: "INVALID_SCHEMA" };
  }

  const itemsProcessed =
    body.itemsProcessed === undefined ? null : body.itemsProcessed;

  if (body.status === "failure") {
    return {
      ok: true,
      evidenceStatus: "failure",
      itemsProcessed,
      executedAt,
      externalExecutionRef:
        typeof body.externalExecutionRef === "string"
          ? body.externalExecutionRef
          : null,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? null,
    };
  }

  // status === success
  if (itemsProcessed === null) {
    if (!options.countLessSuccessAllowed) {
      return { ok: false, code: "ITEMS_REQUIRED" };
    }
    return {
      ok: true,
      evidenceStatus: "success",
      itemsProcessed: null,
      executedAt,
      externalExecutionRef:
        typeof body.externalExecutionRef === "string"
          ? body.externalExecutionRef
          : null,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? null,
    };
  }

  if (itemsProcessed === 0) {
    return {
      ok: true,
      evidenceStatus: "empty_result",
      itemsProcessed: 0,
      executedAt,
      externalExecutionRef:
        typeof body.externalExecutionRef === "string"
          ? body.externalExecutionRef
          : null,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? null,
    };
  }

  return {
    ok: true,
    evidenceStatus: "success",
    itemsProcessed,
    executedAt,
    externalExecutionRef:
      typeof body.externalExecutionRef === "string"
        ? body.externalExecutionRef
        : null,
    metadata: (body.metadata as Record<string, unknown> | undefined) ?? null,
  };
}
