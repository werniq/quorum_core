/**
 * Evaluate reported volume for a calendar window using accepted heartbeats only.
 */

import {
  computeVolumeWindowForInstant,
  evaluationDeadline,
} from "./compute-window.js";
import type {
  HeartbeatVolumeContribution,
  VolumeEvaluationInput,
  VolumeEvaluationOutcome,
  VolumeEvaluationResult,
} from "./types.js";

function heartbeatInWindow(
  hb: HeartbeatVolumeContribution,
  windowStart: Date,
  windowEnd: Date,
  ruleActivatedAt: Date,
): boolean {
  if (hb.executedAt < windowStart || hb.executedAt >= windowEnd) {
    return false;
  }
  if (hb.executedAt < ruleActivatedAt) {
    return false;
  }
  return hb.status === "success" || hb.status === "empty_result";
}

export function evaluateVolumeBand(
  input: VolumeEvaluationInput,
): VolumeEvaluationOutcome {
  const window = computeVolumeWindowForInstant({
    windowType: input.rule.windowType,
    timezone: input.rule.timezone,
    weekStartsOn: input.rule.weekStartsOn,
    ruleActivatedAt: input.rule.activatedAt,
    now: input.now,
    evaluationGraceMinutes: input.rule.evaluationGraceMinutes,
  });

  const deadline = evaluationDeadline(
    window.windowEnd,
    input.rule.evaluationGraceMinutes,
  );
  const beforeDeadline = input.now < deadline;

  const inWindow = input.heartbeats.filter((hb) =>
    heartbeatInWindow(
      hb,
      window.windowStart,
      window.windowEnd,
      input.rule.activatedAt,
    ),
  );

  let totalItems = 0;
  let unknownCountEvents = 0;
  for (const hb of inWindow) {
    if (hb.itemsProcessed === null || hb.itemsProcessed === undefined) {
      unknownCountEvents += 1;
    } else {
      totalItems += hb.itemsProcessed;
    }
  }

  if (window.isFirstPartialWindow) {
    return {
      window,
      result: "collecting",
      totalItems: unknownCountEvents > 0 ? null : totalItems,
      countedEvents: inWindow.length,
      unknownCountEvents,
      canEvaluate: false,
      evaluationDeadline: deadline,
    };
  }

  if (beforeDeadline) {
    return {
      window,
      result: "collecting",
      totalItems: unknownCountEvents > 0 ? null : totalItems,
      countedEvents: inWindow.length,
      unknownCountEvents,
      canEvaluate: false,
      evaluationDeadline: deadline,
    };
  }

  if (unknownCountEvents > 0) {
    return {
      window,
      result: "inconclusive",
      totalItems: null,
      countedEvents: inWindow.length,
      unknownCountEvents,
      canEvaluate: true,
      evaluationDeadline: deadline,
    };
  }

  let result: VolumeEvaluationResult = "within_band";
  if (totalItems < input.rule.minimumCount) {
    result = "below_minimum";
  } else if (
    input.rule.maximumCount !== null &&
    totalItems > input.rule.maximumCount
  ) {
    result = "above_maximum";
  }

  return {
    window,
    result,
    totalItems,
    countedEvents: inWindow.length,
    unknownCountEvents,
    canEvaluate: true,
    evaluationDeadline: deadline,
  };
}

export function volumeIncidentTypeForResult(
  result: VolumeEvaluationResult,
): "volume_below_minimum" | "volume_above_maximum" | null {
  if (result === "below_minimum") return "volume_below_minimum";
  if (result === "above_maximum") return "volume_above_maximum";
  return null;
}

export function formatVolumeRange(
  minimum: number,
  maximum: number | null,
): string {
  if (maximum === null) {
    return `${minimum} or more`;
  }
  if (minimum === maximum) {
    return String(minimum);
  }
  return `${minimum} to ${maximum}`;
}

export const VOLUME_EVIDENCE_VERIFIED = [
  "workflow reported executions",
  "reported volume was inside or outside the declared band",
] as const;

export const VOLUME_EVIDENCE_NOT_VERIFIED = [
  "exact destination records",
  "destination correctness",
  "independent delivery",
] as const;
