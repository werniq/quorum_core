export const HEARTBEAT_METADATA_MAX_BYTES = 8192;

const FORBIDDEN_METADATA_KEY_PATTERN =
  /(secret|password|passwd|token|authorization|api[_-]?key|private[_-]?key|credential)/i;

export type HeartbeatEventStatus = "success" | "failure" | "empty_result";

export type WorkflowLastStatus = HeartbeatEventStatus | "unknown";

export type WorkflowHealth =
  | "healthy"
  | "warning"
  | "overdue"
  | "unknown"
  | "inactive";

export type CredentialStatus = "active" | "revoked";

export interface HeartbeatMetadataSanitizationResult {
  ok: boolean;
  metadataJson: string | null;
  issues: string[];
}

/**
 * Heartbeat metadata must be sanitized and size-limited.
 * Raw secrets and unrestricted execution payloads are rejected.
 */
export function sanitizeHeartbeatMetadata(
  metadata: unknown,
): HeartbeatMetadataSanitizationResult {
  const issues: string[] = [];

  if (metadata === null || metadata === undefined) {
    return { ok: true, metadataJson: null, issues };
  }

  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return {
      ok: false,
      metadataJson: null,
      issues: ["metadata must be a plain object when provided"],
    };
  }

  const input = metadata as Record<string, unknown>;
  if (
    "payload" in input ||
    "raw_payload" in input ||
    "execution_data" in input
  ) {
    issues.push(
      "unrestricted execution payload fields are not allowed in metadata",
    );
  }

  for (const key of Object.keys(input)) {
    if (FORBIDDEN_METADATA_KEY_PATTERN.test(key)) {
      issues.push(
        `metadata key "${key}" looks like a secret and is not allowed`,
      );
    }
  }

  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(input);
  } catch {
    return {
      ok: false,
      metadataJson: null,
      issues: ["metadata is not JSON-serializable"],
    };
  }

  if (Buffer.byteLength(metadataJson, "utf8") > HEARTBEAT_METADATA_MAX_BYTES) {
    issues.push(`metadata_json exceeds ${HEARTBEAT_METADATA_MAX_BYTES} bytes`);
  }

  if (issues.length > 0) {
    return { ok: false, metadataJson: null, issues };
  }

  return { ok: true, metadataJson, issues };
}

export function assertItemsProcessedValid(
  itemsProcessed: number | null | undefined,
): boolean {
  if (itemsProcessed === null || itemsProcessed === undefined) {
    return true;
  }
  return Number.isInteger(itemsProcessed) && itemsProcessed >= 0;
}
