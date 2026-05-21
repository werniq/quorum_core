import type { EvidenceLevel } from "../terminology.js";
import {
  unverifiedDimensionsForEvidenceLevel,
  type UnverifiedDimension,
} from "../evidence/unverified-dimensions.js";

export const VERIFIED_DIMENSIONS = [
  "execution_evidence_received",
  "cadence_evaluated",
] as const;

export type VerifiedDimension = (typeof VERIFIED_DIMENSIONS)[number];

export function verifiedDimensionsForEvidenceLevel(
  evidenceLevel: EvidenceLevel,
): VerifiedDimension[] {
  if (evidenceLevel === "basic") {
    return ["execution_evidence_received", "cadence_evaluated"];
  }
  if (evidenceLevel === "medium") {
    return ["execution_evidence_received", "cadence_evaluated"];
  }
  return [...VERIFIED_DIMENSIONS];
}

export function plainVerifiedLabels(level: EvidenceLevel): string[] {
  return verifiedDimensionsForEvidenceLevel(level).map((d) => {
    switch (d) {
      case "execution_evidence_received":
        return "Execution evidence was received";
      case "cadence_evaluated":
        return "Cadence / delivery window was evaluated";
      default:
        return d;
    }
  });
}

export function plainUnverifiedLabels(
  unverified: UnverifiedDimension[],
): string[] {
  return unverified.map((d) => {
    switch (d) {
      case "destination_delivery_not_checked":
        return "Destination delivery was not independently checked";
      case "payload_count_supplied_by_workflow":
        return "Item counts are supplied by the workflow, not independently counted";
      case "connector_health_unknown":
        return "Connector health is unknown or stale";
      case "exact_record_matching_unavailable":
        return "Exact record-level matching is not available for this path";
      default:
        return d;
    }
  });
}

export function evidenceExplanationForLevel(
  evidenceLevel: EvidenceLevel,
  unverified: UnverifiedDimension[] = unverifiedDimensionsForEvidenceLevel(
    evidenceLevel,
  ),
): string {
  if (evidenceLevel === "basic") {
    return (
      "Basic evidence: execution was reported to Quorum. " +
      `Unverified: ${plainUnverifiedLabels(unverified).join("; ") || "none"}.`
    );
  }
  if (evidenceLevel === "medium") {
    return (
      "Medium evidence includes an independent aggregate or destination check. " +
      `Unverified: ${plainUnverifiedLabels(unverified).join("; ") || "none"}.`
    );
  }
  return "High evidence: individual source and destination records were reconciled for this window.";
}

export function evidenceRaiseConfidenceHint(
  evidenceLevel: EvidenceLevel,
): string {
  if (evidenceLevel === "basic") {
    return "Raise confidence by adding a validated source→destination reconciliation path (for example HubSpot webinar → Zoom).";
  }
  if (evidenceLevel === "medium") {
    return "Raise confidence with exact record-level matching on a supported reconciliation contract.";
  }
  return "Record-level proof is already in place for the latest verified window.";
}
