import { describe, expect, it } from "vitest";
import {
  CORE_TERMS,
  EVIDENCE_LEVEL_COPY,
  EVIDENCE_LEVELS,
  PRIVACY_STATEMENT,
  PRODUCT_PRIMARY_QUESTION,
  SUPPORTED_AUTOMATION_PLATFORMS,
} from "../../src/domain/terminology.js";

describe("product terminology", () => {
  it("defines the primary product question and privacy statement", () => {
    expect(PRODUCT_PRIMARY_QUESTION).toContain(
      "What is this business supposed to be doing",
    );
    expect(PRIVACY_STATEMENT).toBe("We do not need your workflow data.");
  });

  it("exposes evidence levels with honest plain-language copy", () => {
    expect([...EVIDENCE_LEVELS]).toEqual(["basic", "medium", "high"]);
    expect(EVIDENCE_LEVEL_COPY.basic.title).toBe("Basic evidence");
    expect(EVIDENCE_LEVEL_COPY.basic.body).toContain(
      "did not independently verify the destination record",
    );
  });

  it("limits v1 automation platforms to n8n", () => {
    expect([...SUPPORTED_AUTOMATION_PLATFORMS]).toEqual(["n8n"]);
  });

  it("defines core catalog terminology including outcome contracts", () => {
    expect(CORE_TERMS.contractCatalog).toContain("primary product surface");
    expect(CORE_TERMS.outcomeContract).toContain("source-to-destination");
    expect(CORE_TERMS.evidenceLevel).toContain("basic, medium, or high");
  });
});
