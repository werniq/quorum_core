import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import type {
  CadenceType,
  IntervalMode,
} from "../../domain/contracts/types.js";
import { nextExpectedAfterReport } from "../../domain/cadence/next-expected-after-report.js";
import type { CadenceContractFields } from "../../domain/cadence/evaluate-deadline.js";
import {
  type EmptyResultClassification,
  type HeartbeatEvidenceStatus,
  isOutcomeSuccess,
} from "../../domain/evidence/empty-result.js";
import { nextConsecutiveEmptyResults } from "../../domain/health/contract-dimensions.js";
import {
  buildEmptyResultDetails,
  formatEmptyResultRecoverySummary,
  formatEmptyResultSummary,
  parseEmptyResultDetails,
  withEmptyResultRecovery,
  type EmptyResultPolicyKind,
} from "../../domain/incidents/empty-result.js";
import {
  buildHardFailureDetails,
  formatHardFailureRecoverySummary,
  parseHardFailureDetails,
  withHardFailureRecovery,
} from "../../domain/incidents/hard-failure.js";
import { createId } from "../../domain/ids.js";
import type { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";

/**
 * Product timestamp mapping on workflow_states:
 * - last_execution_at → last_report_at (any valid heartbeat)
 * - last_acceptable_success_at → last_success_at (status=success only)
 * - last_nonempty_success_at → last_non_empty_success_at (success with items > 0)
 */
export function computeHeartbeatTimestamps(input: {
  executedAt: string;
  evidenceStatus: HeartbeatEvidenceStatus;
  itemsProcessed: number | null;
  previous: Record<string, unknown> | undefined;
}): {
  lastReportAt: string;
  lastSuccessAt: string | null;
  lastNonEmptySuccessAt: string | null;
  lastFailureAt: string | null;
} {
  const previousSuccess =
    (input.previous?.last_acceptable_success_at as string | null) ?? null;
  const previousNonEmpty =
    (input.previous?.last_nonempty_success_at as string | null) ?? null;
  const previousFailure =
    (input.previous?.last_failure_at as string | null) ?? null;

  return {
    lastReportAt: input.executedAt,
    lastSuccessAt: isOutcomeSuccess(input.evidenceStatus)
      ? input.executedAt
      : previousSuccess,
    lastNonEmptySuccessAt:
      input.evidenceStatus === "success" && (input.itemsProcessed ?? 0) > 0
        ? input.executedAt
        : previousNonEmpty,
    lastFailureAt:
      input.evidenceStatus === "failure" ? input.executedAt : previousFailure,
  };
}

export function computeNextExpectedIso(input: {
  contract: Record<string, unknown>;
  lastReportAt: string;
  clock: Clock;
}): string | null {
  const cadenceFields: CadenceContractFields = {
    cadenceType: input.contract.cadence_type as CadenceType,
    cadenceValue: String(input.contract.cadence_value),
    intervalMode: (input.contract.interval_mode as IntervalMode | null) ?? null,
    scheduleAnchorAt: input.contract.schedule_anchor_at
      ? new Date(String(input.contract.schedule_anchor_at))
      : null,
    timezone: (input.contract.timezone as string | null) ?? null,
    allowedLatenessMinutes: Number(
      input.contract.allowed_lateness_minutes ?? 0,
    ),
    maxQuietWindowMinutes:
      input.contract.max_quiet_window_minutes === null ||
      input.contract.max_quiet_window_minutes === undefined
        ? null
        : Number(input.contract.max_quiet_window_minutes),
    monitoringStartedAt: new Date(
      String(
        input.contract.monitoring_started_at ??
          input.contract.activated_at ??
          input.contract.created_at,
      ),
    ),
    lastEvidenceAt: new Date(input.lastReportAt),
  };

  const next = nextExpectedAfterReport({
    contract: cadenceFields,
    initialGraceMinutes: Number(input.contract.initial_grace_minutes ?? 0),
    isActive: Boolean(input.contract.is_active),
    clock: input.clock,
  });
  return next?.toISOString() ?? null;
}

export function upsertWorkflowStateAfterHeartbeat(input: {
  sqlite: Database.Database;
  tenantId: string;
  workflowId: string;
  executedAt: string;
  receivedAt: string;
  evidenceStatus: HeartbeatEvidenceStatus;
  itemsProcessed: number | null;
  externalExecutionRef: string | null;
  previous: Record<string, unknown> | undefined;
  nextExpectedAt: string | null;
  evidenceSummaryCode: string;
  unverifiedJson: string;
  consecutiveEmptyResults?: number;
  lastSourceWatermark?: string | null;
  lastSourceWatermarkAt?: string | null;
  consecutiveStaleWatermarks?: number;
  lastEffectReconciliationStatus?: string | null;
}): void {
  const stamps = computeHeartbeatTimestamps({
    executedAt: input.executedAt,
    evidenceStatus: input.evidenceStatus,
    itemsProcessed: input.itemsProcessed,
    previous: input.previous,
  });

  const consecutiveEmpty =
    input.consecutiveEmptyResults ??
    nextConsecutiveEmptyResults({
      evidenceStatus: input.evidenceStatus,
      itemsProcessed: input.itemsProcessed,
      previous: Number(input.previous?.consecutive_empty_results ?? 0),
    });
  const lastWatermark =
    input.lastSourceWatermark !== undefined
      ? input.lastSourceWatermark
      : ((input.previous?.last_source_watermark as string | null) ?? null);
  const lastWatermarkAt =
    input.lastSourceWatermarkAt !== undefined
      ? input.lastSourceWatermarkAt
      : ((input.previous?.last_source_watermark_at as string | null) ?? null);
  const consecutiveStale =
    input.consecutiveStaleWatermarks ??
    Number(input.previous?.consecutive_stale_watermarks ?? 0);
  const lastEffectStatus =
    input.lastEffectReconciliationStatus !== undefined
      ? input.lastEffectReconciliationStatus
      : ((input.previous?.last_effect_reconciliation_status as string | null) ??
        null);

  input.sqlite
    .prepare(
      `INSERT INTO workflow_states (
         tenant_id, workflow_id, last_execution_at, last_nonempty_success_at,
         last_acceptable_success_at, last_failure_at, last_external_execution_ref,
         last_status, next_expected_at, overdue_since, current_health, evidence_level,
         evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks,
         consecutive_empty_results, last_source_watermark, last_source_watermark_at,
         consecutive_stale_watermarks, last_effect_reconciliation_status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'healthy', 'basic', ?, ?, 0, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workflow_id) DO UPDATE SET
         last_execution_at = excluded.last_execution_at,
         last_nonempty_success_at = excluded.last_nonempty_success_at,
         last_acceptable_success_at = excluded.last_acceptable_success_at,
         last_failure_at = excluded.last_failure_at,
         last_external_execution_ref = excluded.last_external_execution_ref,
         last_status = excluded.last_status,
         next_expected_at = excluded.next_expected_at,
         overdue_since = NULL,
         current_health = 'healthy',
         evidence_level = 'basic',
         evidence_summary_code = excluded.evidence_summary_code,
         unverified_dimensions_json = excluded.unverified_dimensions_json,
         consecutive_stale_checks = 0,
         consecutive_empty_results = excluded.consecutive_empty_results,
         last_source_watermark = excluded.last_source_watermark,
         last_source_watermark_at = excluded.last_source_watermark_at,
         consecutive_stale_watermarks = excluded.consecutive_stale_watermarks,
         last_effect_reconciliation_status = excluded.last_effect_reconciliation_status,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.tenantId,
      input.workflowId,
      stamps.lastReportAt,
      stamps.lastNonEmptySuccessAt,
      stamps.lastSuccessAt,
      stamps.lastFailureAt,
      input.externalExecutionRef,
      input.evidenceStatus,
      input.nextExpectedAt,
      input.evidenceSummaryCode,
      input.unverifiedJson,
      consecutiveEmpty,
      lastWatermark,
      lastWatermarkAt,
      consecutiveStale,
      lastEffectStatus,
      input.receivedAt,
    );
}

export function resolveOpenIncidentsOfTypes(input: {
  alerting: SqliteAlertingRepositories;
  sqlite: Database.Database;
  tenantId: string;
  workflowId: string;
  at: string;
  actor: string;
  types: Array<
    | "hard_failure"
    | "empty_result"
    | "silent_absence"
    | "freshness_stale"
    | "effect_count_mismatch"
  >;
}): void {
  const placeholders = input.types.map(() => "?").join(", ");
  const openIncidents = input.sqlite
    .prepare(
      `SELECT id, incident_type, details_json, opened_at FROM incidents
       WHERE tenant_id = ? AND workflow_id = ?
         AND status IN ('open', 'acknowledged')
         AND incident_type IN (${placeholders})`,
    )
    .all(input.tenantId, input.workflowId, ...input.types) as Array<{
    id: string;
    incident_type: string;
    details_json: string | null;
    opened_at: string;
  }>;

  for (const row of openIncidents) {
    if (row.incident_type === "hard_failure") {
      const existing =
        parseHardFailureDetails(row.details_json) ??
        buildHardFailureDetails({
          existing: null,
          workflowName: "Workflow",
          monitoringMethod: null,
          observedAt: row.opened_at,
          latestStatus: "failure",
          itemsProcessed: null,
          externalExecutionRef: null,
        });
      const recovered = withHardFailureRecovery(existing, input.at);
      input.sqlite
        .prepare(
          `UPDATE incidents
           SET summary = ?, details_json = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(
          formatHardFailureRecoverySummary(recovered),
          JSON.stringify(recovered),
          input.at,
          input.tenantId,
          row.id,
        );
    } else if (row.incident_type === "empty_result") {
      const existing =
        parseEmptyResultDetails(row.details_json) ??
        buildEmptyResultDetails({
          existing: null,
          workflowName: "Workflow",
          monitoringMethod: null,
          policy: "warning",
          observedAt: row.opened_at,
          itemsProcessed: 0,
          externalExecutionRef: null,
          lastNonEmptySuccessAt: null,
        });
      const recovered = withEmptyResultRecovery(existing, input.at);
      input.sqlite
        .prepare(
          `UPDATE incidents
           SET summary = ?, details_json = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(
          formatEmptyResultRecoverySummary(recovered),
          JSON.stringify(recovered),
          input.at,
          input.tenantId,
          row.id,
        );
    }

    input.alerting.resolveIncident(input.tenantId, row.id, {
      actor: input.actor,
      at: input.at,
      resolutionNote:
        row.incident_type === "hard_failure" ||
        row.incident_type === "empty_result"
          ? `Recovered at ${input.at}`
          : row.incident_type === "silent_absence"
            ? "Reporting resumed"
            : null,
      recoveryEvidence: `Accepted healthy evidence at ${input.at}`,
    });
    input.alerting.enqueueOutbox(input.tenantId, {
      id: createId(),
      incidentId: row.id,
      eventType: "resolved",
      payloadJson: JSON.stringify({
        incidentId: row.id,
        incidentType: row.incident_type,
      }),
      availableAt: input.at,
    });
  }
}

export function openOrUpdateEmptyResultIncident(input: {
  alerting: SqliteAlertingRepositories;
  sqlite: Database.Database;
  tenantId: string;
  workflowId: string;
  receivedAt: string;
  executedAt: string;
  policy: EmptyResultPolicyKind;
  itemsProcessed: number;
  externalExecutionRef: string | null;
  lastNonEmptySuccessAt: string | null;
  consecutiveEmpties: number;
  breachThreshold: number;
  enqueueOpened: (incidentId: string) => void;
}): void {
  if (input.consecutiveEmpties < Math.max(1, input.breachThreshold)) {
    return;
  }
  const workflowMeta = input.sqlite
    .prepare(
      `SELECT name, monitoring_method FROM workflows
       WHERE tenant_id = ? AND id = ?`,
    )
    .get(input.tenantId, input.workflowId) as
    | { name: string; monitoring_method: string }
    | undefined;
  const before = input.alerting.getUnresolvedIncident(
    input.tenantId,
    "workflow",
    input.workflowId,
    "empty_result",
  );
  const details = buildEmptyResultDetails({
    existing: parseEmptyResultDetails(before?.detailsJson),
    workflowName: workflowMeta?.name ?? "Workflow",
    monitoringMethod:
      workflowMeta?.monitoring_method === "poll" ||
      workflowMeta?.monitoring_method === "push"
        ? workflowMeta.monitoring_method
        : null,
    policy: input.policy,
    observedAt: input.executedAt,
    itemsProcessed: input.itemsProcessed,
    externalExecutionRef: input.externalExecutionRef,
    lastNonEmptySuccessAt: input.lastNonEmptySuccessAt,
    // Prefer the tracked consecutive counter (may include pre-incident empties).
    consecutiveEmpties: input.consecutiveEmpties,
  });
  const incident = input.alerting.openOrObserveIncident(input.tenantId, {
    id: createId(),
    contractKind: "workflow",
    workflowId: input.workflowId,
    incidentType: "empty_result",
    severity: input.policy === "warning" ? "warning" : "critical",
    summary: formatEmptyResultSummary(details),
    detailsJson: JSON.stringify(details),
    observedAt: input.receivedAt,
  });
  if (!before) {
    input.enqueueOpened(incident.id);
  }
}

export function openOrUpdateFreshnessIncident(input: {
  alerting: SqliteAlertingRepositories;
  tenantId: string;
  workflowId: string;
  receivedAt: string;
  summary: string;
  detailsJson: string;
  enqueueOpened: (incidentId: string) => void;
}): void {
  const before = input.alerting.getUnresolvedIncident(
    input.tenantId,
    "workflow",
    input.workflowId,
    "freshness_stale",
  );
  const incident = input.alerting.openOrObserveIncident(input.tenantId, {
    id: createId(),
    contractKind: "workflow",
    workflowId: input.workflowId,
    incidentType: "freshness_stale",
    severity: "warning",
    summary: input.summary,
    detailsJson: input.detailsJson,
    observedAt: input.receivedAt,
  });
  if (!before) {
    input.enqueueOpened(incident.id);
  }
}

export function openOrUpdateEffectCountMismatchIncident(input: {
  alerting: SqliteAlertingRepositories;
  tenantId: string;
  workflowId: string;
  receivedAt: string;
  summary: string;
  detailsJson: string;
  enqueueOpened: (incidentId: string) => void;
}): void {
  const before = input.alerting.getUnresolvedIncident(
    input.tenantId,
    "workflow",
    input.workflowId,
    "effect_count_mismatch",
  );
  const incident = input.alerting.openOrObserveIncident(input.tenantId, {
    id: createId(),
    contractKind: "workflow",
    workflowId: input.workflowId,
    incidentType: "effect_count_mismatch",
    severity: "warning",
    summary: input.summary,
    detailsJson: input.detailsJson,
    observedAt: input.receivedAt,
  });
  if (!before) {
    input.enqueueOpened(incident.id);
  }
}

export type { EmptyResultClassification };
