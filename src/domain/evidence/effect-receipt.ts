/**
 * Optional self-reported effect receipt nested under heartbeat metadata.
 * All fields are optional. Malformed values are ignored (treated as absent).
 * Storage uses existing metadata_json — no heartbeat schema change required.
 *
 * Canonical shape (camelCase preferred; snake_case aliases accepted):
 *
 * metadata.receipt = {
 *   inputBatchId?: string,
 *   expectedCount?: number,   // non-negative integer — evaluated today
 *   writtenCount?: number,    // non-negative integer — evaluated today
 *   rejectedCount?: number,   // retained for future checks
 *   skippedCount?: number,    // retained for future checks
 *   destinationName?: string, // retained for future checks
 *   watermarkBefore?: string, // retained for future checks
 *   watermarkAfter?: string,  // retained for future checks
 *   exceptionOwner?: string,  // retained for future checks
 *   requiredFieldsValid?: boolean // retained for future checks
 * }
 *
 * Accepted alias: metadata.effect (same object shape as metadata.receipt).
 *
 * Only expectedCount vs writtenCount is evaluated today. Missing, partial, or
 * malformed counts are not_evaluated and must not resolve an open
 * effect_count_mismatch — only a later matching pair resolves it.
 */

export interface EffectReceipt {
  inputBatchId: string | null;
  expectedCount: number | null;
  writtenCount: number | null;
  rejectedCount: number | null;
  skippedCount: number | null;
  destinationName: string | null;
  watermarkBefore: string | null;
  watermarkAfter: string | null;
  exceptionOwner: string | null;
  requiredFieldsValid: boolean | null;
}

export type EffectReconciliationStatus =
  | "not_configured"
  | "not_evaluated"
  | "passed"
  | "breached";

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function pickReceiptObject(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const raw = metadata.receipt ?? metadata.effect;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

/**
 * Soft-parse a receipt from heartbeat metadata. Never throws.
 * Missing or malformed receipt → empty optional fields (not an ingest error).
 */
export function extractEffectReceipt(
  metadata: Record<string, unknown> | null | undefined,
): EffectReceipt {
  const raw = pickReceiptObject(metadata);
  if (!raw) {
    return {
      inputBatchId: null,
      expectedCount: null,
      writtenCount: null,
      rejectedCount: null,
      skippedCount: null,
      destinationName: null,
      watermarkBefore: null,
      watermarkAfter: null,
      exceptionOwner: null,
      requiredFieldsValid: null,
    };
  }
  return {
    inputBatchId: asOptionalString(
      raw.inputBatchId ?? raw.input_batch_id ?? raw.batchId ?? raw.batch_id,
    ),
    expectedCount: asNonNegativeInt(
      raw.expectedCount ?? raw.expected_count ?? raw.expected,
    ),
    writtenCount: asNonNegativeInt(
      raw.writtenCount ?? raw.written_count ?? raw.written,
    ),
    rejectedCount: asNonNegativeInt(
      raw.rejectedCount ?? raw.rejected_count ?? raw.rejected,
    ),
    skippedCount: asNonNegativeInt(
      raw.skippedCount ?? raw.skipped_count ?? raw.skipped,
    ),
    destinationName: asOptionalString(
      raw.destinationName ?? raw.destination_name ?? raw.destination,
    ),
    watermarkBefore: asOptionalString(
      raw.watermarkBefore ?? raw.watermark_before,
    ),
    watermarkAfter: asOptionalString(raw.watermarkAfter ?? raw.watermark_after),
    exceptionOwner: asOptionalString(raw.exceptionOwner ?? raw.exception_owner),
    requiredFieldsValid: asOptionalBoolean(
      raw.requiredFieldsValid ?? raw.required_fields_valid,
    ),
  };
}

/**
 * Basic count reconciliation. Gated by contract flag.
 * Currently evaluates only expectedCount vs writtenCount.
 * Other receipt fields are parsed/retained but not evaluated.
 * - disabled → not_configured (no incident effect)
 * - missing expected or written → not_evaluated (does not open or resolve)
 * - equal counts → passed (may resolve open mismatch)
 * - unequal → breached (open/update one mismatch incident)
 */
export function evaluateEffectReceipt(input: {
  enabled: boolean;
  metadata: Record<string, unknown> | null | undefined;
}): {
  status: EffectReconciliationStatus;
  receipt: EffectReceipt;
  shouldOpenIncident: boolean;
  shouldResolveIncident: boolean;
} {
  const receipt = extractEffectReceipt(input.metadata);
  if (!input.enabled) {
    return {
      status: "not_configured",
      receipt,
      shouldOpenIncident: false,
      shouldResolveIncident: false,
    };
  }
  if (receipt.expectedCount === null || receipt.writtenCount === null) {
    return {
      status: "not_evaluated",
      receipt,
      shouldOpenIncident: false,
      shouldResolveIncident: false,
    };
  }
  if (receipt.expectedCount === receipt.writtenCount) {
    return {
      status: "passed",
      receipt,
      shouldOpenIncident: false,
      shouldResolveIncident: true,
    };
  }
  return {
    status: "breached",
    receipt,
    shouldOpenIncident: true,
    shouldResolveIncident: false,
  };
}
