import { CronExpressionParser } from "cron-parser";
import type { Clock } from "../clock.js";
import type { CadenceType, IntervalMode } from "../contracts/types.js";
import { addMinutes, parsePositiveDurationMinutes } from "./duration.js";

export interface CadenceContractFields {
  cadenceType: CadenceType;
  cadenceValue: string;
  intervalMode: IntervalMode | null;
  scheduleAnchorAt: Date | null;
  timezone: string | null;
  allowedLatenessMinutes: number;
  maxQuietWindowMinutes: number | null;
  /** When monitoring/contract observation began (activation or monitoring start). */
  monitoringStartedAt: Date;
  /**
   * Last heartbeat of any status (success, failure, or empty).
   * Used for silence / reporting presence — not only acceptable success.
   */
  lastEvidenceAt: Date | null;
}

export interface DeadlineEvaluation {
  expectedOccurrenceAt: Date;
  deadlineAt: Date;
  /** True when this deadline is the contract's first expected evidence window. */
  isFirstEvidenceWindow: boolean;
}

export class CadenceEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CadenceEvaluationError";
  }
}

/**
 * Computes the current expected occurrence and deadline for a heartbeat contract.
 * Previous successes never satisfy a later occurrence; late runs do not shift fixed-rate slots.
 */
export function evaluateCadenceDeadline(
  contract: CadenceContractFields,
  clock: Clock,
): DeadlineEvaluation {
  const now = clock.now();

  switch (contract.cadenceType) {
    case "cron":
      return evaluateCronDeadline(contract, now);
    case "interval":
      return evaluateIntervalDeadline(contract, now);
    case "event_driven":
      return evaluateEventDrivenDeadline(contract, now);
    default: {
      const _exhaustive: never = contract.cadenceType;
      throw new CadenceEvaluationError(`Unsupported cadence: ${_exhaustive}`);
    }
  }
}

function evaluateCronDeadline(
  contract: CadenceContractFields,
  now: Date,
): DeadlineEvaluation {
  if (!contract.timezone) {
    throw new CadenceEvaluationError("Cron cadence requires a timezone.");
  }

  const expression = CronExpressionParser.parse(contract.cadenceValue, {
    currentDate: now,
    tz: contract.timezone,
  });
  const previous = expression.prev().toDate();
  const deadlineAt = addMinutes(previous, contract.allowedLatenessMinutes);

  return {
    expectedOccurrenceAt: previous,
    deadlineAt,
    isFirstEvidenceWindow: contract.lastEvidenceAt === null,
  };
}

function evaluateIntervalDeadline(
  contract: CadenceContractFields,
  now: Date,
): DeadlineEvaluation {
  if (!contract.intervalMode) {
    throw new CadenceEvaluationError(
      "Interval cadence requires an explicit interval_mode.",
    );
  }

  const intervalMinutes = parsePositiveDurationMinutes(contract.cadenceValue);
  if (intervalMinutes === null) {
    throw new CadenceEvaluationError(
      "Interval cadence requires a positive duration.",
    );
  }

  if (contract.intervalMode === "fixed_rate") {
    if (!contract.scheduleAnchorAt) {
      throw new CadenceEvaluationError(
        "Fixed-rate interval requires schedule_anchor_at.",
      );
    }
    const anchor = contract.scheduleAnchorAt;
    const elapsedMs = now.getTime() - anchor.getTime();
    const intervalMs = intervalMinutes * 60_000;
    const n = elapsedMs < 0 ? 0 : Math.floor(elapsedMs / intervalMs);
    const expectedOccurrenceAt = new Date(anchor.getTime() + n * intervalMs);
    return {
      expectedOccurrenceAt,
      deadlineAt: addMinutes(
        expectedOccurrenceAt,
        contract.allowedLatenessMinutes,
      ),
      isFirstEvidenceWindow: contract.lastEvidenceAt === null && n === 0,
    };
  }

  // since_last_success — must be explicit; never silently selected.
  // Origin is last reporting evidence (any status), so failure heartbeats
  // reset the quiet/interval timer and clear silence.
  const origin = contract.lastEvidenceAt ?? contract.monitoringStartedAt;
  const expectedOccurrenceAt = addMinutes(origin, intervalMinutes);
  return {
    expectedOccurrenceAt,
    deadlineAt: addMinutes(
      expectedOccurrenceAt,
      contract.allowedLatenessMinutes,
    ),
    isFirstEvidenceWindow: contract.lastEvidenceAt === null,
  };
}

function evaluateEventDrivenDeadline(
  contract: CadenceContractFields,
  now: Date,
): DeadlineEvaluation {
  void now;
  if (
    contract.maxQuietWindowMinutes === null ||
    contract.maxQuietWindowMinutes <= 0
  ) {
    throw new CadenceEvaluationError(
      "Event-driven cadence requires a positive max quiet window.",
    );
  }

  if (contract.lastEvidenceAt) {
    const expectedOccurrenceAt = contract.lastEvidenceAt;
    return {
      expectedOccurrenceAt,
      deadlineAt: addMinutes(
        expectedOccurrenceAt,
        contract.maxQuietWindowMinutes,
      ),
      isFirstEvidenceWindow: false,
    };
  }

  // Before any heartbeat: monitoring_started_at + initial quiet window.
  const expectedOccurrenceAt = contract.monitoringStartedAt;
  return {
    expectedOccurrenceAt,
    deadlineAt: addMinutes(
      expectedOccurrenceAt,
      contract.maxQuietWindowMinutes,
    ),
    isFirstEvidenceWindow: true,
  };
}

/**
 * Whether an acceptable success at `successAt` covers the expected occurrence
 * for the current deadline window. A prior success never covers a later slot.
 */
export function successCoversOccurrence(
  successAt: Date,
  expectedOccurrenceAt: Date,
  nextOccurrenceAt: Date | null,
): boolean {
  if (successAt.getTime() < expectedOccurrenceAt.getTime()) {
    return false;
  }
  if (
    nextOccurrenceAt !== null &&
    successAt.getTime() >= nextOccurrenceAt.getTime()
  ) {
    return false;
  }
  return true;
}

/**
 * First expected occurrence after `lastEvidence` that still needs a report,
 * with its lateness deadline. Used so fixed-rate / cron evaluation does not
 * roll the overdue gate forward with the current clock slot when lateness
 * is longer than the interval.
 */
export function firstMissedOccurrenceAfterSuccess(
  contract: CadenceContractFields,
  lastEvidence: Date,
): { expectedOccurrenceAt: Date; deadlineAt: Date } {
  switch (contract.cadenceType) {
    case "interval":
      return firstMissedIntervalAfterEvidence(contract, lastEvidence);
    case "cron":
      return firstMissedCronAfterEvidence(contract, lastEvidence);
    case "event_driven": {
      if (
        contract.maxQuietWindowMinutes === null ||
        contract.maxQuietWindowMinutes <= 0
      ) {
        throw new CadenceEvaluationError(
          "Event-driven cadence requires a positive max quiet window.",
        );
      }
      return {
        expectedOccurrenceAt: lastEvidence,
        deadlineAt: addMinutes(lastEvidence, contract.maxQuietWindowMinutes),
      };
    }
    default: {
      const _exhaustive: never = contract.cadenceType;
      throw new CadenceEvaluationError(`Unsupported cadence: ${_exhaustive}`);
    }
  }
}

function firstMissedIntervalAfterEvidence(
  contract: CadenceContractFields,
  lastEvidence: Date,
): { expectedOccurrenceAt: Date; deadlineAt: Date } {
  if (!contract.intervalMode) {
    throw new CadenceEvaluationError(
      "Interval cadence requires an explicit interval_mode.",
    );
  }
  const intervalMinutes = parsePositiveDurationMinutes(contract.cadenceValue);
  if (intervalMinutes === null) {
    throw new CadenceEvaluationError(
      "Interval cadence requires a positive duration.",
    );
  }

  if (contract.intervalMode === "since_last_success") {
    const expectedOccurrenceAt = addMinutes(lastEvidence, intervalMinutes);
    return {
      expectedOccurrenceAt,
      deadlineAt: addMinutes(
        expectedOccurrenceAt,
        contract.allowedLatenessMinutes,
      ),
    };
  }

  if (!contract.scheduleAnchorAt) {
    throw new CadenceEvaluationError(
      "Fixed-rate interval requires schedule_anchor_at.",
    );
  }
  const anchor = contract.scheduleAnchorAt;
  const intervalMs = intervalMinutes * 60_000;
  const elapsedMs = lastEvidence.getTime() - anchor.getTime();
  const coveredN = elapsedMs < 0 ? -1 : Math.floor(elapsedMs / intervalMs);
  const firstMissedN = coveredN + 1;
  const expectedOccurrenceAt = new Date(
    anchor.getTime() + firstMissedN * intervalMs,
  );
  return {
    expectedOccurrenceAt,
    deadlineAt: addMinutes(
      expectedOccurrenceAt,
      contract.allowedLatenessMinutes,
    ),
  };
}

function firstMissedCronAfterEvidence(
  contract: CadenceContractFields,
  lastEvidence: Date,
): { expectedOccurrenceAt: Date; deadlineAt: Date } {
  if (!contract.timezone) {
    throw new CadenceEvaluationError("Cron cadence requires a timezone.");
  }
  const expression = CronExpressionParser.parse(contract.cadenceValue, {
    currentDate: lastEvidence,
    tz: contract.timezone,
  });
  const expectedOccurrenceAt = expression.next().toDate();
  return {
    expectedOccurrenceAt,
    deadlineAt: addMinutes(
      expectedOccurrenceAt,
      contract.allowedLatenessMinutes,
    ),
  };
}
