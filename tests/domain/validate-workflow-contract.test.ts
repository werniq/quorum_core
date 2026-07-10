import { describe, expect, it } from "vitest";
import { validateWorkflowContract } from "../../src/domain/contracts/validate-workflow-contract.js";
import type { WorkflowContractInput } from "../../src/domain/contracts/types.js";

function baseContract(
  overrides: Partial<WorkflowContractInput> = {},
): WorkflowContractInput {
  return {
    workflowId: "wf_1",
    name: "Daily sync",
    businessPurpose: "Sync client invoices",
    contractType: "heartbeat",
    cadenceType: "cron",
    cadenceValue: "0 9 * * 1-5",
    intervalMode: null,
    scheduleAnchorAt: null,
    timezone: "Europe/Berlin",
    allowedLatenessMinutes: 15,
    maxQuietWindowMinutes: null,
    initialGraceMinutes: 30,
    emptyResultPolicy: "allowed",
    countLessSuccessAllowed: false,
    notificationBackoffMinutes: 240,
    evidenceLevel: "basic",
    schemaVersion: 1,
    isActive: true,
    ...overrides,
  };
}

describe("validateWorkflowContract", () => {
  it("accepts a valid cron heartbeat contract with alert route", () => {
    const result = validateWorkflowContract(baseContract(), {
      activation: {
        hasActiveAlertRoute: true,
        acknowledgedNoAlertMode: false,
        edition: "saas",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects a second active heartbeat on the same workflow", () => {
    const result = validateWorkflowContract(baseContract(), {
      existingActiveHeartbeats: [{ contractId: "c1", workflowId: "wf_1" }],
      activation: {
        hasActiveAlertRoute: true,
        acknowledgedNoAlertMode: false,
        edition: "self_hosted",
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((i) => i.code === "ACTIVE_HEARTBEAT_EXISTS"),
    ).toBe(true);
  });

  it("requires timezone and valid expression for cron", () => {
    const missingTz = validateWorkflowContract(
      baseContract({ timezone: null }),
    );
    expect(
      missingTz.issues.some((i) => i.code === "CRON_TIMEZONE_REQUIRED"),
    ).toBe(true);

    const badCron = validateWorkflowContract(
      baseContract({ cadenceValue: "not a cron" }),
    );
    expect(badCron.issues.some((i) => i.code === "INVALID_CRON")).toBe(true);
  });

  it("requires positive duration and anchor for fixed-rate interval", () => {
    const result = validateWorkflowContract(
      baseContract({
        cadenceType: "interval",
        cadenceValue: "0",
        intervalMode: "fixed_rate",
        scheduleAnchorAt: null,
        timezone: null,
      }),
    );
    expect(
      result.issues.some((i) => i.code === "INTERVAL_DURATION_INVALID"),
    ).toBe(true);
    expect(
      result.issues.some((i) => i.code === "FIXED_RATE_ANCHOR_REQUIRED"),
    ).toBe(true);
  });

  it("requires positive quiet window for event-driven cadence", () => {
    const result = validateWorkflowContract(
      baseContract({
        cadenceType: "event_driven",
        cadenceValue: "event",
        timezone: null,
        maxQuietWindowMinutes: 0,
      }),
    );
    expect(result.issues.some((i) => i.code === "QUIET_WINDOW_REQUIRED")).toBe(
      true,
    );
  });

  it("rejects heartbeat evidence level above basic", () => {
    const result = validateWorkflowContract(
      baseContract({ evidenceLevel: "medium" }),
    );
    expect(
      result.issues.some((i) => i.code === "EVIDENCE_LEVEL_TOO_HIGH"),
    ).toBe(true);
  });

  it("requires alert route or acknowledged no-alert mode to activate", () => {
    const blocked = validateWorkflowContract(baseContract(), {
      activation: {
        hasActiveAlertRoute: false,
        acknowledgedNoAlertMode: false,
        edition: "self_hosted",
      },
    });
    expect(
      blocked.issues.some((i) => i.code === "ACTIVATION_ALERT_ROUTE_REQUIRED"),
    ).toBe(true);

    const allowed = validateWorkflowContract(baseContract(), {
      activation: {
        hasActiveAlertRoute: false,
        acknowledgedNoAlertMode: true,
        edition: "self_hosted",
      },
    });
    expect(allowed.ok).toBe(true);
  });
});
