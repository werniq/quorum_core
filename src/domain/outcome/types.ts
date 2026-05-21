import type { EvidenceLevel } from "../terminology.js";

export type OutcomeContractType = "reconciliation" | "aggregate_check";

export type OutcomeConnectorProvider = "hubspot" | "zoom";

export type OutcomeConnectorType = "source" | "destination";

export type OutcomeConnectorStatus =
  | "pending"
  | "active"
  | "invalid"
  | "disconnected"
  | "paused";

export type ReconciliationRunStatus =
  | "running"
  | "healthy"
  | "warning"
  | "failed"
  | "unknown";

export type ReconciliationMatchStatus =
  | "matched"
  | "missing"
  | "duplicate"
  | "late"
  | "waiting"
  | "ignored";

/** First validated path: HubSpot webinar registrations → Zoom webinar registrants. */
export const FIRST_SUPPORTED_PATH = {
  id: "hubspot_webinar_to_zoom_registrants",
  sourceProvider: "hubspot" as const,
  destinationProvider: "zoom" as const,
  sourceObjectType: "hubspot_webinar_registration",
  destinationObjectType: "zoom_webinar_registrant",
  matchStrategy: "normalized_email" as const,
  defaultMaximumDeliveryDelayMinutes: 5,
  evidenceLevelTarget: "high" as const satisfies EvidenceLevel,
};

export interface MatchKeyDefinition {
  strategy: "normalized_email";
  sourceField: string;
  destinationField: string;
  /** HubSpot marketing event / webinar id */
  sourceObjectId: string;
  /** Zoom webinar id */
  destinationObjectId: string;
}

export interface OutcomeContractInput {
  name: string;
  businessPurpose: string;
  contractType: OutcomeContractType;
  sourceConnectorId: string;
  destinationConnectorId: string;
  sourceObjectType: string;
  destinationObjectType: string;
  matchKeyDefinition: MatchKeyDefinition;
  sourceTimeField: string;
  destinationTimeField: string;
  maximumDeliveryDelayMinutes: number;
  acceptableMissingCount: number;
  acceptableMissingPercentage: number;
  scheduleExpression: string;
  timezone: string;
  evidenceLevelTarget: "medium" | "high";
  retentionDays: number;
  isActive: boolean;
}

export type OutcomeContractValidationResult =
  | { ok: true }
  | { ok: false; issues: string[] };

export function validateOutcomeContract(
  input: OutcomeContractInput,
): OutcomeContractValidationResult {
  const issues: string[] = [];

  if (!input.name.trim()) {
    issues.push("name_required");
  }
  if (!input.businessPurpose.trim()) {
    issues.push("business_purpose_required");
  }
  if (input.sourceConnectorId === input.destinationConnectorId) {
    issues.push("source_and_destination_must_differ");
  }
  if (input.maximumDeliveryDelayMinutes < 0) {
    issues.push("maximum_delivery_delay_invalid");
  }
  if (input.acceptableMissingCount < 0) {
    issues.push("acceptable_missing_count_invalid");
  }
  if (
    input.acceptableMissingPercentage < 0 ||
    input.acceptableMissingPercentage > 100
  ) {
    issues.push("acceptable_missing_percentage_invalid");
  }
  if (input.retentionDays <= 0) {
    issues.push("retention_days_invalid");
  }
  if (!input.timezone.trim()) {
    issues.push("timezone_required");
  }
  if (!input.scheduleExpression.trim()) {
    issues.push("schedule_expression_required");
  }

  const match = input.matchKeyDefinition;
  if (match.strategy !== "normalized_email") {
    issues.push("unsupported_match_strategy");
  }
  if (!match.sourceObjectId.trim() || !match.destinationObjectId.trim()) {
    issues.push("match_object_ids_required");
  }

  if (input.contractType === "reconciliation") {
    if (
      input.evidenceLevelTarget !== "high" &&
      input.evidenceLevelTarget !== "medium"
    ) {
      issues.push("evidence_level_target_invalid");
    }
    if (
      input.sourceObjectType !== FIRST_SUPPORTED_PATH.sourceObjectType ||
      input.destinationObjectType !== FIRST_SUPPORTED_PATH.destinationObjectType
    ) {
      issues.push("unsupported_reconciliation_path");
    }
  }

  if (
    input.contractType === "aggregate_check" &&
    input.evidenceLevelTarget === "high"
  ) {
    issues.push("aggregate_check_cannot_target_high");
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Evidence achieved by a completed run: aggregate counts → medium max;
 * exact record matching → high when every source row is accounted for under policy.
 */
export function evidenceLevelAchievedForRun(input: {
  contractType: OutcomeContractType;
  evidenceLevelTarget: "medium" | "high";
  matchedExactly: boolean;
  aggregateOnly: boolean;
}): "medium" | "high" {
  if (input.contractType === "aggregate_check" || input.aggregateOnly) {
    return "medium";
  }
  if (input.matchedExactly && input.evidenceLevelTarget === "high") {
    return "high";
  }
  return "medium";
}
