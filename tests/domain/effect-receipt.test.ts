import { describe, expect, it } from "vitest";
import {
  evaluateEffectReceipt,
  extractEffectReceipt,
} from "../../src/domain/evidence/effect-receipt.js";
import { sanitizeHeartbeatMetadata } from "../../src/domain/evidence/heartbeat-metadata.js";
import { reconciliationDimensionLabel } from "../../src/domain/health/contract-dimensions.js";

describe("effect receipt parse", () => {
  it("returns empty optional fields when metadata has no receipt", () => {
    expect(extractEffectReceipt(null).expectedCount).toBeNull();
    expect(extractEffectReceipt({ note: "x" }).writtenCount).toBeNull();
  });

  it("parses camelCase and snake_case aliases", () => {
    const receipt = extractEffectReceipt({
      receipt: {
        input_batch_id: "batch-1",
        expected_count: 10,
        writtenCount: 9,
        rejected_count: 1,
        skipped: 0,
        destination_name: "crm",
        watermark_before: "100",
        watermarkAfter: "101",
        exception_owner: "ops",
        requiredFieldsValid: true,
      },
    });
    expect(receipt).toMatchObject({
      inputBatchId: "batch-1",
      expectedCount: 10,
      writtenCount: 9,
      rejectedCount: 1,
      skippedCount: 0,
      destinationName: "crm",
      watermarkBefore: "100",
      watermarkAfter: "101",
      exceptionOwner: "ops",
      requiredFieldsValid: true,
    });
  });

  it("ignores malformed count fields without failing", () => {
    const receipt = extractEffectReceipt({
      receipt: {
        expectedCount: "ten",
        writtenCount: -1,
        rejectedCount: 1.5,
      },
    });
    expect(receipt.expectedCount).toBeNull();
    expect(receipt.writtenCount).toBeNull();
    expect(receipt.rejectedCount).toBeNull();
  });

  it("accepts receipt metadata through the existing sanitizer", () => {
    const sanitized = sanitizeHeartbeatMetadata({
      receipt: {
        inputBatchId: "b1",
        expectedCount: 3,
        writtenCount: 3,
        destinationName: "sheets",
      },
    });
    expect(sanitized.ok).toBe(true);
    expect(sanitized.metadataJson).toContain("expectedCount");
  });
});

describe("effect receipt evaluation", () => {
  it("stays not_configured when the contract flag is off", () => {
    const result = evaluateEffectReceipt({
      enabled: false,
      metadata: {
        receipt: { expectedCount: 1, writtenCount: 0 },
      },
    });
    expect(result.status).toBe("not_configured");
    expect(result.shouldOpenIncident).toBe(false);
  });

  it("does not evaluate partial receipts", () => {
    expect(
      evaluateEffectReceipt({
        enabled: true,
        metadata: { receipt: { expectedCount: 5 } },
      }),
    ).toMatchObject({
      status: "not_evaluated",
      shouldOpenIncident: false,
      shouldResolveIncident: false,
    });
    expect(
      evaluateEffectReceipt({
        enabled: true,
        metadata: { receipt: { writtenCount: 5 } },
      }),
    ).toMatchObject({
      status: "not_evaluated",
      shouldOpenIncident: false,
      shouldResolveIncident: false,
    });
    expect(
      evaluateEffectReceipt({
        enabled: true,
        metadata: null,
      }),
    ).toMatchObject({
      status: "not_evaluated",
      shouldResolveIncident: false,
    });
  });

  it("passes matching counts and breaches mismatches", () => {
    const passed = evaluateEffectReceipt({
      enabled: true,
      metadata: { receipt: { expectedCount: 4, writtenCount: 4 } },
    });
    expect(passed.status).toBe("passed");
    expect(passed.shouldResolveIncident).toBe(true);

    const breached = evaluateEffectReceipt({
      enabled: true,
      metadata: { receipt: { expectedCount: 4, writtenCount: 2 } },
    });
    expect(breached.status).toBe("breached");
    expect(breached.shouldOpenIncident).toBe(true);
  });

  it("labels Catalog reconciliation as Not configured or Experimental", () => {
    expect(reconciliationDimensionLabel("not_configured")).toBe(
      "Not configured",
    );
    expect(reconciliationDimensionLabel("healthy")).toBe(
      "Experimental · Passed",
    );
    expect(reconciliationDimensionLabel("breached")).toBe(
      "Experimental · Breached",
    );
    expect(reconciliationDimensionLabel("unknown")).toBe(
      "Experimental · Not evaluated",
    );
  });
});
