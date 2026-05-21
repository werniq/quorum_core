import type { ContractHealth } from "../terminology.js";
import type { AlertChannelHealthState } from "../terminology.js";

export type CatalogSortBucket =
  | "critical_incident"
  | "alert_channel_failing"
  | "overdue"
  | "warning"
  | "unknown"
  | "healthy"
  | "inactive";

export interface CatalogSortInput {
  health: ContractHealth;
  hasCriticalIncident: boolean;
  alertChannelHealth: AlertChannelHealthState | "none";
}

const BUCKET_RANK: Record<CatalogSortBucket, number> = {
  critical_incident: 0,
  alert_channel_failing: 1,
  overdue: 2,
  warning: 3,
  unknown: 4,
  healthy: 5,
  inactive: 6,
};

export function catalogSortBucket(input: CatalogSortInput): CatalogSortBucket {
  if (input.hasCriticalIncident) {
    return "critical_incident";
  }
  if (input.alertChannelHealth === "failing") {
    return "alert_channel_failing";
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
