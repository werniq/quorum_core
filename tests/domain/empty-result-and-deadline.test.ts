import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import { nextExpectedAfterReport } from "../../src/domain/cadence/next-expected-after-report.js";
import type { CadenceContractFields } from "../../src/domain/cadence/evaluate-deadline.js";
import {
  buildEmptyResultDetails,
  emptyResultPrimaryLabel,
  formatEmptyResultRecoverySummary,
  formatEmptyResultSummary,
  parseEmptyResultDetails,
  withEmptyResultRecovery,
} from "../../src/domain/incidents/empty-result.js";
import {
  buildHardFailureDetails,
  formatDurationSeconds,
  formatHardFailureRecoverySummary,
  formatHardFailureSummary,
  formatHeartbeatHistoryRow,
  parseHardFailureDetails,
  withHardFailureRecovery,
} from "../../src/domain/incidents/hard-failure.js";
import {
  isAcceptableSuccess,
  isOutcomeSuccess,
  classifyHeartbeatEvidence,
} from "../../src/domain/evidence/empty-result.js";

describe("nextExpectedAfterReport", () => {
  it("advances the expected occurrence from the latest report", () => {
    const contract: CadenceContractFields = {
      cadenceType: "event_driven",
      cadenceValue: "event",
      intervalMode: null,
      scheduleAnchorAt: null,
      timezone: null,
      allowedLatenessMinutes: 0,
      maxQuietWindowMinutes: 60,
      monitoringStartedAt: new Date("2026-07-18T08:00:00.000Z"),
      lastEvidenceAt: new Date("2026-07-18T08:15:00.000Z"),
    };
    const next = nextExpectedAfterReport({
      contract,
      initialGraceMinutes: 0,
      isActive: true,
      clock: new FixedClock(new Date("2026-07-18T08:20:00.000Z")),
    });
    expect(next?.toISOString()).toBe("2026-07-18T08:15:00.000Z");
  });

  it("returns null when the contract is inactive", () => {
    const next = nextExpectedAfterReport({
      contract: {
        cadenceType: "event_driven",
        cadenceValue: "event",
        intervalMode: null,
        scheduleAnchorAt: null,
        timezone: null,
        allowedLatenessMinutes: 0,
        maxQuietWindowMinutes: 60,
        monitoringStartedAt: new Date("2026-07-18T08:00:00.000Z"),
        lastEvidenceAt: null,
      },
      initialGraceMinutes: 0,
      isActive: false,
      clock: new FixedClock(new Date("2026-07-18T08:20:00.000Z")),
    });
    expect(next).toBeNull();
  });
});

describe("empty-result incident helpers", () => {
  it("accumulates consecutive empties and formats summaries", () => {
    const first = buildEmptyResultDetails({
      existing: null,
      workflowName: "Invoice sync",
      monitoringMethod: "push",
      policy: "failure",
      observedAt: "2026-07-18T08:00:00.000Z",
      itemsProcessed: 0,
      externalExecutionRef: "e1",
      lastNonEmptySuccessAt: "2026-07-18T07:00:00.000Z",
    });
    expect(first.consecutiveEmpties).toBe(1);
    expect(formatEmptyResultSummary(first)).toContain("contract violation");
    expect(emptyResultPrimaryLabel("failure")).toBe("Contract violation");
    expect(emptyResultPrimaryLabel("warning")).toBe("Empty result");
    expect(emptyResultPrimaryLabel(null)).toBe("Empty result");

    const warning = buildEmptyResultDetails({
      existing: null,
      workflowName: "Invoice sync",
      monitoringMethod: "poll",
      policy: "warning",
      observedAt: "2026-07-18T08:00:00.000Z",
      itemsProcessed: 0,
      externalExecutionRef: null,
      lastNonEmptySuccessAt: null,
    });
    expect(formatEmptyResultSummary(warning)).toContain("empty result");

    const second = buildEmptyResultDetails({
      existing: first,
      workflowName: "Invoice sync",
      monitoringMethod: "push",
      policy: "failure",
      observedAt: "2026-07-18T08:05:00.000Z",
      itemsProcessed: 0,
      externalExecutionRef: "e2",
      lastNonEmptySuccessAt: "2026-07-18T07:00:00.000Z",
    });
    expect(second.consecutiveEmpties).toBe(2);
    expect(
      parseEmptyResultDetails(JSON.stringify(second))?.externalExecutionRef,
    ).toBe("e2");

    const recovered = withEmptyResultRecovery(
      second,
      "2026-07-18T08:10:00.000Z",
    );
    expect(recovered.durationSeconds).toBe(600);
    expect(formatEmptyResultRecoverySummary(recovered)).toContain("recovered");
    expect(
      formatEmptyResultRecoverySummary({ ...recovered, recoveredAt: null }),
    ).toContain("unknown");
  });

  it("rejects malformed details json", () => {
    expect(parseEmptyResultDetails("{")).toBeNull();
    expect(parseEmptyResultDetails("{}")).toBeNull();
    expect(parseEmptyResultDetails(null)).toBeNull();
    expect(
      parseEmptyResultDetails(
        JSON.stringify({
          workflowName: "x",
          firstEmptyAt: "a",
          latestEmptyAt: "b",
          consecutiveEmpties: 1,
          policy: "allowed",
        }),
      ),
    ).toBeNull();
    expect(
      parseEmptyResultDetails(
        JSON.stringify({
          workflowName: "x",
          firstEmptyAt: "a",
          latestEmptyAt: "b",
          consecutiveEmpties: 1,
          policy: "warning",
          monitoringMethod: "other",
          itemsProcessed: "x",
          externalExecutionRef: 1,
          lastNonEmptySuccessAt: 2,
          recoveredAt: 3,
          durationSeconds: "no",
        }),
      ),
    ).toMatchObject({
      monitoringMethod: null,
      itemsProcessed: 0,
      externalExecutionRef: null,
      lastNonEmptySuccessAt: null,
      recoveredAt: null,
      durationSeconds: null,
    });
    expect(
      withEmptyResultRecovery(
        buildEmptyResultDetails({
          existing: null,
          workflowName: "x",
          monitoringMethod: null,
          policy: "warning",
          observedAt: "bad",
          itemsProcessed: 0,
          externalExecutionRef: null,
          lastNonEmptySuccessAt: null,
        }),
        "also-bad",
      ).durationSeconds,
    ).toBeNull();
  });
});

describe("hard-failure incident helpers", () => {
  it("formats history rows and accumulates recovery metadata", () => {
    expect(
      formatHeartbeatHistoryRow({
        at: "2026-07-18T17:59:00.000Z",
        status: "failure",
        itemsProcessed: 0,
      }),
    ).toBe("17:59 · Failure · 0 items");
    expect(
      formatHeartbeatHistoryRow({
        at: "not-a-date",
        status: "empty_result",
        itemsProcessed: 1,
      }),
    ).toContain("Empty result");
    expect(formatDurationSeconds(null)).toBe("—");
    expect(formatDurationSeconds(30)).toBe("30s");
    expect(formatDurationSeconds(120)).toBe("2m");
    expect(formatDurationSeconds(3600)).toBe("1h");
    expect(formatDurationSeconds(3660)).toBe("1h 1m");

    const first = buildHardFailureDetails({
      existing: null,
      workflowName: "Invoice sync",
      monitoringMethod: "push",
      observedAt: "2026-07-18T08:00:00.000Z",
      latestStatus: "failure",
      itemsProcessed: 0,
      externalExecutionRef: "f1",
    });
    const second = buildHardFailureDetails({
      existing: first,
      workflowName: "Invoice sync",
      monitoringMethod: "poll",
      observedAt: "2026-07-18T08:05:00.000Z",
      latestStatus: "failure",
      itemsProcessed: null,
      externalExecutionRef: null,
    });
    expect(second.consecutiveFailures).toBe(2);
    expect(formatHardFailureSummary(second)).toContain("2 consecutive");
    expect(formatHardFailureSummary(first)).toContain("ref f1");
    expect(
      parseHardFailureDetails(JSON.stringify(second))?.monitoringMethod,
    ).toBe("poll");
    expect(parseHardFailureDetails("{}")).toBeNull();
    expect(parseHardFailureDetails("{")).toBeNull();

    const recovered = withHardFailureRecovery(
      second,
      "2026-07-18T08:15:00.000Z",
    );
    expect(recovered.durationSeconds).toBe(900);
    expect(formatHardFailureRecoverySummary(recovered)).toContain("recovered");
    expect(
      formatHardFailureRecoverySummary({ ...recovered, recoveredAt: null }),
    ).toContain("unknown");
    expect(
      withHardFailureRecovery({ ...first, firstFailureAt: "bad" }, "also-bad")
        .durationSeconds,
    ).toBeNull();
    expect(
      formatHardFailureSummary({
        ...first,
        monitoringMethod: null,
        itemsProcessed: null,
        externalExecutionRef: null,
        latestStatus: "weird",
      }),
    ).toContain("unknown method");
    expect(
      formatHeartbeatHistoryRow({
        at: "2026-07-18T10:00:00.000Z",
        status: "success",
        itemsProcessed: null,
      }),
    ).toContain("unknown items");
    expect(formatDurationSeconds(Number.NaN)).toBe("—");
    expect(
      parseHardFailureDetails(
        JSON.stringify({
          ...first,
          monitoringMethod: "other",
          itemsProcessed: "x",
          externalExecutionRef: 1,
          recoveredAt: 2,
          durationSeconds: "nope",
          latestStatus: 3,
        }),
      ),
    ).toMatchObject({
      monitoringMethod: null,
      itemsProcessed: null,
      externalExecutionRef: null,
      recoveredAt: null,
      durationSeconds: null,
      latestStatus: "failure",
    });
  });
});

describe("evidence empty-result classification helpers", () => {
  it("classifies outcome success separately from acceptable empty", () => {
    expect(isOutcomeSuccess("success")).toBe(true);
    expect(isOutcomeSuccess("empty_result")).toBe(false);
    expect(isOutcomeSuccess("failure")).toBe(false);
    expect(
      isAcceptableSuccess(classifyHeartbeatEvidence("success", "failure")),
    ).toBe(true);
    expect(
      isAcceptableSuccess(classifyHeartbeatEvidence("empty_result", "warning")),
    ).toBe(true);
    expect(
      isAcceptableSuccess(classifyHeartbeatEvidence("empty_result", "failure")),
    ).toBe(false);
    expect(
      isAcceptableSuccess(classifyHeartbeatEvidence("failure", "allowed")),
    ).toBe(false);
  });
});
