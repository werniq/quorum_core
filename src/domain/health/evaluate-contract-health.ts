import type { Clock } from "../clock.js";
import {
  evaluateCadenceDeadline,
  type CadenceContractFields,
} from "../cadence/evaluate-deadline.js";
import { addMinutes } from "../cadence/duration.js";
import {
  classifyHeartbeatEvidence,
  type HeartbeatEvidenceStatus,
} from "../evidence/empty-result.js";
import {
  unverifiedDimensionsForEvidenceLevel,
  type UnverifiedDimension,
} from "../evidence/unverified-dimensions.js";
import type { EmptyResultPolicy } from "../contracts/types.js";
import type { ContractHealth, EvidenceLevel } from "../terminology.js";

export interface ContractHealthInput {
  isActive: boolean;
  evidenceLevel: EvidenceLevel;
  emptyResultPolicy: EmptyResultPolicy;
  initialGraceMinutes: number;
  cadence: CadenceContractFields;
  /**
   * Latest heartbeat evidence, if any. Absence is a first-class condition
   * (never-observed / silent absence).
   */
  latestEvidence: {
    status: HeartbeatEvidenceStatus;
    at: Date;
  } | null;
}

export interface ContractHealthResult {
  health: ContractHealth;
  evidenceLevel: EvidenceLevel;
  unverifiedDimensions: UnverifiedDimension[];
  deadlineAt: Date;
  unknownUntilAt: Date | null;
  reasonCode:
    | "inactive"
    | "unknown_awaiting_first_deadline"
    | "overdue_never_observed"
    | "overdue_missed_deadline"
    | "healthy"
    | "warning_empty_result"
    | "overdue_unacceptable_evidence";
}

/**
 * Health and evidence are independent dimensions.
 * Unknown cannot remain unknown forever: after first deadline + initial grace → overdue.
 */
export function evaluateContractHealth(
  input: ContractHealthInput,
  clock: Clock,
): ContractHealthResult {
  const evidenceLevel = input.evidenceLevel;
  const unverifiedDimensions =
    unverifiedDimensionsForEvidenceLevel(evidenceLevel);
  const deadline = evaluateCadenceDeadline(input.cadence, clock);
  const now = clock.now();
  const unknownUntilAt =
    input.cadence.lastEvidenceAt === null
      ? addMinutes(deadline.deadlineAt, input.initialGraceMinutes)
      : null;

  if (!input.isActive) {
    return {
      health: "inactive",
      evidenceLevel,
      unverifiedDimensions,
      deadlineAt: deadline.deadlineAt,
      unknownUntilAt: null,
      reasonCode: "inactive",
    };
  }

  const latest = input.latestEvidence;
  const classification = latest
    ? classifyHeartbeatEvidence(latest.status, input.emptyResultPolicy)
    : null;

  // Any valid report covers silence for this occurrence; hard failure is separate.
  const reportingCoversOccurrence =
    latest !== null &&
    latest.at.getTime() >= deadline.expectedOccurrenceAt.getTime();

  if (!reportingCoversOccurrence) {
    if (unknownUntilAt !== null && now.getTime() <= unknownUntilAt.getTime()) {
      return {
        health: "unknown",
        evidenceLevel,
        unverifiedDimensions,
        deadlineAt: deadline.deadlineAt,
        unknownUntilAt,
        reasonCode: "unknown_awaiting_first_deadline",
      };
    }

    return {
      health: "overdue",
      evidenceLevel,
      unverifiedDimensions,
      deadlineAt: deadline.deadlineAt,
      unknownUntilAt,
      reasonCode: latest ? "overdue_missed_deadline" : "overdue_never_observed",
    };
  }

  // Occurrence was observed, but deadline/quiet window may still have elapsed
  // (event-driven quiet window, or next slot already due for cron/interval).
  if (now.getTime() > deadline.deadlineAt.getTime()) {
    return {
      health: "overdue",
      evidenceLevel,
      unverifiedDimensions,
      deadlineAt: deadline.deadlineAt,
      unknownUntilAt,
      reasonCode: "overdue_missed_deadline",
    };
  }

  // Empty-result reports satisfy cadence; policy violations are incidents.
  if (
    latest?.status === "empty_result" &&
    (classification === "warning_empty" || classification === "unacceptable")
  ) {
    return {
      health: "healthy",
      evidenceLevel,
      unverifiedDimensions,
      deadlineAt: deadline.deadlineAt,
      unknownUntilAt,
      reasonCode:
        classification === "warning_empty" ? "warning_empty_result" : "healthy",
    };
  }

  if (classification === "unacceptable") {
    return {
      health: "overdue",
      evidenceLevel,
      unverifiedDimensions,
      deadlineAt: deadline.deadlineAt,
      unknownUntilAt,
      reasonCode: "overdue_unacceptable_evidence",
    };
  }

  if (classification === "warning_empty") {
    return {
      health: "warning",
      evidenceLevel,
      unverifiedDimensions,
      deadlineAt: deadline.deadlineAt,
      unknownUntilAt,
      reasonCode: "warning_empty_result",
    };
  }

  return {
    health: "healthy",
    evidenceLevel,
    unverifiedDimensions,
    deadlineAt: deadline.deadlineAt,
    unknownUntilAt,
    reasonCode: "healthy",
  };
}
