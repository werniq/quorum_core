import type {
  AlertChannelHealthState,
  ContractKind,
  IncidentStatus,
} from "../terminology.js";

export type {
  AlertChannelHealthState as AlertChannelHealth,
  ContractKind,
  IncidentStatus,
};

export type AlertChannelHealthEvent =
  | { type: "delivery_failed"; retriesRemaining: boolean }
  | { type: "delivery_succeeded" }
  | { type: "test_succeeded" };

/**
 * Alert-channel health is independent from contract health.
 * - failed attempt with retries remaining → degraded
 * - retries exhausted → failing
 * - successful delivery or successful test → healthy
 */
export function nextAlertChannelHealth(
  _current: AlertChannelHealthState,
  event: AlertChannelHealthEvent,
): AlertChannelHealthState {
  switch (event.type) {
    case "delivery_failed":
      return event.retriesRemaining ? "degraded" : "failing";
    case "delivery_succeeded":
    case "test_succeeded":
      return "healthy";
  }
}

export function isUnresolvedIncidentStatus(status: IncidentStatus): boolean {
  return status === "open" || status === "acknowledged";
}
