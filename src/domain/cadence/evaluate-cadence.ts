import type { Clock } from "../clock.js";
import { addMinutes } from "./duration.js";
import {
  evaluateCadenceDeadline,
  type CadenceContractFields,
} from "./evaluate-deadline.js";

export type CadenceHealth = "inactive" | "unknown" | "healthy" | "overdue";

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

  const unknownUntil =
    lastSuccess === null
      ? addMinutes(deadlineAt, input.initialGraceMinutes)
      : deadlineAt;

  if (now.getTime() <= unknownUntil.getTime()) {
    return {
      health: "unknown",
      expectedAt,
      deadlineAt,
      overdueSince: null,
      reasonCode:
        lastSuccess === null
          ? "unknown_awaiting_first_deadline"
          : "unknown_awaiting_occurrence",
    };
  }

  return {
    health: "overdue",
    expectedAt,
    deadlineAt,
    overdueSince: unknownUntil,
    reasonCode:
      lastSuccess === null
        ? "overdue_never_observed"
        : "overdue_missed_deadline",
  };
}
