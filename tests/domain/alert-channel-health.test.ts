import { describe, expect, it } from "vitest";
import {
  isUnresolvedIncidentStatus,
  nextAlertChannelHealth,
} from "../../src/domain/alerting/alert-channel-health.js";

describe("nextAlertChannelHealth", () => {
  it("sets degraded when a failure still has retries remaining", () => {
    expect(
      nextAlertChannelHealth("healthy", {
        type: "delivery_failed",
        retriesRemaining: true,
      }),
    ).toBe("degraded");
  });

  it("sets failing when retries are exhausted", () => {
    expect(
      nextAlertChannelHealth("degraded", {
        type: "delivery_failed",
        retriesRemaining: false,
      }),
    ).toBe("failing");
  });

  it("returns healthy after successful delivery or test", () => {
    expect(
      nextAlertChannelHealth("failing", { type: "delivery_succeeded" }),
    ).toBe("healthy");
    expect(nextAlertChannelHealth("degraded", { type: "test_succeeded" })).toBe(
      "healthy",
    );
  });
});

describe("isUnresolvedIncidentStatus", () => {
  it("treats open and acknowledged as unresolved", () => {
    expect(isUnresolvedIncidentStatus("open")).toBe(true);
    expect(isUnresolvedIncidentStatus("acknowledged")).toBe(true);
    expect(isUnresolvedIncidentStatus("resolved")).toBe(false);
  });
});
