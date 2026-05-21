import type { EvidenceLevel } from "../terminology.js";

export const UNVERIFIED_DIMENSIONS = [
  "destination_delivery_not_checked",
  "payload_count_supplied_by_workflow",
  "connector_health_unknown",
  "exact_record_matching_unavailable",
] as const;

export type UnverifiedDimension = (typeof UNVERIFIED_DIMENSIONS)[number];

/** Heartbeat/basic evidence must not claim destination or record-level proof. */
export function unverifiedDimensionsForEvidenceLevel(
  evidenceLevel: EvidenceLevel,
): UnverifiedDimension[] {
  if (evidenceLevel === "basic") {
    return [...UNVERIFIED_DIMENSIONS];
  }
  if (evidenceLevel === "medium") {
    return ["exact_record_matching_unavailable"];
  }
  return [];
}
