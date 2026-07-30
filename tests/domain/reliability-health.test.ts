import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/clock.js";
import { evaluateContractHealth } from "../../src/domain/health/evaluate-contract-health.js";
import type { CadenceContractFields } from "../../src/domain/cadence/evaluate-deadline.js";
import { classifyHeartbeatEvidence } from "../../src/domain/evidence/empty-result.js";
import { unverifiedDimensionsForEvidenceLevel } from "../../src/domain/evidence/unverified-dimensions.js";
import { assertExplicitContractConfirmation } from "../../src/domain/contracts/explicit-activation.js";
import {
  InvalidIncidentTransitionError,
  transitionIncidentStatus,
} from "../../src/domain/incidents/lifecycle.js";
import { INCIDENT_OPENING_CONDITIONS } from "../../src/domain/reliability/incident-conditions.js";

function eventCadence(
  overrides: Partial<CadenceContractFields> = {},
): CadenceContractFields {
  return {
    cadenceType: "event_driven",
    cadenceValue: "event",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: null,
    allowedLatenessMinutes: 0,
    maxQuietWindowMinutes: 60,
    monitoringStartedAt: new Date("2026-07-10T08:00:00.000Z"),
    lastEvidenceAt: null,
    ...overrides,
  };
}

describe("empty result policy", () => {
  it("classifies allowed, warning, and failure empty results", () => {
    expect(classifyHeartbeatEvidence("empty_result", "allowed")).toBe(
      "acceptable_success",
    );
    expect(classifyHeartbeatEvidence("empty_result", "warning")).toBe(
      "warning_empty",
    );
    expect(classifyHeartbeatEvidence("empty_result", "failure")).toBe(
      "unacceptable",
    );
    expect(classifyHeartbeatEvidence("failure", "allowed")).toBe(
      "unacceptable",
    );
  });
});

describe("evaluateContractHealth", () => {
  it("keeps never-observed contracts unknown until first deadline + initial grace", () => {
    const cadence = eventCadence();
    const duringGrace = evaluateContractHealth(
      {
        isActive: true,
        evidenceLevel: "basic",
        emptyResultPolicy: "allowed",
        initialGraceMinutes: 30,
        cadence,
        latestEvidence: null,
      },
      new FixedClock(new Date("2026-07-10T09:20:00.000Z")),
    );
    // deadline 09:00, grace → 09:30
    expect(duringGrace.health).toBe("unknown");
    expect(duringGrace.reasonCode).toBe("unknown_awaiting_first_deadline");

    const afterGrace = evaluateContractHealth(
      {
        isActive: true,
        evidenceLevel: "basic",
        emptyResultPolicy: "allowed",
        initialGraceMinutes: 30,
        cadence,
        latestEvidence: null,
      },
      new FixedClock(new Date("2026-07-10T09:31:00.000Z")),
    );
    expect(afterGrace.health).toBe("overdue");
    expect(afterGrace.reasonCode).toBe("overdue_never_observed");
  });

  it("keeps empty_result cadence-healthy when policy is failure (incident is separate)", () => {
    const at = new Date("2026-07-10T08:05:00.000Z");
    const result = evaluateContractHealth(
      {
        isActive: true,
        evidenceLevel: "basic",
        emptyResultPolicy: "failure",
        initialGraceMinutes: 0,
        cadence: eventCadence({
          monitoringStartedAt: new Date("2026-07-10T08:00:00.000Z"),
          lastEvidenceAt: at,
        }),
        latestEvidence: {
          status: "empty_result",
          at,
        },
      },
      new FixedClock(new Date("2026-07-10T08:30:00.000Z")),
    );
    expect(result.health).toBe("healthy");
    expect(result.evidenceLevel).toBe("basic");
    expect(result.unverifiedDimensions).toContain(
      "destination_delivery_not_checked",
    );
  });

  it("returns healthy for empty_result when policy is warning and cadence is met", () => {
    const lastSuccess = new Date("2026-07-10T10:00:00.000Z");
    const result = evaluateContractHealth(
      {
        isActive: true,
        evidenceLevel: "basic",
        emptyResultPolicy: "warning",
        initialGraceMinutes: 0,
        cadence: eventCadence({
          lastEvidenceAt: lastSuccess,
          monitoringStartedAt: new Date("2026-07-10T08:00:00.000Z"),
        }),
        latestEvidence: { status: "empty_result", at: lastSuccess },
      },
      new FixedClock(new Date("2026-07-10T10:20:00.000Z")),
    );
    expect(result.health).toBe("healthy");
    expect(result.reasonCode).toBe("warning_empty_result");
    expect(result.evidenceLevel).toBe("basic");
  });

  it("returns healthy when an acceptable success is within the quiet window", () => {
    const lastSuccess = new Date("2026-07-10T10:00:00.000Z");
    const result = evaluateContractHealth(
      {
        isActive: true,
        evidenceLevel: "basic",
        emptyResultPolicy: "allowed",
        initialGraceMinutes: 0,
        cadence: eventCadence({ lastEvidenceAt: lastSuccess }),
        latestEvidence: { status: "success", at: lastSuccess },
      },
      new FixedClock(new Date("2026-07-10T10:30:00.000Z")),
    );
    expect(result.health).toBe("healthy");
  });

  it("returns inactive when the contract is not active", () => {
    const result = evaluateContractHealth(
      {
        isActive: false,
        evidenceLevel: "basic",
        emptyResultPolicy: "allowed",
        initialGraceMinutes: 0,
        cadence: eventCadence(),
        latestEvidence: null,
      },
      new FixedClock(new Date("2026-07-10T08:30:00.000Z")),
    );
    expect(result.health).toBe("inactive");
  });

  it("treats healthy health with basic evidence as valid (no false certainty)", () => {
    const dims = unverifiedDimensionsForEvidenceLevel("basic");
    expect(dims).toEqual(
      expect.arrayContaining([
        "destination_delivery_not_checked",
        "payload_count_supplied_by_workflow",
      ]),
    );
  });
});

describe("explicit activation and incident rules", () => {
  it("refuses silent activation without confirmation", () => {
    expect(() => assertExplicitContractConfirmation(false, "activate")).toThrow(
      /explicit user confirmation/,
    );
    expect(() =>
      assertExplicitContractConfirmation(true, "activate"),
    ).not.toThrow();
  });

  it("enforces open → acknowledged → resolved", () => {
    expect(transitionIncidentStatus("open", "acknowledged")).toBe(
      "acknowledged",
    );
    expect(transitionIncidentStatus("acknowledged", "resolved")).toBe(
      "resolved",
    );
    expect(() => transitionIncidentStatus("resolved", "open")).toThrow(
      InvalidIncidentTransitionError,
    );
  });

  it("lists first-class incident opening conditions including absence", () => {
    expect(INCIDENT_OPENING_CONDITIONS).toContain("silent_absence");
    expect(INCIDENT_OPENING_CONDITIONS).toContain("hard_failure");
    expect(INCIDENT_OPENING_CONDITIONS).toContain("unacceptable_empty_result");
    expect(INCIDENT_OPENING_CONDITIONS).toContain("alert_delivery_failure");
  });
});
