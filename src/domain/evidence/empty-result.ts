import type { EmptyResultPolicy } from "../contracts/types.js";

export type HeartbeatEvidenceStatus = "success" | "failure" | "empty_result";

export type EmptyResultClassification =
  | "acceptable_success"
  | "warning_empty"
  | "unacceptable";

/**
 * Empty results are contract-specific:
 * - allowed — zero items is acceptable success for the contract
 * - warning — cadence/reporting satisfied; warning empty_result incident opens
 * - failure — cadence/reporting satisfied; critical empty_result incident opens
 *
 * Any valid empty-result heartbeat still counts as a received execution for
 * silence / cadence. Policy only drives incidents, not absence.
 */
export function classifyHeartbeatEvidence(
  status: HeartbeatEvidenceStatus,
  emptyResultPolicy: EmptyResultPolicy,
): EmptyResultClassification {
  if (status === "success") {
    return "acceptable_success";
  }
  if (status === "failure") {
    return "unacceptable";
  }

  switch (emptyResultPolicy) {
    case "allowed":
      return "acceptable_success";
    case "warning":
      return "warning_empty";
    case "failure":
      return "unacceptable";
  }
}

/**
 * Whether the report satisfies the *outcome* contract (not merely reporting).
 * Empty with warning/failure policy does not count as outcome success, but
 * still satisfies cadence via last_report / last_execution_at.
 */
export function isAcceptableSuccess(
  classification: EmptyResultClassification,
): boolean {
  return (
    classification === "acceptable_success" ||
    classification === "warning_empty"
  );
}

/** Outcome-level success only (status=success after classification). */
export function isOutcomeSuccess(status: HeartbeatEvidenceStatus): boolean {
  return status === "success";
}
