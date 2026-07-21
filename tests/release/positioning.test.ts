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
    const landing = readDoc("docs/landing.md");
    const positioning = readDoc("docs/positioning.md");
    const readme = readDoc("README.md");
    const decision = readDoc("docs/release-decision.md");

    for (const doc of [landing, positioning, readme]) {
      expect(doc).toContain(BRAND_PROMISE);
      expect(assertNoProhibitedPositioning(doc)).toEqual([]);
    }

    expect(landing).toContain(SELF_HOSTED_IDENTITY);
    expect(landing).toContain(AGENCY_VALUE);
    expect(landing).toContain(PHASE_A_ALLOWED_CLAIM);
    expect(landing).toContain(PHASE_A_REQUIRED_LIMITATION);
    expect(landing).toContain(PHASE_B_SUPPORTED_PATH);
    expect(landing).toContain("**Preview**");
    expect(landing).toContain("**Available**");
    expect(landing).toContain("**Planned**");

    expect(positioning).toContain(PHASE_B_ALLOWED_CLAIM);
    expect(decision).toMatch(/\bGO\b|early agency|design.partner/i);
    expect(decision).toMatch(/not.*general GA|not.*GA for|Not general GA/i);
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

  it("OSS license and design-partner plan exist", () => {
    const license = readDoc("LICENSE");
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    const plan = readDoc("docs/internal/design-partner-validation.md");
    expect(plan).toContain("Protect a client");
    expect(plan).toContain("HubSpot");
    expect(assertNoProhibitedPositioning(plan)).toEqual([]);
  });

  it("static landing page mirrors claim rules", () => {
    const html = readDoc("docs/landing.html").replace(/\s+/g, " ");
    expect(html).toContain(BRAND_PROMISE);
    expect(html).toContain(PHASE_A_REQUIRED_LIMITATION);
    expect(html).toContain("Preview");
    expect(assertNoProhibitedPositioning(html)).toEqual([]);
    expect(html).not.toMatch(/fonts\.googleapis|cdn\.jsdelivr/i);
  });
});
