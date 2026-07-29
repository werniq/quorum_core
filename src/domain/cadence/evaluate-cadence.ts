import type { Clock } from "../clock.js";
import { addMinutes } from "./duration.js";
import {
  evaluateCadenceDeadline,
  firstMissedOccurrenceAfterSuccess,
  type CadenceContractFields,
} from "./evaluate-deadline.js";

export type CadenceHealth =
  | "inactive"
  | "unknown"
  | "healthy"
  | "warning"
  | "overdue";

export interface CadenceEvaluation {
  health: CadenceHealth;
  expectedAt: Date | null;
  deadlineAt: Date | null;
  overdueSince: Date | null;
  reasonCode: string;
}

export interface CadenceEvaluatorInput {
  isActive: boolean;
  /** Extends the first evidence window before unknown becomes overdue. */
  initialGraceMinutes: number;
  contract: CadenceContractFields;
}

/**
 * Deterministic cadence evaluation for the watcher.
 * Uses only an injected Clock; late fixed-rate/cron evidence never shifts future slots.
 *
 * After a success, overdue is keyed to the *first missed* occurrence after that
 * success (plus allowed lateness), not the rolling current clock slot — so a
 * 1-minute interval with 5-minute lateness can still become overdue.
 */
export function evaluateCadence(
  input: CadenceEvaluatorInput,
  clock: Clock,
): CadenceEvaluation {
  if (!input.isActive) {
    return {
      health: "inactive",
      expectedAt: null,
      deadlineAt: null,
      overdueSince: null,
      reasonCode: "inactive",
    };
  }

  const deadline = evaluateCadenceDeadline(input.contract, clock);
  const now = clock.now();
  const expectedAt = deadline.expectedOccurrenceAt;
  const deadlineAt = deadline.deadlineAt;
  const lastSuccess = input.contract.lastAcceptableSuccessAt;

  const coversCurrentOccurrence =
    lastSuccess !== null && lastSuccess.getTime() >= expectedAt.getTime();

  // Event-driven quiet windows expire even when last success is the origin.
  // Cron/fixed-rate stay healthy for the rest of a satisfied slot.
  if (coversCurrentOccurrence) {
    if (
      input.contract.cadenceType === "event_driven" &&
      now.getTime() > deadlineAt.getTime()
    ) {
      return {
        health: "overdue",
        expectedAt,
        deadlineAt,
        overdueSince: deadlineAt,
        reasonCode: "overdue_missed_deadline",
      };
    }
    return {
      health: "healthy",
      expectedAt,
      deadlineAt,
      overdueSince: null,
      reasonCode: "healthy_occurrence_satisfied",
    };
  }

  if (lastSuccess === null) {
    const unknownUntil = addMinutes(deadlineAt, input.initialGraceMinutes);
    if (now.getTime() <= unknownUntil.getTime()) {
      return {
        health: "unknown",
        expectedAt,
        deadlineAt,
        overdueSince: null,
        reasonCode: "unknown_awaiting_first_deadline",
      };
    }
    return {
      health: "overdue",
      expectedAt,
      deadlineAt,
      overdueSince: unknownUntil,
      reasonCode: "overdue_never_observed",
    };
  }

  const missed = firstMissedOccurrenceAfterSuccess(input.contract, lastSuccess);
  if (now.getTime() <= missed.expectedOccurrenceAt.getTime()) {
    // Between a covered slot and the next expected start — still healthy.
    return {
      health: "healthy",
      expectedAt: missed.expectedOccurrenceAt,
      deadlineAt: missed.deadlineAt,
      overdueSince: null,
      reasonCode: "healthy_occurrence_satisfied",
    };
  }

  if (now.getTime() <= missed.deadlineAt.getTime()) {
    return {
      health: "warning",
      expectedAt: missed.expectedOccurrenceAt,
      deadlineAt: missed.deadlineAt,
      overdueSince: null,
      reasonCode: "warning_no_recent_execution",
    };
  }

  return {
    health: "overdue",
    expectedAt: missed.expectedOccurrenceAt,
    deadlineAt: missed.deadlineAt,
    overdueSince: missed.deadlineAt,
    reasonCode: "overdue_missed_deadline",
  };
}
