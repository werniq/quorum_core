import { describe, expect, it } from "vitest";
import {
  canSetEvidenceLevel,
  resolveEffectiveEvidenceLevel,
} from "../../src/domain/evidence/resolve-evidence-level.js";

describe("evidence level policy", () => {
  const heartbeatBase = {
    contractKind: "heartbeat" as const,
    destinationAggregateImplemented: false,
    destinationAggregateFresh: false,
    recordLevelReconciliationImplemented: false,
    recordLevelReconciliationFresh: false,
    connectorStaleOrUnavailable: false,
  };

  it("keeps heartbeat-only contracts at basic even when declared higher", () => {
    const resolved = resolveEffectiveEvidenceLevel({
      ...heartbeatBase,
      declaredLevel: "high",
    });
    expect(resolved.level).toBe("basic");
    expect(resolved.unverifiedDimensions).toContain(
      "destination_delivery_not_checked",
    );
  });

  it("elevates to medium only when destination aggregate is implemented and fresh", () => {
    expect(
      resolveEffectiveEvidenceLevel({
        ...heartbeatBase,
        contractKind: "outcome",
        declaredLevel: "medium",
        destinationAggregateImplemented: true,
        destinationAggregateFresh: true,
      }).level,
    ).toBe("medium");

    expect(
      resolveEffectiveEvidenceLevel({
        ...heartbeatBase,
        contractKind: "outcome",
        declaredLevel: "medium",
        destinationAggregateImplemented: true,
        destinationAggregateFresh: false,
      }).level,
    ).toBe("basic");
  });

  it("elevates to high only when record-level reconciliation is implemented and fresh", () => {
    expect(
      resolveEffectiveEvidenceLevel({
        ...heartbeatBase,
        contractKind: "outcome",
        declaredLevel: "high",
        destinationAggregateImplemented: true,
        destinationAggregateFresh: true,
        recordLevelReconciliationImplemented: true,
        recordLevelReconciliationFresh: true,
      }).level,
    ).toBe("high");

    expect(
      resolveEffectiveEvidenceLevel({
        ...heartbeatBase,
        contractKind: "outcome",
        declaredLevel: "high",
        destinationAggregateImplemented: true,
        destinationAggregateFresh: true,
        recordLevelReconciliationImplemented: true,
        recordLevelReconciliationFresh: false,
      }).level,
    ).toBe("medium");
  });

  it("marks stale and downgrades when connector is unavailable", () => {
    const resolved = resolveEffectiveEvidenceLevel({
      ...heartbeatBase,
      contractKind: "outcome",
      declaredLevel: "medium",
      destinationAggregateImplemented: true,
      destinationAggregateFresh: true,
      connectorStaleOrUnavailable: true,
    });
    expect(resolved.level).toBe("basic");
    expect(resolved.stale).toBe(true);
  });

  it("rejects manually setting a higher evidence level than capabilities allow", () => {
    expect(
      canSetEvidenceLevel({
        requested: "medium",
        capabilities: heartbeatBase,
      }),
    ).toBe(false);
    expect(
      canSetEvidenceLevel({
        requested: "basic",
        capabilities: heartbeatBase,
      }),
    ).toBe(true);
  });
});
