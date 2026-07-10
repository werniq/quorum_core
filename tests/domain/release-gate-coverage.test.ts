import { describe, expect, it } from "vitest";
import {
  evidenceExplanationForLevel,
  evidenceRaiseConfidenceHint,
  plainUnverifiedLabels,
  plainVerifiedLabels,
  verifiedDimensionsForEvidenceLevel,
} from "../../src/domain/catalog/evidence-explanation.js";
import { isIncidentOpeningCondition } from "../../src/domain/reliability/incident-conditions.js";
import { parsePositiveDurationMinutes } from "../../src/domain/cadence/duration.js";
import { resolveEffectiveEvidenceLevel } from "../../src/domain/evidence/resolve-evidence-level.js";

describe("release-gate domain coverage", () => {
  it("explains verified and unverified dimensions in plain language", () => {
    expect(verifiedDimensionsForEvidenceLevel("basic")).toContain(
      "execution_evidence_received",
    );
    expect(verifiedDimensionsForEvidenceLevel("medium").length).toBeGreaterThan(
      0,
    );
    expect(verifiedDimensionsForEvidenceLevel("high")).toContain(
      "cadence_evaluated",
    );
    expect(plainVerifiedLabels("basic").join(" ")).toMatch(
      /Execution evidence/i,
    );
    expect(
      plainUnverifiedLabels(["destination_delivery_not_checked"]).join(" "),
    ).toMatch(/not independently checked/i);
    expect(
      plainUnverifiedLabels(["payload_count_supplied_by_workflow"])[0],
    ).toMatch(/counts/i);
    expect(plainUnverifiedLabels(["connector_health_unknown"])[0]).toMatch(
      /Connector/i,
    );
    expect(
      plainUnverifiedLabels(["exact_record_matching_unavailable"])[0],
    ).toMatch(/Exact record/i);
    expect(evidenceExplanationForLevel("basic")).toMatch(/Basic evidence/i);
    expect(evidenceExplanationForLevel("medium")).toMatch(/Medium evidence/i);
    expect(evidenceExplanationForLevel("high")).toMatch(/High evidence/i);
    expect(evidenceRaiseConfidenceHint("basic")).toMatch(/HubSpot/i);
    expect(evidenceRaiseConfidenceHint("medium")).toMatch(/record-level/i);
    expect(evidenceRaiseConfidenceHint("high")).toMatch(/already in place/i);
  });

  it("recognizes incident opening conditions", () => {
    expect(isIncidentOpeningCondition("silent_absence")).toBe(true);
    expect(isIncidentOpeningCondition("not_a_real_condition")).toBe(false);
  });

  it("rejects non-positive duration unit amounts", () => {
    expect(parsePositiveDurationMinutes("0m")).toBeNull();
    expect(parsePositiveDurationMinutes("-1h")).toBeNull();
    expect(parsePositiveDurationMinutes("2h")).toBe(120);
    expect(parsePositiveDurationMinutes("1d")).toBe(1440);
  });

  it("marks basic evidence stale when connector is unavailable", () => {
    const resolved = resolveEffectiveEvidenceLevel({
      contractKind: "heartbeat",
      declaredLevel: "basic",
      destinationAggregateImplemented: false,
      destinationAggregateFresh: false,
      recordLevelReconciliationImplemented: false,
      recordLevelReconciliationFresh: false,
      connectorStaleOrUnavailable: true,
    });
    expect(resolved.stale).toBe(true);
    expect(resolved.reasonCode).toBe("evidence_basic_connector_stale");
  });
});
