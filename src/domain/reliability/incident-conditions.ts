/**
 * Conditions that can open incidents. Absence of acceptable success is first-class.
 */
export const INCIDENT_OPENING_CONDITIONS = [
  "hard_failure",
  "silent_absence",
  "unacceptable_empty_result",
  "repeated_malformed_heartbeat",
  "connector_unavailable",
  "missing_destination_records",
  "alert_delivery_failure",
] as const;

export type IncidentOpeningCondition =
  (typeof INCIDENT_OPENING_CONDITIONS)[number];

export function isIncidentOpeningCondition(
  value: string,
): value is IncidentOpeningCondition {
  return (INCIDENT_OPENING_CONDITIONS as readonly string[]).includes(value);
}
