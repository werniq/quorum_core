/**
 * Presentation layer boundary.
 * Contract Catalog HTML UI and onboarding live under presentation/html.
 */
export const PRESENTATION_PRIMARY_SURFACE = "contract_catalog" as const;

export const PRESENTATION_SURFACES = [
  "contract_catalog",
  "onboarding",
  "incident_and_evidence_views",
  "network_and_privacy",
  "client_reports",
] as const;
