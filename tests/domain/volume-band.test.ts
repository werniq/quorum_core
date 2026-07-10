import { describe, expect, it } from "vitest";
import {
  computeVolumeWindow,
  computeVolumeWindowForInstant,
  evaluationDeadline,
  isValidIanaTimezone,
} from "../../src/domain/volume/compute-window.js";
import {
  evaluateVolumeBand,
  formatVolumeRange,
  volumeIncidentTypeForResult,
} from "../../src/domain/volume/evaluate-volume-band.js";
import type { ContractVolumeRule } from "../../src/domain/volume/types.js";
import { resolveEffectiveEvidenceLevel } from "../../src/domain/evidence/resolve-evidence-level.js";

function baseRule(
  overrides: Partial<ContractVolumeRule> = {},
): ContractVolumeRule {
  return {
    id: "rule-1",
    tenantId: "t1",
    workflowContractId: "c1",
    minimumCount: 10,
    maximumCount: 100,
    windowType: "daily",
    timezone: "UTC",
    weekStartsOn: 1,
    evaluationGraceMinutes: 15,
    violationSeverity: "warning",
    isActive: true,
    activatedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("volume window semantics", () => {
  it("validates IANA timezones", () => {
    expect(isValidIanaTimezone("Europe/Warsaw")).toBe(true);
    expect(isValidIanaTimezone("Not/AZone")).toBe(false);
  });

  it("computes daily window boundaries in timezone", () => {
    const now = new Date("2026-03-15T14:30:00.000Z");
    const { windowStart, windowEnd } = computeVolumeWindow("daily", "UTC", now);
    expect(windowStart.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(windowEnd.toISOString()).toBe("2026-03-16T00:00:00.000Z");
  });

  it("computes weekly window with Monday start", () => {
    const now = new Date("2026-03-18T12:00:00.000Z"); // Wednesday
    const w = computeVolumeWindowForInstant({
      windowType: "weekly",
      timezone: "UTC",
      weekStartsOn: 1,
      ruleActivatedAt: new Date("2026-01-01T00:00:00.000Z"),
      now,
    });
    expect(w.windowStart.getUTCDay()).toBe(1);
  });

  it("computes monthly window", () => {
    const now = new Date("2026-02-15T12:00:00.000Z");
    const { windowStart, windowEnd } = computeVolumeWindow(
      "monthly",
      "UTC",
      now,
    );
    expect(windowStart.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(windowEnd.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("handles month-end and leap year February", () => {
    const now = new Date("2024-02-29T12:00:00.000Z");
    const { windowEnd } = computeVolumeWindow("monthly", "UTC", now);
    expect(windowEnd.toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });

  it("marks first partial window after mid-window activation", () => {
    const w = computeVolumeWindowForInstant({
      windowType: "daily",
      timezone: "UTC",
      ruleActivatedAt: new Date("2026-03-15T10:00:00.000Z"),
      now: new Date("2026-03-15T14:00:00.000Z"),
    });
    expect(w.isFirstPartialWindow).toBe(true);
  });
});

describe("evaluateVolumeBand", () => {
  it("daily total within band", () => {
    const rule = baseRule({
      minimumCount: 5,
      maximumCount: 20,
      evaluationGraceMinutes: 0,
    });
    const window = computeVolumeWindow(
      "daily",
      "UTC",
      new Date("2026-03-15T18:00:00.000Z"),
    );
    const now = evaluationDeadline(
      window.windowEnd,
      rule.evaluationGraceMinutes,
    );
    const outcome = evaluateVolumeBand({
      rule,
      now,
      heartbeats: [
        {
          executedAt: new Date("2026-03-15T08:00:00.000Z"),
          itemsProcessed: 7,
          status: "success",
        },
      ],
    });
    expect(outcome.result).toBe("within_band");
    expect(outcome.totalItems).toBe(7);
  });

  it("weekly total below minimum including exactly zero", () => {
    const rule = baseRule({
      windowType: "weekly",
      minimumCount: 1,
      maximumCount: null,
      evaluationGraceMinutes: 0,
    });
    const window = computeVolumeWindowForInstant({
      windowType: "weekly",
      timezone: "UTC",
      weekStartsOn: 1,
      ruleActivatedAt: rule.activatedAt,
      now: new Date("2026-03-22T01:00:00.000Z"),
      evaluationGraceMinutes: 0,
    });
    const now = evaluationDeadline(
      window.windowEnd,
      rule.evaluationGraceMinutes,
    );
    const outcome = evaluateVolumeBand({ rule, now, heartbeats: [] });
    expect(outcome.result).toBe("below_minimum");
    expect(outcome.totalItems).toBe(0);
  });

  it("total above maximum", () => {
    const rule = baseRule({
      minimumCount: 1,
      maximumCount: 5,
      evaluationGraceMinutes: 0,
    });
    const window = computeVolumeWindow(
      "daily",
      "UTC",
      new Date("2026-03-15T18:00:00.000Z"),
    );
    const now = evaluationDeadline(
      window.windowEnd,
      rule.evaluationGraceMinutes,
    );
    const outcome = evaluateVolumeBand({
      rule,
      now,
      heartbeats: [
        {
          executedAt: new Date("2026-03-15T10:00:00.000Z"),
          itemsProcessed: 9,
          status: "success",
        },
      ],
    });
    expect(outcome.result).toBe("above_maximum");
  });

  it("nullable maximum allows any high total", () => {
    const rule = baseRule({
      minimumCount: 1,
      maximumCount: null,
      evaluationGraceMinutes: 0,
    });
    const window = computeVolumeWindow(
      "daily",
      "UTC",
      new Date("2026-03-15T18:00:00.000Z"),
    );
    const now = evaluationDeadline(
      window.windowEnd,
      rule.evaluationGraceMinutes,
    );
    const outcome = evaluateVolumeBand({
      rule,
      now,
      heartbeats: [
        {
          executedAt: new Date("2026-03-15T10:00:00.000Z"),
          itemsProcessed: 999,
          status: "success",
        },
      ],
    });
    expect(outcome.result).toBe("within_band");
  });

  it("exact minimum and maximum boundaries are within band", () => {
    const rule = baseRule({
      minimumCount: 10,
      maximumCount: 10,
      evaluationGraceMinutes: 0,
    });
    const window = computeVolumeWindow(
      "daily",
      "UTC",
      new Date("2026-03-15T18:00:00.000Z"),
    );
    const now = evaluationDeadline(
      window.windowEnd,
      rule.evaluationGraceMinutes,
    );
    const outcome = evaluateVolumeBand({
      rule,
      now,
      heartbeats: [
        {
          executedAt: new Date("2026-03-15T10:00:00.000Z"),
          itemsProcessed: 10,
          status: "success",
        },
      ],
    });
    expect(outcome.result).toBe("within_band");
  });

  it("missing item counts produce inconclusive result", () => {
    const rule = baseRule({ evaluationGraceMinutes: 0 });
    const window = computeVolumeWindow(
      "daily",
      "UTC",
      new Date("2026-03-15T18:00:00.000Z"),
    );
    const now = evaluationDeadline(
      window.windowEnd,
      rule.evaluationGraceMinutes,
    );
    const outcome = evaluateVolumeBand({
      rule,
      now,
      heartbeats: [
        {
          executedAt: new Date("2026-03-15T10:00:00.000Z"),
          itemsProcessed: null,
          status: "success",
        },
      ],
    });
    expect(outcome.result).toBe("inconclusive");
    expect(outcome.unknownCountEvents).toBe(1);
  });

  it("skips first partial window after activation", () => {
    const rule = baseRule({
      activatedAt: new Date("2026-03-15T10:00:00.000Z"),
    });
    const outcome = evaluateVolumeBand({
      rule,
      now: new Date("2026-03-15T23:00:00.000Z"),
      heartbeats: [],
    });
    expect(outcome.result).toBe("collecting");
    expect(outcome.canEvaluate).toBe(false);
  });

  it("excludes heartbeats before rule activation", () => {
    const rule = baseRule({
      activatedAt: new Date("2026-03-15T10:00:00.000Z"),
      evaluationGraceMinutes: 0,
    });
    const window = computeVolumeWindow(
      "daily",
      "UTC",
      new Date("2026-03-15T18:00:00.000Z"),
    );
    const now = evaluationDeadline(
      window.windowEnd,
      rule.evaluationGraceMinutes,
    );
    const outcome = evaluateVolumeBand({
      rule,
      now,
      heartbeats: [
        {
          executedAt: new Date("2026-03-15T06:00:00.000Z"),
          itemsProcessed: 50,
          status: "success",
        },
        {
          executedAt: new Date("2026-03-15T14:00:00.000Z"),
          itemsProcessed: 5,
          status: "success",
        },
      ],
    });
    expect(outcome.totalItems).toBe(5);
    expect(outcome.result).toBe("collecting");
  });

  it("returns collecting before evaluation grace elapses", () => {
    const rule = baseRule({ evaluationGraceMinutes: 60 });
    const window = computeVolumeWindow(
      "daily",
      "UTC",
      new Date("2026-03-15T10:00:00.000Z"),
    );
    const now = new Date(window.windowEnd.getTime() + 30 * 60_000);
    const outcome = evaluateVolumeBand({ rule, now, heartbeats: [] });
    expect(outcome.result).toBe("collecting");
    expect(outcome.canEvaluate).toBe(false);
  });

  it("late heartbeat during grace can change outcome before finalize", () => {
    const rule = baseRule({ minimumCount: 10, evaluationGraceMinutes: 60 });
    const day = new Date("2026-03-16T10:00:00.000Z");
    const window = computeVolumeWindow("daily", "UTC", day);
    const duringGrace = new Date(window.windowEnd.getTime() + 30 * 60_000);
    const before = evaluateVolumeBand({
      rule,
      now: duringGrace,
      heartbeats: [],
    });
    expect(before.result).toBe("collecting");
    const after = evaluateVolumeBand({
      rule,
      now: duringGrace,
      heartbeats: [
        {
          executedAt: new Date("2026-03-16T14:00:00.000Z"),
          itemsProcessed: 12,
          status: "success",
        },
      ],
    });
    expect(after.totalItems).toBe(12);
    expect(after.result).toBe("collecting");
  });

  it("maps violation directions to distinct incident types", () => {
    expect(volumeIncidentTypeForResult("below_minimum")).toBe(
      "volume_below_minimum",
    );
    expect(volumeIncidentTypeForResult("above_maximum")).toBe(
      "volume_above_maximum",
    );
    expect(volumeIncidentTypeForResult("within_band")).toBeNull();
  });

  it("formats volume range for UI", () => {
    expect(formatVolumeRange(20, 100)).toBe("20 to 100");
    expect(formatVolumeRange(5, null)).toBe("5 or more");
  });

  it("volume rule pass does not promote evidence above basic", () => {
    const level = resolveEffectiveEvidenceLevel({
      declaredLevel: "high",
      contractKind: "heartbeat",
      destinationAggregateImplemented: false,
      destinationAggregateFresh: false,
      recordLevelReconciliationImplemented: false,
      recordLevelReconciliationFresh: false,
      connectorStaleOrUnavailable: false,
    });
    expect(level.level).toBe("basic");
  });
});

describe("Europe/Warsaw DST boundary smoke", () => {
  it("computes a window around DST spring forward", () => {
    const now = new Date("2026-03-29T12:00:00.000Z");
    const { windowStart, windowEnd } = computeVolumeWindow(
      "daily",
      "Europe/Warsaw",
      now,
    );
    expect(windowEnd.getTime()).toBeGreaterThan(windowStart.getTime());
  });
});
