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
  /** Last evidence that satisfied the contract (not merely any heartbeat). */
  lastAcceptableSuccessAt: Date | null;
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
    isFirstEvidenceWindow: contract.lastAcceptableSuccessAt === null,
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
      isFirstEvidenceWindow:
        contract.lastAcceptableSuccessAt === null && n === 0,
    };
  }

  // since_last_success — must be explicit; never silently selected.
  const origin =
    contract.lastAcceptableSuccessAt ?? contract.monitoringStartedAt;
  const expectedOccurrenceAt = addMinutes(origin, intervalMinutes);
  return {
    expectedOccurrenceAt,
    deadlineAt: addMinutes(
      expectedOccurrenceAt,
      contract.allowedLatenessMinutes,
    ),
    isFirstEvidenceWindow: contract.lastAcceptableSuccessAt === null,
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

  if (contract.lastAcceptableSuccessAt) {
    const expectedOccurrenceAt = contract.lastAcceptableSuccessAt;
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
