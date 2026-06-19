/**
 * Product positioning copy and feature availability labels.
 * Not domain logic. Keep marketing and release claims out of src/domain.
 */

export const BRAND_PROMISE =
  "Define what each critical workflow should do. Quorum checks whether it ran, whether its reported volume stayed within the expected range, and how strong the evidence actually is.";

export const VOLUME_DIFFERENTIATOR =
  "A workflow can run successfully and still process too little or too much. Quorum checks the reported number as well as the execution status.";

export const COMPETITOR_HEARTBEAT_POSITIONING =
  "Basic heartbeat monitoring is competitively priced and available through free or inexpensive tiers. Quorum competes on workflow contracts, business-volume checks, evidence transparency, incident response, self-hosting, and supported reconciliation paths.";

export const SELF_HOSTED_IDENTITY =
  "Open source, zero telemetry, and designed so your workflow data can stay in your infrastructure.";

export const AGENCY_VALUE =
  "Reliability evidence that protects client retainers and supports proactive maintenance reporting.";

export const PHASE_A_ALLOWED_CLAIM =
  "Quorum shows what your n8n workflows are expected to do, whether reported volume stayed inside declared bands, and alerts you when they fail, stop reporting, or produce an unacceptable result.";

export const PHASE_A_REQUIRED_LIMITATION =
  "Heartbeat and volume-band evidence can be self-reported. They do not independently prove destination delivery.";

export const PHASE_B_ALLOWED_CLAIM =
  "Quorum independently verifies supported business outcomes and identifies records that failed to reach their destination.";

export const PHASE_B_SUPPORTED_PATH =
  "HubSpot webinar registrations → Zoom webinar registrants";

export const PROHIBITED_POSITIONING_PHRASES = [
  "every lead is guaranteed to arrive",
  "end-to-end verification for all n8n workflows",
  "complete workflow reliability",
  "failures can never be silent",
  "Quorum prevents incidents",
] as const;

export type FeatureAvailability = "Available" | "Preview" | "Planned";

export interface FeatureMatrixRow {
  name: string;
  availability: FeatureAvailability;
  notes: string;
}

/**
 * Availability means the feature runs in the default process, has a usable
 * path, and has passing tests. Preview means it works end to end with limits.
 * Planned means adapters or schemas may exist but the normal runtime cannot
 * use the feature completely.
 */
export const FEATURE_MATRIX: FeatureMatrixRow[] = [
  {
    name: "Contract Catalog (default product surface)",
    availability: "Available",
    notes: "Health and Evidence Level are separate dimensions.",
  },
  {
    name: "n8n push heartbeats",
    availability: "Available",
    notes: "Signed POST heartbeats with HMAC credentials.",
  },
  {
    name: "n8n public API polling",
    availability: "Available",
    notes:
      "Self-hosted: UI connector create, test, and workflow bind; poll scheduler in default process. Private n8n may prefer push. Poll URLs are SSRF-gated.",
  },
  {
    name: "Heartbeat contracts (basic evidence)",
    availability: "Available",
    notes: PHASE_A_REQUIRED_LIMITATION,
  },
  {
    name: "Volume band rules (with cadence on same contract)",
    availability: "Available",
    notes:
      "Calendar daily/weekly/monthly windows on reported items_processed. Basic evidence only; does not verify destination delivery.",
  },
  {
    name: "Incident triage (assignee, response targets, resolution notes)",
    availability: "Available",
    notes:
      "Self-hosted local admin. Uses response target language, not SLA guarantees.",
  },
  {
    name: "Outcome reconciliation: HubSpot webinar → Zoom registrants",
    availability: "Preview",
    notes: `${PHASE_B_ALLOWED_CLAIM} Path: ${PHASE_B_SUPPORTED_PATH}.`,
  },
  {
    name: "Agency client reports + share links",
    availability: "Available",
    notes: "Self-hosted reports. Coverage is not overstated.",
  },
  {
    name: "Zapier / Make connectors",
    availability: "Planned",
    notes: "Outside v1.",
  },
  {
    name: "General outcome verification for all workflows",
    availability: "Planned",
    notes: "Do not claim until additional named paths ship.",
  },
];

export function assertNoProhibitedPositioning(copy: string): string[] {
  const lower = copy.toLowerCase();
  return PROHIBITED_POSITIONING_PHRASES.filter((phrase) =>
    lower.includes(phrase.toLowerCase()),
  );
}

export function featureMatrixMarkdown(): string {
  const header = "| Feature | Availability | Notes |\n| --- | --- | --- |\n";
  const rows = FEATURE_MATRIX.map(
    (f) => `| ${f.name} | **${f.availability}** | ${f.notes} |`,
  ).join("\n");
  return header + rows;
}
