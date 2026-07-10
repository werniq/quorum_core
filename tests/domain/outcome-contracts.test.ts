import { describe, expect, it } from "vitest";
import {
  emailMatchKey,
  evaluateMissingAgainstPolicy,
  matchByNormalizedEmail,
} from "../../src/domain/outcome/match-email.js";
import {
  evidenceLevelAchievedForRun,
  FIRST_SUPPORTED_PATH,
  validateOutcomeContract,
} from "../../src/domain/outcome/types.js";
import {
  isConnectorReadable,
  revokeConnectorStatus,
} from "../../src/domain/outcome/connector-policy.js";

describe("outcome contract domain", () => {
  it("validates the HubSpot→Zoom path and rejects unsupported object types", () => {
    const ok = validateOutcomeContract({
      name: "Webinar attendance",
      businessPurpose: "Every HubSpot registration reaches Zoom",
      contractType: "reconciliation",
      sourceConnectorId: "src",
      destinationConnectorId: "dst",
      sourceObjectType: FIRST_SUPPORTED_PATH.sourceObjectType,
      destinationObjectType: FIRST_SUPPORTED_PATH.destinationObjectType,
      matchKeyDefinition: {
        strategy: "normalized_email",
        sourceField: "email",
        destinationField: "email",
        sourceObjectId: "evt-1",
        destinationObjectId: "wb-1",
      },
      sourceTimeField: "registeredAt",
      destinationTimeField: "create_time",
      maximumDeliveryDelayMinutes: 5,
      acceptableMissingCount: 0,
      acceptableMissingPercentage: 0,
      scheduleExpression: "0 * * * *",
      timezone: "UTC",
      evidenceLevelTarget: "high",
      retentionDays: 30,
      isActive: false,
    });
    expect(ok).toEqual({ ok: true });

    const bad = validateOutcomeContract({
      name: "Other",
      businessPurpose: "x",
      contractType: "reconciliation",
      sourceConnectorId: "src",
      destinationConnectorId: "dst",
      sourceObjectType: "salesforce_lead",
      destinationObjectType: "sheets_row",
      matchKeyDefinition: {
        strategy: "normalized_email",
        sourceField: "email",
        destinationField: "email",
        sourceObjectId: "a",
        destinationObjectId: "b",
      },
      sourceTimeField: "t",
      destinationTimeField: "t",
      maximumDeliveryDelayMinutes: 5,
      acceptableMissingCount: 0,
      acceptableMissingPercentage: 0,
      scheduleExpression: "0 * * * *",
      timezone: "UTC",
      evidenceLevelTarget: "high",
      retentionDays: 30,
      isActive: false,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues).toContain("unsupported_reconciliation_path");
    }
  });

  it("caps aggregate_check at medium and requires explicit confirmation path for high only via record match", () => {
    expect(
      evidenceLevelAchievedForRun({
        contractType: "aggregate_check",
        evidenceLevelTarget: "medium",
        matchedExactly: true,
        aggregateOnly: true,
      }),
    ).toBe("medium");

    expect(
      evidenceLevelAchievedForRun({
        contractType: "reconciliation",
        evidenceLevelTarget: "high",
        matchedExactly: true,
        aggregateOnly: false,
      }),
    ).toBe("high");

    expect(
      evidenceLevelAchievedForRun({
        contractType: "reconciliation",
        evidenceLevelTarget: "high",
        matchedExactly: false,
        aggregateOnly: false,
      }),
    ).toBe("medium");
  });

  it("matches normalized emails with hashes and flags missing/duplicates", () => {
    const hmacKey = "test-identifier-hmac-key";
    const a = emailMatchKey("Ada@Example.com", hmacKey);
    const b = emailMatchKey(" ada@example.com ", hmacKey);
    expect(a.hash).toBe(b.hash);

    const result = matchByNormalizedEmail({
      source: [
        {
          providerRecordId: "1",
          email: "one@ex.com",
          observedAt: new Date("2026-07-19T10:00:00.000Z"),
        },
        {
          providerRecordId: "2",
          email: "two@ex.com",
          observedAt: new Date("2026-07-19T10:01:00.000Z"),
        },
      ],
      destination: [
        {
          providerRecordId: "z1",
          email: "ONE@ex.com",
          observedAt: new Date("2026-07-19T10:02:00.000Z"),
        },
        {
          providerRecordId: "z2",
          email: "dup@ex.com",
          observedAt: new Date("2026-07-19T10:03:00.000Z"),
        },
        {
          providerRecordId: "z3",
          email: "dup@ex.com",
          observedAt: new Date("2026-07-19T10:04:00.000Z"),
        },
      ],
      now: new Date("2026-07-19T11:00:00.000Z"),
      maximumDeliveryDelayMinutes: 5,
      identifierHmacKey: hmacKey,
    });
    expect(result.matchedCount).toBe(1);
    expect(result.missingCount).toBe(1);
    expect(result.duplicateCount).toBeGreaterThanOrEqual(1);
    expect(
      result.items.every((i) => i.sourceIdentifierHash.length === 64),
    ).toBe(true);
  });

  it("evaluates missing policy and connector revocation readability", () => {
    expect(
      evaluateMissingAgainstPolicy({
        sourceCount: 10,
        missingCount: 0,
        acceptableMissingCount: 0,
        acceptableMissingPercentage: 0,
      }),
    ).toBe("healthy");
    expect(
      evaluateMissingAgainstPolicy({
        sourceCount: 10,
        missingCount: 2,
        acceptableMissingCount: 0,
        acceptableMissingPercentage: 10,
      }),
    ).toBe("failed");
    expect(isConnectorReadable("active")).toBe(true);
    expect(isConnectorReadable(revokeConnectorStatus())).toBe(false);
  });
});
