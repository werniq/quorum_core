/**
 * Per-workflow watchdog dimensions under one registration:
 * schedule (did it run?), output (items/policy), freshness (watermark).
 * Monitor reachability and Quorum watcher liveness are trust signals.
 *
 * Monitor unknown dominates the Catalog badge but must not rewrite
 * schedule/output/freshness dimensions — open breaches stay visible.
 */

export type DimensionStatus =
  | "healthy"
  | "breached"
  | "unknown"
  | "not_configured";

export interface ContractDimensions {
  schedule: DimensionStatus;
  output: DimensionStatus;
  freshness: DimensionStatus;
  /** Reachability of the n8n poll connector (push → healthy). */
  monitor: DimensionStatus;
  /** Quorum watcher dead-man (process-level). */
  watchdog: DimensionStatus;
}

export type CatalogDisplayHealth =
  | "healthy"
  | "warning"
  | "overdue"
  | "unknown"
  | "inactive"
  | "monitor_unknown";

export function buildContractDimensions(input: {
  monitoringMethod: "poll" | "push" | null;
  connectorHealth: string | null;
  scheduleHealth: "healthy" | "warning" | "overdue" | "unknown" | "inactive";
  hasOpenEmptyResult: boolean;
  emptyResultConfigured: boolean;
  volumeBreached: boolean;
  sourceWatermarkRequired: boolean;
  freshnessBreached: boolean;
  freshnessUnknown: boolean;
  watcherHealth: "ok" | "stale" | "not_evaluated";
  monitorUnreachable: boolean;
}): ContractDimensions {
  const monitor: DimensionStatus = input.monitorUnreachable
    ? "unknown"
    : input.monitoringMethod === "push"
      ? "healthy"
      : input.monitoringMethod === "poll" && input.connectorHealth === null
        ? "unknown"
        : "healthy";

  // Schedule reflects true cadence health even while monitor is unknown.
  const schedule: DimensionStatus =
    input.scheduleHealth === "overdue" || input.scheduleHealth === "warning"
      ? "breached"
      : input.scheduleHealth === "inactive"
        ? "not_configured"
        : input.scheduleHealth === "unknown"
          ? "unknown"
          : "healthy";

  let output: DimensionStatus = "healthy";
  if (input.hasOpenEmptyResult || input.volumeBreached) {
    output = "breached";
  } else if (!input.emptyResultConfigured) {
    output = "not_configured";
  }

  let freshness: DimensionStatus = "not_configured";
  if (input.sourceWatermarkRequired) {
    if (input.freshnessBreached) {
      freshness = "breached";
    } else if (input.freshnessUnknown) {
      freshness = "unknown";
    } else {
      freshness = "healthy";
    }
  }

  const watchdog: DimensionStatus =
    input.watcherHealth === "ok" ? "healthy" : "unknown";

  return { schedule, output, freshness, monitor, watchdog };
}

/**
 * Roll-up: monitor unknown dominates the badge; schedule/output/freshness
 * remain independently visible on the card dimensions and open incidents.
 */
export function rollUpCatalogDisplayHealth(input: {
  scheduleHealth: "healthy" | "warning" | "overdue" | "unknown" | "inactive";
  dimensions: ContractDimensions;
  monitorUnreachable: boolean;
}): CatalogDisplayHealth {
  if (input.monitorUnreachable) {
    return "monitor_unknown";
  }
  if (input.scheduleHealth === "inactive") {
    return "inactive";
  }
  if (input.dimensions.schedule === "breached") {
    if (input.scheduleHealth === "warning") return "warning";
    return "overdue";
  }
  if (
    input.dimensions.output === "breached" ||
    input.dimensions.freshness === "breached"
  ) {
    return input.scheduleHealth === "overdue" ? "overdue" : "warning";
  }
  if (input.scheduleHealth === "unknown") {
    return "unknown";
  }
  if (input.scheduleHealth === "warning") {
    return "warning";
  }
  if (input.scheduleHealth === "overdue") {
    return "overdue";
  }
  return "healthy";
}

export function dimensionStatusLabel(status: DimensionStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "breached":
      return "Breached";
    case "unknown":
      return "Unknown";
    case "not_configured":
      return "Not configured";
  }
}

/**
 * Consecutive empty-result counter:
 * - empty_result → increment
 * - acceptable non-empty success → reset to 0
 * - failure (and other non-empty statuses) → hold previous
 */
export function nextConsecutiveEmptyResults(input: {
  evidenceStatus: "success" | "failure" | "empty_result";
  itemsProcessed: number | null;
  previous: number;
}): number {
  if (input.evidenceStatus === "empty_result") {
    return input.previous + 1;
  }
  if (input.evidenceStatus === "success" && (input.itemsProcessed ?? 0) > 0) {
    return 0;
  }
  return input.previous;
}
