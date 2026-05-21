/**
 * Shared product terminology and enums.
 * These define vocabulary only — they do not activate later product features.
 */

export const PRODUCT_NAME = "Quorum" as const;

export const PRODUCT_PRIMARY_QUESTION =
  "What is this business supposed to be doing, is it happening, what evidence proves it, and what requires attention?" as const;

export const PRIVACY_STATEMENT = "We do not need your workflow data." as const;

export const SUPPORTED_AUTOMATION_PLATFORMS = ["n8n"] as const;
export type SupportedAutomationPlatform =
  (typeof SUPPORTED_AUTOMATION_PLATFORMS)[number];

export const EDITIONS = ["self_hosted", "saas"] as const;
export type Edition = (typeof EDITIONS)[number];

export const CAPABILITY_LEVELS = [
  "heartbeat_assurance",
  "corroborated_assurance",
  "record_level_outcome_assurance",
] as const;
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];

export const EVIDENCE_LEVELS = ["basic", "medium", "high"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const CONTRACT_HEALTH_STATES = [
  "healthy",
  "warning",
  "overdue",
  "unknown",
  "inactive",
] as const;
export type ContractHealth = (typeof CONTRACT_HEALTH_STATES)[number];

export const ALERT_CHANNEL_HEALTH_STATES = [
  "unknown",
  "healthy",
  "degraded",
  "failing",
] as const;
export type AlertChannelHealthState =
  (typeof ALERT_CHANNEL_HEALTH_STATES)[number];

export const INCIDENT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const CONTRACT_KINDS = ["workflow", "outcome", "system"] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** Plain-language evidence copy. Health must never imply a stronger evidence level. */
export const EVIDENCE_LEVEL_COPY: Record<
  EvidenceLevel,
  { title: string; body: string }
> = {
  basic: {
    title: "Basic evidence",
    body: "We verified that the workflow reported an acceptable execution. We did not independently verify the destination record.",
  },
  medium: {
    title: "Medium evidence",
    body: "We verified execution evidence plus an independent aggregate, destination, or volume check.",
  },
  high: {
    title: "High evidence",
    body: "We reconciled individual source and destination records.",
  },
};

export const CORE_TERMS = {
  contractCatalog:
    "The primary product surface listing what should happen, current health, evidence level, and attention required.",
  workflowContract:
    "An explicit cadence and result agreement for one external workflow.",
  outcomeContract:
    "An explicit source-to-destination business-result agreement.",
  evidenceEvent:
    "An immutable observation such as a heartbeat, source record, destination record, connector health check, or reconciliation run.",
  evidenceLevel:
    "The visible degree of independent proof: basic, medium, or high.",
  health:
    "Whether the contract is currently satisfied: healthy, warning, overdue, unknown, or inactive.",
  incident: "A stateful operational problem requiring attention.",
  alertChannelHealth:
    "Whether incident notifications are likely to reach the configured destination.",
} as const;
