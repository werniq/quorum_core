/**
 * Early-customer readiness criteria — measurable gates for design partners.
 */

export type ReadinessStatus = "met" | "partial" | "blocker" | "n_a";

export interface ReadinessCriterion {
  id: string;
  category: string;
  statement: string;
  status: ReadinessStatus;
  evidence: string;
}

export const EARLY_CUSTOMER_READINESS: ReadinessCriterion[] = [
  {
    id: "isolation",
    category: "security",
    statement: "Tenant/client isolation passes adversarial tests",
    status: "met",
    evidence: "tests/security/* (self-hosted local-tenant trust)",
  },
  {
    id: "n8n_modes",
    category: "product",
    statement: "n8n public polling and push mode are reliable",
    status: "met",
    evidence: "tests/n8n/*, tests/self-hosted/n8n-validation-harness.test.ts",
  },
  {
    id: "evidence_honesty",
    category: "product",
    statement: "Catalog and reports expose evidence honestly",
    status: "met",
    evidence:
      "tests/ui/catalog-product-ux.test.ts, positioning Phase A limitation",
  },
  {
    id: "reconciliation_preview",
    category: "product",
    statement:
      "At least one reconciliation path exists in Preview (HubSpot→Zoom)",
    status: "met",
    evidence:
      "tests/outcome/hubspot-zoom-path.test.ts — labeled Preview, not general",
  },
  {
    id: "alert_visibility",
    category: "ops",
    statement: "Alert-channel failure is durable and visible",
    status: "met",
    evidence:
      "tests/integration/incidents-alerts-catalog.test.ts, channel timeline UI",
  },
  {
    id: "dr_docs",
    category: "ops",
    statement:
      "Backup, restore, security, and incident-response procedures documented",
    status: "met",
    evidence: "docs/operations.md, docs/security.md, README upgrades section",
  },
  {
    id: "public_claims",
    category: "positioning",
    statement:
      "No public page claims broader than current evidence capabilities",
    status: "met",
    evidence:
      "README.md + docs/known-limitations.md + tests/release/positioning.test.ts (src/product/positioning.ts)",
  },
];

export function readinessBlockers(
  criteria: ReadinessCriterion[] = EARLY_CUSTOMER_READINESS,
): ReadinessCriterion[] {
  return criteria.filter((c) => c.status === "blocker");
}

export function isReadyForEarlyAgencyCustomers(
  criteria: ReadinessCriterion[] = EARLY_CUSTOMER_READINESS,
): boolean {
  return readinessBlockers(criteria).length === 0;
}
