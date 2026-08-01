import type { ContractHealth } from "../terminology.js";
import type { AlertChannelHealthState } from "../terminology.js";
import type { CatalogDisplayHealth } from "../health/contract-dimensions.js";

export type CatalogSortBucket =
  | "critical_incident"
  | "alert_channel_failing"
  | "monitor_unknown"
  | "overdue"
  | "warning"
  | "unknown"
  | "healthy"
  | "inactive";

export interface CatalogSortInput {
  /** Prefer displayHealth (includes monitor_unknown) when available. */
  health: ContractHealth | CatalogDisplayHealth;
  hasCriticalIncident: boolean;
  alertChannelHealth: AlertChannelHealthState | "none";
}

const BUCKET_RANK: Record<CatalogSortBucket, number> = {
  critical_incident: 0,
  alert_channel_failing: 1,
  monitor_unknown: 2,
  overdue: 3,
  warning: 4,
  unknown: 5,
  healthy: 6,
  inactive: 7,
};

export function catalogSortBucket(input: CatalogSortInput): CatalogSortBucket {
  if (input.hasCriticalIncident) {
    return "critical_incident";
  }
  if (input.alertChannelHealth === "failing") {
    return "alert_channel_failing";
  }
  if (input.health === "monitor_unknown") {
    return "monitor_unknown";
  }
  if (input.health === "overdue") {
    return "overdue";
  }
  if (input.health === "warning") {
    return "warning";
  }
  if (input.health === "unknown") {
    return "unknown";
  }
  if (input.health === "inactive") {
    return "inactive";
  }
  return "healthy";
}

export function compareCatalogSortBuckets(
  a: CatalogSortBucket,
  b: CatalogSortBucket,
): number {
  return BUCKET_RANK[a] - BUCKET_RANK[b];
}
