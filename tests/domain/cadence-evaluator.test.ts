import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import { evaluateCadence } from "../../src/domain/cadence/evaluate-cadence.js";
import {
  evaluateCadenceDeadline,
  successCoversOccurrence,
  type CadenceContractFields,
} from "../../src/domain/cadence/evaluate-deadline.js";
import { validateWorkflowContract } from "../../src/domain/contracts/validate-workflow-contract.js";

function cronContract(
  overrides: Partial<CadenceContractFields> = {},
): CadenceContractFields {
  return {
    cadenceType: "cron",
    cadenceValue: "0 * * * *",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: "UTC",
    allowedLatenessMinutes: 15,
    maxQuietWindowMinutes: null,
    monitoringStartedAt: new Date("2026-07-01T00:00:00.000Z"),
    lastAcceptableSuccessAt: null,
    ...overrides,
  };
}

describe("cadence evaluator — cron", () => {
  it("does not let 13:00 success satisfy the 14:00 occurrence", () => {
    const expected = new Date("2026-07-18T14:00:00.000Z");
    const next = new Date("2026-07-18T15:00:00.000Z");
    expect(
      successCoversOccurrence(
        new Date("2026-07-18T13:00:00.000Z"),
        expected,
        next,
      ),
    ).toBe(false);

    const result = evaluateCadence(
      {
        isActive: true,
        initialGraceMinutes: 0,
        contract: cronContract({
          lastAcceptableSuccessAt: new Date("2026-07-18T13:05:00.000Z"),
        }),
      },
      new FixedClock(new Date("2026-07-18T14:10:00.000Z")),
    );
    expect(result.expectedAt?.toISOString()).toBe("2026-07-18T14:00:00.000Z");
    expect(result.health).toBe("warning");
    expect(result.reasonCode).toBe("warning_no_recent_execution");
  });

  it("becomes overdue after allowed lateness on a missed cron occurrence", () => {
    const withEvidence = evaluateCadence(
      {
        isActive: true,
        initialGraceMinutes: 0,
        contract: cronContract({
          lastAcceptableSuccessAt: new Date("2026-07-18T14:05:00.000Z"),
        }),
      },
      new FixedClock(new Date("2026-07-18T14:14:59.000Z")),
    );
    expect(withEvidence.health).toBe("healthy");

    const overdue = evaluateCadence(
      {
        isActive: true,
        initialGraceMinutes: 0,
        contract: cronContract({
          lastAcceptableSuccessAt: new Date("2026-07-18T13:05:00.000Z"),
        }),
      },
      new FixedClock(new Date("2026-07-18T14:15:01.000Z")),
    );
    expect(overdue.health).toBe("overdue");
    expect(overdue.deadlineAt?.toISOString()).toBe("2026-07-18T14:15:00.000Z");
  });

  it("does not shift the next cron occurrence after late evidence", () => {
    const atFifteen = evaluateCadenceDeadline(
      cronContract({
        lastAcceptableSuccessAt: new Date("2026-07-18T14:20:00.000Z"),
      }),
      new FixedClock(new Date("2026-07-18T15:10:00.000Z")),
    );
    expect(atFifteen.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-18T15:00:00.000Z",
    );
  });

  it("handles daily, weekday, month-end, and leap-day expressions", () => {
    const daily = evaluateCadenceDeadline(
      cronContract({ cadenceValue: "0 9 * * *" }),
      new FixedClock(new Date("2026-07-18T10:00:00.000Z")),
    );
    expect(daily.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-18T09:00:00.000Z",
    );

    const weekday = evaluateCadenceDeadline(
      cronContract({ cadenceValue: "0 9 * * 1-5" }),
      new FixedClock(new Date("2026-07-18T10:00:00.000Z")), // Saturday
    );
    expect(weekday.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-17T09:00:00.000Z",
    );

    const monthEnd = evaluateCadenceDeadline(
      cronContract({ cadenceValue: "0 0 1 * *" }),
      new FixedClock(new Date("2026-03-15T12:00:00.000Z")),
    );
    expect(monthEnd.expectedOccurrenceAt.toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );

    const leapDay = evaluateCadenceDeadline(
      cronContract({ cadenceValue: "0 12 29 2 *" }),
      new FixedClock(new Date("2024-03-01T00:00:00.000Z")),
    );
    expect(leapDay.expectedOccurrenceAt.toISOString()).toBe(
      "2024-02-29T12:00:00.000Z",
    );
  });

  it("handles Europe/Warsaw DST spring-forward and fall-back", () => {
    // 2026-03-29 spring forward in Poland (01:59 → 03:00)
    const spring = evaluateCadenceDeadline(
      cronContract({
        cadenceValue: "0 2 * * *",
        timezone: "Europe/Warsaw",
      }),
      new FixedClock(new Date("2026-03-29T12:00:00.000Z")),
    );
    expect(spring.expectedOccurrenceAt.toISOString()).not.toBe(
      "2026-03-29T01:00:00.000Z",
    );

    // 2026-10-25 fall back
    const fall = evaluateCadenceDeadline(
      cronContract({
        cadenceValue: "30 2 * * *",
        timezone: "Europe/Warsaw",
      }),
      new FixedClock(new Date("2026-10-25T12:00:00.000Z")),
    );
    expect(fall.expectedOccurrenceAt.getUTCFullYear()).toBe(2026);
    expect(fall.expectedOccurrenceAt.getUTCMonth()).toBe(9);
  });

  it("produces distinct UTC slots for the same cron in two timezones", () => {
    const clock = new FixedClock(new Date("2026-07-18T12:00:00.000Z"));
    const berlin = evaluateCadenceDeadline(
      cronContract({ cadenceValue: "0 9 * * *", timezone: "Europe/Berlin" }),
      clock,
    );
    const tokyo = evaluateCadenceDeadline(
      cronContract({ cadenceValue: "0 9 * * *", timezone: "Asia/Tokyo" }),
      clock,
    );
    expect(berlin.expectedOccurrenceAt.toISOString()).not.toBe(
      tokyo.expectedOccurrenceAt.toISOString(),
    );
  });

  it("is independent of the process timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const a = evaluateCadenceDeadline(
        cronContract({ timezone: "UTC" }),
        new FixedClock(new Date("2026-07-18T14:30:00.000Z")),
      );
      process.env.TZ = "Asia/Tokyo";
      const b = evaluateCadenceDeadline(
        cronContract({ timezone: "UTC" }),
        new FixedClock(new Date("2026-07-18T14:30:00.000Z")),
      );
      expect(a.expectedOccurrenceAt.toISOString()).toBe(
        b.expectedOccurrenceAt.toISOString(),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
    }
  });
});

describe("cadence evaluator — fixed-rate interval", () => {
  const anchor = new Date("2026-07-18T14:00:00.000Z");

  function fixed(overrides: Partial<CadenceContractFields> = {}) {
    return cronContract({
      cadenceType: "interval",
      cadenceValue: "10",
      intervalMode: "fixed_rate",
      scheduleAnchorAt: anchor,
      timezone: null,
      allowedLatenessMinutes: 5,
      ...overrides,
    });
  }

  it("produces anchor + N × interval slots and ignores late heartbeats for future slots", () => {
    const slot = evaluateCadenceDeadline(
      fixed(),
      new FixedClock(new Date("2026-07-18T14:09:00.000Z")),
    );
    expect(slot.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-18T14:00:00.000Z",
    );

    const next = evaluateCadenceDeadline(
      fixed({
        lastAcceptableSuccessAt: new Date("2026-07-18T14:09:00.000Z"),
      }),
      new FixedClock(new Date("2026-07-18T14:12:00.000Z")),
    );
    expect(next.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-18T14:10:00.000Z",
    );
  });

  it("treats exactly on deadline as healthy and one second after as overdue", () => {
    const onDeadline = evaluateCadence(
      {
        isActive: true,
        initialGraceMinutes: 0,
        contract: fixed({
          lastAcceptableSuccessAt: new Date("2026-07-18T14:00:00.000Z"),
        }),
      },
      new FixedClock(new Date("2026-07-18T14:05:00.000Z")),
    );
    expect(onDeadline.health).toBe("healthy");

    const after = evaluateCadence(
      {
        isActive: true,
        initialGraceMinutes: 0,
        contract: fixed({
          lastAcceptableSuccessAt: new Date("2026-07-18T13:50:00.000Z"),
        }),
      },
      new FixedClock(new Date("2026-07-18T14:05:01.000Z")),
    );
    expect(after.health).toBe("overdue");
  });

  it("keeps anchor semantics after restart and requires explicit contract changes", () => {
    const beforeRestart = evaluateCadenceDeadline(
      fixed(),
      new FixedClock(new Date("2026-07-18T14:22:00.000Z")),
    );
    const afterRestart = evaluateCadenceDeadline(
      fixed(),
      new FixedClock(new Date("2026-07-18T14:22:00.000Z")),
    );
    expect(beforeRestart.expectedOccurrenceAt.toISOString()).toBe(
      afterRestart.expectedOccurrenceAt.toISOString(),
    );

    const changed = evaluateCadenceDeadline(
      fixed({
        cadenceValue: "15",
        scheduleAnchorAt: new Date("2026-07-18T14:00:00.000Z"),
      }),
      new FixedClock(new Date("2026-07-18T14:22:00.000Z")),
    );
    expect(changed.expectedOccurrenceAt.toISOString()).toBe(
      "2026-07-18T14:15:00.000Z",
    );
  });

  it("warns then overdues a 1-minute interval even when lateness is longer than the interval", () => {
    const oneMinute = fixed({
      cadenceValue: "1",
      allowedLatenessMinutes: 5,
      lastAcceptableSuccessAt: new Date("2026-07-18T14:00:00.000Z"),
    });

    const stillHealthy = evaluateCadence(
      { isActive: true, initialGraceMinutes: 0, contract: oneMinute },
      new FixedClock(new Date("2026-07-18T14:00:45.000Z")),
    );
    expect(stillHealthy.health).toBe("healthy");

    const warning = evaluateCadence(
      { isActive: true, initialGraceMinutes: 0, contract: oneMinute },
      new FixedClock(new Date("2026-07-18T14:03:00.000Z")),
    );
    expect(warning.health).toBe("warning");
    expect(warning.reasonCode).toBe("warning_no_recent_execution");
    expect(warning.expectedAt?.toISOString()).toBe("2026-07-18T14:01:00.000Z");
    expect(warning.deadlineAt?.toISOString()).toBe("2026-07-18T14:06:00.000Z");

    const overdue = evaluateCadence(
      { isActive: true, initialGraceMinutes: 0, contract: oneMinute },
      new FixedClock(new Date("2026-07-18T14:06:01.000Z")),
    );
    expect(overdue.health).toBe("overdue");
    expect(overdue.reasonCode).toBe("overdue_missed_deadline");
    expect(overdue.expectedAt?.toISOString()).toBe("2026-07-18T14:01:00.000Z");
  });
});

describe("cadence evaluator — since-last-success", () => {
  it("uses last acceptable success only when explicitly selected", () => {
    const result = evaluateCadenceDeadline(
      cronContract({
        cadenceType: "interval",
        cadenceValue: "30",
        intervalMode: "since_last_success",
        timezone: null,
        allowedLatenessMinutes: 5,
        lastAcceptableSuccessAt: new Date("2026-07-18T10:00:00.000Z"),
      }),
      new FixedClock(new Date("2026-07-18T10:20:00.000Z")),
    );
    expect(result.deadlineAt.toISOString()).toBe("2026-07-18T10:35:00.000Z");

    const validation = validateWorkflowContract({
      workflowId: "wf",
      name: "n",
      businessPurpose: "p",
      contractType: "heartbeat",
      cadenceType: "interval",
      cadenceValue: "30",
      intervalMode: null,
      scheduleAnchorAt: null,
      timezone: null,
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: null,
      initialGraceMinutes: 0,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 240,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: false,
    });
    expect(
      validation.issues.some(
        (issue) => issue.code === "INTERVAL_MODE_REQUIRED",
      ),
    ).toBe(true);
  });
});

describe("cadence evaluator — event-driven", () => {
  function event(overrides: Partial<CadenceContractFields> = {}) {
    return cronContract({
      cadenceType: "event_driven",
      cadenceValue: "event",
      timezone: null,
      allowedLatenessMinutes: 0,
      maxQuietWindowMinutes: 60,
      monitoringStartedAt: new Date("2026-07-18T08:00:00.000Z"),
      ...overrides,
    });
  }

  it("is unknown before the first quiet deadline and overdue after", () => {
    const before = evaluateCadence(
      { isActive: true, initialGraceMinutes: 10, contract: event() },
      new FixedClock(new Date("2026-07-18T08:30:00.000Z")),
    );
    expect(before.health).toBe("unknown");

    const after = evaluateCadence(
      { isActive: true, initialGraceMinutes: 10, contract: event() },
      new FixedClock(new Date("2026-07-18T09:11:00.000Z")),
    );
    expect(after.health).toBe("overdue");
  });

  it("resets the quiet deadline on acceptable success but not on unacceptable empty", () => {
    const reset = evaluateCadence(
      {
        isActive: true,
        initialGraceMinutes: 0,
        contract: event({
          lastAcceptableSuccessAt: new Date("2026-07-18T10:00:00.000Z"),
        }),
      },
      new FixedClock(new Date("2026-07-18T10:30:00.000Z")),
    );
    expect(reset.health).toBe("healthy");
    expect(reset.deadlineAt?.toISOString()).toBe("2026-07-18T11:00:00.000Z");

    const emptyDoesNotReset = evaluateCadence(
      {
        isActive: true,
        initialGraceMinutes: 0,
        contract: event({
          lastAcceptableSuccessAt: new Date("2026-07-18T09:00:00.000Z"),
        }),
      },
      new FixedClock(new Date("2026-07-18T10:30:00.000Z")),
    );
    expect(emptyDoesNotReset.health).toBe("overdue");
  });
});

describe("cadence evaluator — inactive and never observed", () => {
  it("marks inactive contracts and never-observed overdue after grace", () => {
    const inactive = evaluateCadence(
      {
        isActive: false,
        initialGraceMinutes: 0,
        contract: cronContract(),
      },
      new FixedClock(new Date("2026-07-18T14:30:00.000Z")),
    );
    expect(inactive.health).toBe("inactive");

    const overdue = evaluateCadence(
      {
        isActive: true,
        initialGraceMinutes: 5,
        contract: cronContract({
          cadenceType: "event_driven",
          cadenceValue: "event",
          timezone: null,
          maxQuietWindowMinutes: 30,
          monitoringStartedAt: new Date("2026-07-18T08:00:00.000Z"),
        }),
      },
      new FixedClock(new Date("2026-07-18T08:36:00.000Z")),
    );
    expect(overdue.health).toBe("overdue");
    expect(overdue.reasonCode).toBe("overdue_never_observed");
  });
});
