import type { EmptyResultPolicy } from "../contracts/types.js";

export type HeartbeatEvidenceStatus = "success" | "failure" | "empty_result";

export type EmptyResultClassification =
  | "acceptable_success"
  | "warning_empty"
  | "unacceptable";

/**
 * Empty results are contract-specific:
 * - allowed — zero items is acceptable
 * - warning — cadence satisfied but a warning incident opens
 * - failure — zero items is unacceptable and does not satisfy the contract
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

export function isAcceptableSuccess(
  classification: EmptyResultClassification,
): boolean {
  return (
    classification === "acceptable_success" ||
    classification === "warning_empty"
  );
}
