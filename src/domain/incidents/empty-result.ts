/**
 * Empty-result incident details (zero items while reporting is present).
 */

export type EmptyResultPolicyKind = "warning" | "failure";

export type EmptyResultDetails = {
  workflowName: string;
  monitoringMethod: "poll" | "push" | null;
  policy: EmptyResultPolicyKind;
  firstEmptyAt: string;
  latestEmptyAt: string;
  consecutiveEmpties: number;
  itemsProcessed: number;
  externalExecutionRef: string | null;
  lastNonEmptySuccessAt: string | null;
  recoveredAt?: string | null;
  durationSeconds?: number | null;
};

export function parseEmptyResultDetails(
  detailsJson: string | null | undefined,
): EmptyResultDetails | null {
  if (!detailsJson) return null;
  try {
    const parsed = JSON.parse(detailsJson) as Partial<EmptyResultDetails>;
    if (
      typeof parsed.workflowName !== "string" ||
      typeof parsed.firstEmptyAt !== "string" ||
      typeof parsed.latestEmptyAt !== "string" ||
      typeof parsed.consecutiveEmpties !== "number" ||
      (parsed.policy !== "warning" && parsed.policy !== "failure")
    ) {
      return null;
    }
    return {
      workflowName: parsed.workflowName,
      monitoringMethod:
        parsed.monitoringMethod === "poll" || parsed.monitoringMethod === "push"
          ? parsed.monitoringMethod
          : null,
      policy: parsed.policy,
      firstEmptyAt: parsed.firstEmptyAt,
      latestEmptyAt: parsed.latestEmptyAt,
      consecutiveEmpties: parsed.consecutiveEmpties,
      itemsProcessed:
        typeof parsed.itemsProcessed === "number" ? parsed.itemsProcessed : 0,
      externalExecutionRef:
        typeof parsed.externalExecutionRef === "string"
          ? parsed.externalExecutionRef
          : null,
      lastNonEmptySuccessAt:
        typeof parsed.lastNonEmptySuccessAt === "string"
          ? parsed.lastNonEmptySuccessAt
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

export function buildEmptyResultDetails(input: {
  existing: EmptyResultDetails | null;
  workflowName: string;
  monitoringMethod: "poll" | "push" | null;
  policy: EmptyResultPolicyKind;
  observedAt: string;
  itemsProcessed: number;
  externalExecutionRef: string | null;
  lastNonEmptySuccessAt: string | null;
  /** When set, overrides the default existing+1 increment (tracked state counter). */
  consecutiveEmpties?: number;
}): EmptyResultDetails {
  return {
    workflowName: input.workflowName,
    monitoringMethod: input.monitoringMethod,
    policy: input.policy,
    firstEmptyAt: input.existing?.firstEmptyAt ?? input.observedAt,
    latestEmptyAt: input.observedAt,
    consecutiveEmpties:
      input.consecutiveEmpties ?? (input.existing?.consecutiveEmpties ?? 0) + 1,
    itemsProcessed: input.itemsProcessed,
    externalExecutionRef: input.externalExecutionRef,
    lastNonEmptySuccessAt: input.lastNonEmptySuccessAt,
  };
}

export function withEmptyResultRecovery(
  details: EmptyResultDetails,
  recoveredAt: string,
): EmptyResultDetails {
  const openedMs = Date.parse(details.firstEmptyAt);
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

export function formatEmptyResultSummary(details: EmptyResultDetails): string {
  const label =
    details.policy === "failure" ? "contract violation" : "empty result";
  const ref = details.externalExecutionRef
    ? ` · ref ${details.externalExecutionRef}`
    : "";
  return (
    `${details.workflowName}: ${label}` +
    ` · ${details.consecutiveEmpties} consecutive` +
    ` · 0 items` +
    ref
  );
}

export function formatEmptyResultRecoverySummary(
  details: EmptyResultDetails,
): string {
  const recovered = details.recoveredAt ?? "unknown";
  return (
    `${details.workflowName}: empty result recovered` +
    ` · first ${details.firstEmptyAt}` +
    ` · recovered ${recovered}` +
    ` · ${details.consecutiveEmpties} consecutive before recovery`
  );
}

export function emptyResultPrimaryLabel(
  policy: EmptyResultPolicyKind | null | undefined,
): string {
  return policy === "failure" ? "Contract violation" : "Empty result";
}
