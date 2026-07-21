import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENCY_VALUE,
  assertNoProhibitedPositioning,
  BRAND_PROMISE,
  FEATURE_MATRIX,
  featureMatrixMarkdown,
  PHASE_A_ALLOWED_CLAIM,
  PHASE_A_REQUIRED_LIMITATION,
  PHASE_B_ALLOWED_CLAIM,
  PHASE_B_SUPPORTED_PATH,
  SELF_HOSTED_IDENTITY,
} from "../../src/product/positioning.js";
import {
  EARLY_CUSTOMER_READINESS,
  isReadyForEarlyAgencyCustomers,
  readinessBlockers,
} from "../../src/release/customer-readiness.js";

const root = path.resolve(".");

function readDoc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

describe("release positioning and customer readiness", () => {
  it("keeps brand promises and required limitations in public docs", () => {
    const readme = readDoc("README.md");
    const limitations = readDoc("docs/known-limitations.md");
    const decision = readDoc("docs/release-decision.md");
    const corpus = [readme, limitations, decision].join("\n");

    for (const doc of [readme, limitations, decision]) {
      expect(assertNoProhibitedPositioning(doc)).toEqual([]);
    }

    expect(readme).toContain(BRAND_PROMISE);
    expect(readme).toContain(SELF_HOSTED_IDENTITY);
    expect(readme).toContain(AGENCY_VALUE);
    expect(readme).toContain(PHASE_A_ALLOWED_CLAIM);
    expect(readme).toContain(PHASE_A_REQUIRED_LIMITATION);
    expect(corpus).toContain(PHASE_B_SUPPORTED_PATH);
    expect(limitations).toContain(PHASE_B_ALLOWED_CLAIM);
    expect(corpus).toContain("**Preview**");
    expect(corpus).toContain("**Available**");
    expect(corpus).toContain("**Planned**");

    expect(decision).toMatch(/\bGO\b|early agency|design.partner/i);
    expect(decision).toMatch(/not.*general GA|not.*GA for|Not general GA/i);
    expect(decision).toMatch(/Hosted SaaS.*NO-GO|NO-GO/);
  });

  it("feature matrix uses explicit availability labels", () => {
    const md = featureMatrixMarkdown();
    expect(FEATURE_MATRIX.some((f) => f.availability === "Preview")).toBe(true);
    expect(FEATURE_MATRIX.some((f) => f.availability === "Planned")).toBe(true);
    expect(md).toContain("HubSpot webinar");
    expect(md).not.toMatch(/end-to-end verification for all n8n/i);
  });

  it("early-customer readiness has no blockers", () => {
    expect(readinessBlockers()).toEqual([]);
    expect(isReadyForEarlyAgencyCustomers()).toBe(true);
    expect(EARLY_CUSTOMER_READINESS.every((c) => c.status !== "blocker")).toBe(
      true,
    );
  });

  it("OSS license and design-partner framing exist", () => {
    const license = readDoc("LICENSE");
    expect(license).toContain("Apache License");
    const decision = readDoc("docs/release-decision.md");
    const limitations = readDoc("docs/known-limitations.md");
    expect(decision).toMatch(/design.partner/i);
    expect(decision).toContain("NO-GO");
    expect(limitations).toContain("HubSpot");
    expect(limitations).toMatch(/Protect/i);
    expect(assertNoProhibitedPositioning(decision)).toEqual([]);
    expect(assertNoProhibitedPositioning(limitations)).toEqual([]);
  });

  it("positioning source of truth stays outside domain", () => {
    expect(
      fs.existsSync(path.join(root, "src/product/positioning.ts")),
    ).toBe(true);
    const positioning = readDoc("src/product/positioning.ts");
    expect(positioning).toContain(BRAND_PROMISE);
    expect(positioning).toContain(PHASE_A_REQUIRED_LIMITATION);
    expect(positioning).toContain("PROHIBITED_POSITIONING_PHRASES");
    expect(positioning).not.toMatch(/from\s+["'][^"']*\/domain\//);
    const readme = readDoc("README.md");
    expect(readme).not.toMatch(/fonts\.googleapis|cdn\.jsdelivr/i);
    expect(assertNoProhibitedPositioning(readme)).toEqual([]);
  });
});

