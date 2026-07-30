import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import {
  addMinutes,
  parsePositiveDurationMinutes,
} from "../../src/domain/cadence/duration.js";
import {
  CadenceEvaluationError,
  evaluateCadenceDeadline,
  successCoversOccurrence,
} from "../../src/domain/cadence/evaluate-deadline.js";
import type { CadenceContractFields } from "../../src/domain/cadence/evaluate-deadline.js";

function base(
  overrides: Partial<CadenceContractFields> = {},
): CadenceContractFields {
  return {
    cadenceType: "cron",
    cadenceValue: "0 9 * * *",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: "UTC",
    allowedLatenessMinutes: 15,
    maxQuietWindowMinutes: null,
    monitoringStartedAt: new Date("2026-07-01T00:00:00.000Z"),
    lastEvidenceAt: null,
    ...overrides,
  };
}

describe("duration helpers", () => {
  it("parses minute, hour, and day suffixes and rejects invalid values", () => {
    expect(parsePositiveDurationMinutes("15")).toBe(15);
    expect(parsePositiveDurationMinutes("0")).toBeNull();
    expect(parsePositiveDurationMinutes("30m")).toBe(30);
    expect(parsePositiveDurationMinutes("2 hours")).toBe(120);
    expect(parsePositiveDurationMinutes("1d")).toBe(1440);
    expect(parsePositiveDurationMinutes("nope")).toBeNull();
    expect(
      addMinutes(new Date("2026-07-10T00:00:00.000Z"), 5).toISOString(),
    ).toBe("2026-07-10T00:05:00.000Z");
  });
});

describe("evaluateCadenceDeadline", () => {
  it("computes cron deadline as most recent occurrence + allowed lateness", () => {
    const clock = new FixedClock(new Date("2026-07-10T10:00:00.000Z"));
    const result = evaluateCadenceDeadline(base(), clock);

    expect(result.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-10T09:00:00.000Z",
    );
    expect(result.deadlineAt.toISOString()).toBe("2026-07-10T09:15:00.000Z");
  });

  it("does not let a previous success cover a later cron occurrence", () => {
    const expected = new Date("2026-07-10T09:00:00.000Z");
    const next = new Date("2026-07-11T09:00:00.000Z");
    const priorSuccess = new Date("2026-07-09T09:05:00.000Z");
    expect(successCoversOccurrence(priorSuccess, expected, next)).toBe(false);
    expect(
      successCoversOccurrence(
        new Date("2026-07-10T09:05:00.000Z"),
        expected,
        next,
      ),
    ).toBe(true);
    expect(
      successCoversOccurrence(
        new Date("2026-07-11T09:05:00.000Z"),
        expected,
        next,
      ),
    ).toBe(false);
    expect(
      successCoversOccurrence(
        new Date("2026-07-10T09:05:00.000Z"),
        expected,
        null,
      ),
    ).toBe(true);
  });

  it("computes fixed-rate slots from anchor without shifting for lateness", () => {
    const anchor = new Date("2026-07-10T00:00:00.000Z");
    const clock = new FixedClock(new Date("2026-07-10T02:10:00.000Z"));
    const result = evaluateCadenceDeadline(
      base({
        cadenceType: "interval",
        cadenceValue: "60",
        intervalMode: "fixed_rate",
        scheduleAnchorAt: anchor,
        timezone: null,
      }),
      clock,
    );

    // N=2 → expected 02:00, deadline 02:15
    expect(result.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-10T02:00:00.000Z",
    );
    expect(result.deadlineAt.toISOString()).toBe("2026-07-10T02:15:00.000Z");

    const later = evaluateCadenceDeadline(
      base({
        cadenceType: "interval",
        cadenceValue: "60",
        intervalMode: "fixed_rate",
        scheduleAnchorAt: anchor,
        timezone: null,
        lastEvidenceAt: new Date("2026-07-10T02:20:00.000Z"),
      }),
      new FixedClock(new Date("2026-07-10T03:10:00.000Z")),
    );
    // Late success does not shift the 03:00 slot.
    expect(later.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-10T03:00:00.000Z",
    );
  });

  it("requires explicit since_last_success and measures from last success", () => {
    const clock = new FixedClock(new Date("2026-07-10T12:00:00.000Z"));
    const result = evaluateCadenceDeadline(
      base({
        cadenceType: "interval",
        cadenceValue: "30",
        intervalMode: "since_last_success",
        timezone: null,
        lastEvidenceAt: new Date("2026-07-10T11:00:00.000Z"),
      }),
      clock,
    );
    expect(result.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-10T11:30:00.000Z",
    );
    expect(result.deadlineAt.toISOString()).toBe("2026-07-10T11:45:00.000Z");
  });

  it("uses monitoring_started_at + quiet window before any event-driven heartbeat", () => {
    const started = new Date("2026-07-10T08:00:00.000Z");
    const clock = new FixedClock(new Date("2026-07-10T08:30:00.000Z"));
    const result = evaluateCadenceDeadline(
      base({
        cadenceType: "event_driven",
        cadenceValue: "event",
        timezone: null,
        maxQuietWindowMinutes: 60,
        monitoringStartedAt: started,
      }),
      clock,
    );
    expect(result.expectedOccurrenceAt.toISOString()).toBe(
      started.toISOString(),
    );
    expect(result.deadlineAt.toISOString()).toBe("2026-07-10T09:00:00.000Z");
  });

  it("uses last acceptable success + quiet window for event-driven cadence", () => {
    const lastSuccess = new Date("2026-07-10T10:00:00.000Z");
    const result = evaluateCadenceDeadline(
      base({
        cadenceType: "event_driven",
        cadenceValue: "event",
        timezone: null,
        maxQuietWindowMinutes: 45,
        lastEvidenceAt: lastSuccess,
      }),
      new FixedClock(new Date("2026-07-10T10:20:00.000Z")),
    );
    expect(result.deadlineAt.toISOString()).toBe("2026-07-10T10:45:00.000Z");
  });

  it("rejects invalid cadence configurations", () => {
    const clock = new FixedClock(new Date("2026-07-10T10:00:00.000Z"));
    expect(() =>
      evaluateCadenceDeadline(base({ timezone: null }), clock),
    ).toThrow(CadenceEvaluationError);
    expect(() =>
      evaluateCadenceDeadline(
        base({
          cadenceType: "interval",
          cadenceValue: "30",
          intervalMode: null,
          timezone: null,
        }),
        clock,
      ),
    ).toThrow(/interval_mode/);
    expect(() =>
      evaluateCadenceDeadline(
        base({
          cadenceType: "interval",
          cadenceValue: "nope",
          intervalMode: "fixed_rate",
          scheduleAnchorAt: new Date("2026-07-10T00:00:00.000Z"),
          timezone: null,
        }),
        clock,
      ),
    ).toThrow(/positive duration/);
    expect(() =>
      evaluateCadenceDeadline(
        base({
          cadenceType: "interval",
          cadenceValue: "30",
          intervalMode: "fixed_rate",
          scheduleAnchorAt: null,
          timezone: null,
        }),
        clock,
      ),
    ).toThrow(/schedule_anchor_at/);
    expect(() =>
      evaluateCadenceDeadline(
        base({
          cadenceType: "event_driven",
          cadenceValue: "event",
          timezone: null,
          maxQuietWindowMinutes: 0,
        }),
        clock,
      ),
    ).toThrow(/quiet window/);
  });

  it("keeps fixed-rate slot N=0 before the anchor time", () => {
    const anchor = new Date("2026-07-10T12:00:00.000Z");
    const result = evaluateCadenceDeadline(
      base({
        cadenceType: "interval",
        cadenceValue: "60m",
        intervalMode: "fixed_rate",
        scheduleAnchorAt: anchor,
        timezone: null,
      }),
      new FixedClock(new Date("2026-07-10T11:00:00.000Z")),
    );
    expect(result.expectedOccurrenceAt.toISOString()).toBe(
      anchor.toISOString(),
    );
    expect(result.isFirstEvidenceWindow).toBe(true);
  });
});
