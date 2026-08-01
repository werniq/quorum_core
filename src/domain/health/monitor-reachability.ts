/**
 * Poll-connector reachability vs workflow silence.
 * A dead n8n API is monitor unknown — not silent absence of the workflow.
 */

export const BAD_CONNECTOR_HEALTH = [
  "unreachable",
  "auth_failed",
  "misconfigured",
] as const;

export type BadConnectorHealth = (typeof BAD_CONNECTOR_HEALTH)[number];

export function isBadConnectorHealth(
  health: string | null | undefined,
): health is BadConnectorHealth {
  return (
    health === "unreachable" ||
    health === "auth_failed" ||
    health === "misconfigured"
  );
}

/** Polling only: push has no n8n connector dependency for evidence. */
export function shouldSuppressSilentAbsence(input: {
  monitoringMethod: string | null | undefined;
  connectorHealth: string | null | undefined;
}): boolean {
  if (input.monitoringMethod !== "poll") {
    return false;
  }
  return isBadConnectorHealth(input.connectorHealth);
}

export const MONITOR_UNREACHABLE_REASON = "monitor_unreachable" as const;
