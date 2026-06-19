/**
 * Release decision helpers. Not domain logic.
 */

export type ReleaseDecision =
  | "conditional_go_design_partners"
  | "no_go"
  | "ga_self_hosted"
  | "ga_hosted";

export const CURRENT_RELEASE_DECISION: ReleaseDecision =
  "conditional_go_design_partners";

export const RELEASE_DECISION_SUMMARY =
  "GO for early agency and design partners on self-hosted Contract Catalog (n8n push/poll + alerts). Hosted SaaS remains Preview / NO-GO.";
