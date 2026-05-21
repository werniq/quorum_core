import type { EvidenceLevel } from "../terminology.js";
import { unverifiedDimensionsForEvidenceLevel } from "./unverified-dimensions.js";

export type EvidenceContractKind = "heartbeat" | "outcome";

export interface EvidenceLevelInput {
  /** Declared on the contract; never trusted above implemented capabilities. */
  declaredLevel: EvidenceLevel;
  contractKind: EvidenceContractKind;
  /**
   * Destination aggregate proof is not implemented in v1 heartbeat assurance.
   * When false, level cannot rise above basic.
   */
  destinationAggregateImplemented: boolean;
  destinationAggregateFresh: boolean;
  /**
   * Record-level reconciliation is not implemented in v1 heartbeat assurance.
   */
  recordLevelReconciliationImplemented: boolean;
  recordLevelReconciliationFresh: boolean;
  /** Connector unavailable/stale marks evidence stale and may downgrade. */
  connectorStaleOrUnavailable: boolean;
}

export interface ResolvedEvidenceLevel {
  level: EvidenceLevel;
  stale: boolean;
  reasonCode: string;
  unverifiedDimensions: ReturnType<typeof unverifiedDimensionsForEvidenceLevel>;
}

/**
 * Effective evidence level is the minimum of declared level and proven capabilities.
 * Heartbeat-only contracts stay basic. Users cannot force medium/high without proof.
 */
export function resolveEffectiveEvidenceLevel(
  input: EvidenceLevelInput,
): ResolvedEvidenceLevel {
  let capabilityCeiling: EvidenceLevel = "basic";

  if (
    input.recordLevelReconciliationImplemented &&
    input.recordLevelReconciliationFresh
  ) {
    capabilityCeiling = "high";
  } else if (
    input.destinationAggregateImplemented &&
    input.destinationAggregateFresh
  ) {
    capabilityCeiling = "medium";
  }

  const declaredRank = rank(input.declaredLevel);
  const capabilityRank = rank(capabilityCeiling);
  let level = fromRank(Math.min(declaredRank, capabilityRank));

  // Heartbeat contracts without destination proof never leave basic.
  if (
    input.contractKind === "heartbeat" &&
    !input.destinationAggregateImplemented
  ) {
    level = "basic";
  }

  let stale = false;
  let reasonCode = `evidence_${level}`;

  if (input.connectorStaleOrUnavailable) {
    stale = true;
    if (level !== "basic") {
      level = "basic";
      reasonCode = "evidence_downgraded_connector_stale";
    } else {
      reasonCode = "evidence_basic_connector_stale";
    }
  } else if (
    input.declaredLevel !== "basic" &&
    rank(input.declaredLevel) > capabilityRank
  ) {
    reasonCode = "evidence_capped_by_capability";
  }

  return {
    level,
    stale,
    reasonCode,
    unverifiedDimensions: unverifiedDimensionsForEvidenceLevel(level),
  };
}

/** Manual / API attempts to set a higher level than capabilities allow are rejected. */
export function canSetEvidenceLevel(input: {
  requested: EvidenceLevel;
  capabilities: Omit<EvidenceLevelInput, "declaredLevel">;
}): boolean {
  const resolved = resolveEffectiveEvidenceLevel({
    ...input.capabilities,
    declaredLevel: input.requested,
    connectorStaleOrUnavailable: false,
  });
  return resolved.level === input.requested;
}

function rank(level: EvidenceLevel): number {
  switch (level) {
    case "basic":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}

function fromRank(value: number): EvidenceLevel {
  if (value >= 3) return "high";
  if (value >= 2) return "medium";
  return "basic";
}
