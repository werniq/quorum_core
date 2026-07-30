/**
 * Hard-failure incident details and human-readable history labels.
 */

export type HardFailureDetails = {
  workflowName: string;
  monitoringMethod: "poll" | "push" | null;
  firstFailureAt: string;
  latestFailureAt: string;
  consecutiveFailures: number;
  latestStatus: string;
  itemsProcessed: number | null;
  externalExecutionRef: string | null;
  recoveredAt?: string | null;
  durationSeconds?: number | null;
};

export function parseHardFailureDetails(
  detailsJson: string | null | undefined,
): HardFailureDetails | null {
  if (!detailsJson) return null;
  try {
    const parsed = JSON.parse(detailsJson) as Partial<HardFailureDetails>;
    if (
      typeof parsed.workflowName !== "string" ||
      typeof parsed.firstFailureAt !== "string" ||
      typeof parsed.latestFailureAt !== "string" ||
      typeof parsed.consecutiveFailures !== "number"
    ) {
      return null;
    }
    return {
      workflowName: parsed.workflowName,
      monitoringMethod:
        parsed.monitoringMethod === "poll" || parsed.monitoringMethod === "push"
          ? parsed.monitoringMethod
          : null,
      firstFailureAt: parsed.firstFailureAt,
      latestFailureAt: parsed.latestFailureAt,
      consecutiveFailures: parsed.consecutiveFailures,
      latestStatus:
        typeof parsed.latestStatus === "string"
          ? parsed.latestStatus
          : "failure",
      itemsProcessed:
        typeof parsed.itemsProcessed === "number"
          ? parsed.itemsProcessed
          : null,
      externalExecutionRef:
        typeof parsed.externalExecutionRef === "string"
          ? parsed.externalExecutionRef
          : null,
      recoveredAt:
        typeof parsed.recoveredAt === "string" ? parsed.recoveredAt : null,
      durationSeconds:
        typeof parsed.durationSeconds === "number"
          ? parsed.durationSeconds
          : null,
    };
  } catch {
    return null;
  }
}

export function buildHardFailureDetails(input: {
  existing: HardFailureDetails | null;
  workflowName: string;
  monitoringMethod: "poll" | "push" | null;
  observedAt: string;
  latestStatus: string;
  itemsProcessed: number | null;
  externalExecutionRef: string | null;
}): HardFailureDetails {
  const firstFailureAt = input.existing?.firstFailureAt ?? input.observedAt;
  const consecutiveFailures = (input.existing?.consecutiveFailures ?? 0) + 1;
  return {
    workflowName: input.workflowName,
    monitoringMethod: input.monitoringMethod,
    firstFailureAt,
    latestFailureAt: input.observedAt,
    consecutiveFailures,
    latestStatus: input.latestStatus,
    itemsProcessed: input.itemsProcessed,
    externalExecutionRef: input.externalExecutionRef,
  };
}

export function withHardFailureRecovery(
  details: HardFailureDetails,
  recoveredAt: string,
): HardFailureDetails {
  const openedMs = Date.parse(details.firstFailureAt);
  const recoveredMs = Date.parse(recoveredAt);
  const durationSeconds =
    Number.isFinite(openedMs) && Number.isFinite(recoveredMs)
      ? Math.max(0, Math.floor((recoveredMs - openedMs) / 1000))
      : null;
  return {
    ...details,
    recoveredAt,
    durationSeconds,
  };
}

function statusWord(status: string): string {
  if (status === "success") return "Success";
  if (status === "empty_result") return "Empty result";
  if (status === "failure") return "Failure";
  return status;
}

function itemsPhrase(count: number | null): string {
  if (count === null || !Number.isFinite(count)) return "unknown items";
  return `${count} item${count === 1 ? "" : "s"}`;
}

export function formatDurationSeconds(
  seconds: number | null | undefined,
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

export function formatHardFailureSummary(details: HardFailureDetails): string {
  const method =
    details.monitoringMethod === "poll"
      ? "polling"
      : details.monitoringMethod === "push"
        ? "push"
        : "unknown method";
  const ref = details.externalExecutionRef
    ? ` · ref ${details.externalExecutionRef}`
    : "";
  return (
    `${details.workflowName}: hard failure` +
    ` · ${details.consecutiveFailures} consecutive` +
    ` · ${statusWord(details.latestStatus)}` +
    ` · ${itemsPhrase(details.itemsProcessed)}` +
    ` · ${method}` +
    ref
  );
}

export function formatHardFailureRecoverySummary(
  details: HardFailureDetails,
): string {
  const recovered = details.recoveredAt ?? "unknown";
  const duration = formatDurationSeconds(details.durationSeconds ?? null);
  return (
    `${details.workflowName}: hard failure recovered` +
    ` · first ${details.firstFailureAt}` +
    ` · recovered ${recovered}` +
    ` · duration ${duration}` +
    ` · ${details.consecutiveFailures} consecutive before recovery`
  );
}

/** Human-readable heartbeat / execution history row, e.g. `17:59 · Failure · 0 items`. */
export function formatHeartbeatHistoryRow(input: {
  at: string;
  status: string;
  itemsProcessed: number | null;
}): string {
  const parsed = Date.parse(input.at);
  let time = input.at;
  if (Number.isFinite(parsed)) {
    const d = new Date(parsed);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    time = `${hh}:${mm}`;
  }
  return `${time} · ${statusWord(input.status)} · ${itemsPhrase(input.itemsProcessed)}`;
}
