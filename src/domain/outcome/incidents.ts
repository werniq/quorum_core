import type { EvidenceLevel } from "../terminology.js";
import type { MatchByEmailResult } from "./match-email.js";

export type OutcomeIncidentKind =
  | "missing_destination_records"
  | "partial_delivery"
  | "connector_unavailable"
  | "schema_drift";

export interface OutcomeIncidentPlan {
  incidentType: OutcomeIncidentKind;
  severity: "critical" | "warning";
  summary: string;
  details: Record<string, unknown>;
}

/**
 * Decide which outcome incidents to open/observe for a completed reconciliation.
 * Waiting records do not open missing incidents.
 */
export function planOutcomeIncidents(input: {
  businessPurpose: string;
  match: MatchByEmailResult;
  evidenceLevel: EvidenceLevel;
  oldestMissingAgeSeconds: number | null;
  runStatus: "healthy" | "warning" | "failed" | "unknown";
}): OutcomeIncidentPlan[] {
  const plans: OutcomeIncidentPlan[] = [];
  const baseDetails = {
    expectedBusinessOutcome: input.businessPurpose,
    sourceCount: input.match.sourceCount,
    destinationCount: input.match.destinationCount,
    matchedCount: input.match.matchedCount,
    missingCount: input.match.missingCount,
    duplicateCount: input.match.duplicateCount,
    lateCount: input.match.lateCount,
    waitingCount: input.match.waitingCount,
    oldestMissingAgeSeconds: input.oldestMissingAgeSeconds,
    evidenceLevel: input.evidenceLevel,
    unverifiedLimitations:
      input.evidenceLevel === "high"
        ? []
        : ["exact_record_matching_incomplete_or_degraded"],
    suggestedRecoveryBoundary:
      "Re-check destination connector, confirm n8n destination step, then re-run reconciliation for the same window. Do not assume root cause without destination evidence.",
  };

  if (input.match.missingCount > 0) {
    const partial = input.match.matchedCount > 0 || input.match.lateCount > 0;
    plans.push({
      incidentType: partial
        ? "partial_delivery"
        : "missing_destination_records",
      severity: input.runStatus === "failed" ? "critical" : "warning",
      summary: partial
        ? `Partial delivery — ${input.match.missingCount} missing`
        : `Missing destination records — ${input.match.missingCount} missing`,
      details: baseDetails,
    });
  }

  if (input.match.duplicateCount > 0 && input.match.missingCount === 0) {
    plans.push({
      incidentType: "partial_delivery",
      severity: "warning",
      summary: `Duplicate destination outcomes — ${input.match.duplicateCount}`,
      details: baseDetails,
    });
  }

  return plans;
}

export function shouldResolveMissingIncidents(
  match: MatchByEmailResult,
): boolean {
  return match.missingCount === 0 && match.waitingCount === 0;
}
