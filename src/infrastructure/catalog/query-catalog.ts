import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import {
  catalogSortBucket,
  compareCatalogSortBuckets,
} from "../../domain/catalog/sort.js";
import {
  evidenceExplanationForLevel,
  verifiedDimensionsForEvidenceLevel,
} from "../../domain/catalog/evidence-explanation.js";
import { resolveEffectiveEvidenceLevel } from "../../domain/evidence/resolve-evidence-level.js";
import {
  buildContractDimensions,
  rollUpCatalogDisplayHealth,
  type CatalogDisplayHealth,
  type ContractDimensions,
} from "../../domain/health/contract-dimensions.js";
import { shouldSuppressSilentAbsence } from "../../domain/health/monitor-reachability.js";
import type { ContractHealth } from "../../domain/terminology.js";
import type { AlertChannelHealthState } from "../../domain/terminology.js";
import { queryVolumeCatalogSummary } from "./volume-catalog.js";

export interface CatalogContractRow {
  tenantId: string;
  workflowId: string | null;
  contractId: string;
  clientId: string | null;
  clientName: string | null;
  businessPurposeName: string;
  contractKind: "workflow" | "outcome";
  /** Underlying schedule health from workflow_states / deriveHealth. */
  health: ContractHealth;
  /** Primary catalog UI health (monitor_unknown dominates when n8n unreachable). */
  displayHealth: CatalogDisplayHealth;
  dimensions: ContractDimensions;
  evidenceLevel: "basic" | "medium" | "high";
  evidenceExplanation: string;
  verifiedDimensions: string[];
  unverifiedDimensions: string[];
  expectedCadenceOrWindow: string;
  lastAcceptableEvidenceAt: string | null;
  lastReportAt: string | null;
  lastReportStatus: string | null;
  lastExternalExecutionRef: string | null;
  consecutiveFailures: number | null;
  lastNonEmptySuccessAt: string | null;
  lastItemsProcessed: number | null;
  emptyResultPolicy: "warning" | "failure" | null;
  nextDeadlineAt: string | null;
  overdueDurationSeconds: number | null;
  activeIncident: {
    id: string;
    type: string;
    severity: string;
    status: string;
    summary: string;
  } | null;
  connectorHealth: string | null;
  /** Derived from last watcher write to workflow_states.updated_at (per-row). */
  watcherHealth: "ok" | "stale" | "not_evaluated";
  /** Process-level dead-man from watcher_run_state (same for all rows). */
  processWatchdogHealth: "ok" | "stale" | "not_evaluated";
  sourceWatermarkRequired: boolean;
  emptyResultBreachThreshold: number;
  alertChannelHealth: AlertChannelHealthState | "none";
  monitoringMethod: "poll" | "push" | null;
  detailUrl: string;
  isActive: boolean;
  sourceCount: number | null;
  destinationCount: number | null;
  missingCount: number | null;
  oldestMissingAgeSeconds: number | null;
  evidenceStale: boolean;
  lastVerifiedWindow: string | null;
  volumeSummary?: {
    label: string;
    expectedRange: string;
    currentCount: string;
    windowEndsLabel: string;
    status: string;
    unknownCountEvents: number;
    evidenceLevel: string;
  } | null;
}

export function queryContractCatalog(input: {
  sqlite: Database.Database;
  clock: Clock;
  tenantId: string;
  publicBaseUrl: string;
  clientId?: string | null;
  limit?: number;
  offset?: number;
}): CatalogContractRow[] {
  const params: unknown[] = [input.tenantId];
  let clientFilter = "";
  if (input.clientId) {
    clientFilter = " AND w.client_id = ? ";
    params.push(input.clientId);
  }

  const processWatchdogHealth = deriveProcessWatchdogHealth(
    input.sqlite,
    input.clock,
  );

  const rows = input.sqlite
    .prepare(
      `SELECT
         c.id AS contract_id,
         c.tenant_id,
         c.workflow_id,
         c.name AS contract_name,
         c.business_purpose,
         c.cadence_type,
         c.cadence_value,
         c.timezone,
         c.is_active AS contract_active,
         c.evidence_level,
         c.empty_result_policy,
         c.empty_result_breach_threshold,
         c.source_watermark_required,
         w.client_id,
         w.is_active AS workflow_active,
         w.connector_id,
         w.monitoring_method,
         cl.name AS client_name,
         s.current_health,
         s.last_acceptable_success_at,
         s.last_execution_at,
         s.last_nonempty_success_at,
         s.last_status,
         s.last_external_execution_ref,
         s.next_expected_at,
         s.overdue_since,
         s.evidence_level AS state_evidence_level,
         s.updated_at AS state_updated_at,
         s.consecutive_empty_results,
         s.last_source_watermark,
         s.consecutive_stale_watermarks,
         s.evidence_summary_code
       FROM workflow_contracts c
       JOIN workflows w ON w.id = c.workflow_id AND w.tenant_id = c.tenant_id
       LEFT JOIN clients cl ON cl.id = w.client_id AND cl.tenant_id = c.tenant_id
       LEFT JOIN workflow_states s ON s.workflow_id = c.workflow_id AND s.tenant_id = c.tenant_id
       WHERE c.tenant_id = ?
         AND c.contract_type = 'heartbeat'
         AND (c.is_active = 1 OR c.is_active = 0)
         AND IFNULL(w.description, '') != '__quorum_removed__'
         ${clientFilter}`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const mapped: CatalogContractRow[] = rows.map((row) => {
    const workflowId = String(row.workflow_id);
    let connectorHealth: string | null = null;
    const monitoringMethod =
      row.monitoring_method === "poll" || row.monitoring_method === "push"
        ? row.monitoring_method
        : null;
    if (row.connector_id && monitoringMethod !== "push") {
      const connector = input.sqlite
        .prepare(
          `SELECT health FROM n8n_connectors WHERE tenant_id = ? AND id = ?`,
        )
        .get(input.tenantId, String(row.connector_id)) as
        | { health: string }
        | undefined;
      connectorHealth = connector?.health ?? null;
    }

    const declared =
      (row.state_evidence_level as "basic" | "medium" | "high" | undefined) ??
      (row.evidence_level as "basic" | "medium" | "high" | undefined) ??
      "basic";
    const resolved = resolveEffectiveEvidenceLevel({
      declaredLevel: declared,
      contractKind: "heartbeat",
      destinationAggregateImplemented: false,
      destinationAggregateFresh: false,
      recordLevelReconciliationImplemented: false,
      recordLevelReconciliationFresh: false,
      connectorStaleOrUnavailable:
        monitoringMethod !== "push" &&
        (connectorHealth === "unreachable" ||
          connectorHealth === "auth_failed" ||
          connectorHealth === "misconfigured"),
    });
    const evidenceLevel = resolved.level;
    const unverified = resolved.unverifiedDimensions;
    const health = deriveHealth(row);
    const overdueSince = row.overdue_since
      ? new Date(String(row.overdue_since))
      : null;
    const nextExpected = row.next_expected_at
      ? new Date(String(row.next_expected_at))
      : null;
    const nowMs = input.clock.now().getTime();
    let overdueDurationSeconds: number | null = null;
    if (health === "overdue" && overdueSince) {
      overdueDurationSeconds = Math.max(
        0,
        Math.floor((nowMs - overdueSince.getTime()) / 1000),
      );
    } else if (
      (health === "warning" || health === "overdue") &&
      nextExpected &&
      nowMs > nextExpected.getTime()
    ) {
      overdueDurationSeconds = Math.max(
        0,
        Math.floor((nowMs - nextExpected.getTime()) / 1000),
      );
    }

    const openIncidents = input.sqlite
      .prepare(
        `SELECT id, incident_type, severity, status, summary, details_json FROM incidents
         WHERE tenant_id = ? AND workflow_id = ?
           AND status IN ('open', 'acknowledged')
         ORDER BY
           CASE incident_type
             WHEN 'hard_failure' THEN 0
             WHEN 'empty_result' THEN 1
             WHEN 'freshness_stale' THEN 2
             WHEN 'silent_absence' THEN 3
             ELSE 4
           END,
           CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
           opened_at ASC`,
      )
      .all(input.tenantId, workflowId) as Array<{
      id: string;
      incident_type: string;
      severity: string;
      status: string;
      summary: string;
      details_json: string | null;
    }>;

    const incident = openIncidents[0];
    const hasOpenEmptyResult = openIncidents.some(
      (i) => i.incident_type === "empty_result",
    );
    const hasOpenFreshness = openIncidents.some(
      (i) => i.incident_type === "freshness_stale",
    );

    let consecutiveFailures: number | null = null;
    let emptyResultPolicy: "warning" | "failure" | null = null;
    if (incident?.incident_type === "hard_failure" && incident.details_json) {
      try {
        const parsed = JSON.parse(incident.details_json) as {
          consecutiveFailures?: number;
        };
        if (typeof parsed.consecutiveFailures === "number") {
          consecutiveFailures = parsed.consecutiveFailures;
        }
      } catch {
        consecutiveFailures = null;
      }
    }
    const contractEmptyPolicy = String(row.empty_result_policy ?? "");
    if (hasOpenEmptyResult || incident?.incident_type === "empty_result") {
      emptyResultPolicy =
        contractEmptyPolicy === "failure" || contractEmptyPolicy === "warning"
          ? contractEmptyPolicy
          : "warning";
      const emptyIncident =
        openIncidents.find((i) => i.incident_type === "empty_result") ??
        incident;
      if (emptyIncident?.details_json) {
        try {
          const parsed = JSON.parse(emptyIncident.details_json) as {
            policy?: string;
          };
          if (parsed.policy === "failure" || parsed.policy === "warning") {
            emptyResultPolicy = parsed.policy;
          }
        } catch {
          // keep contract policy
        }
      }
    }

    const lastItemsProcessed = row.last_status === "empty_result" ? 0 : null;
    const alertChannelHealth = worstAlertChannelHealth(
      input.sqlite,
      input.tenantId,
      String(row.contract_id),
      workflowId,
    );

    const cadence = `${String(row.cadence_type)}:${String(row.cadence_value)}${
      row.timezone ? `@${String(row.timezone)}` : ""
    }`;

    const volumeSummary = queryVolumeCatalogSummary({
      sqlite: input.sqlite,
      clock: input.clock,
      tenantId: input.tenantId,
      workflowContractId: String(row.contract_id),
      workflowId,
    });

    const emptyResultBreachThreshold = Math.max(
      1,
      Number(row.empty_result_breach_threshold ?? 1),
    );
    const sourceWatermarkRequired = Boolean(row.source_watermark_required);
    const emptyResultConfigured =
      contractEmptyPolicy === "warning" ||
      contractEmptyPolicy === "failure" ||
      emptyResultBreachThreshold > 1;
    const volumeBreached =
      volumeSummary?.status === "Below minimum" ||
      volumeSummary?.status === "Above maximum";
    const consecutiveStaleWatermarks = Number(
      row.consecutive_stale_watermarks ?? 0,
    );
    const evidenceSummaryCode = row.evidence_summary_code
      ? String(row.evidence_summary_code)
      : null;
    const freshnessBreached =
      hasOpenFreshness ||
      evidenceSummaryCode === "freshness_stale" ||
      (sourceWatermarkRequired &&
        consecutiveStaleWatermarks >= emptyResultBreachThreshold);
    const lastSourceWatermark = row.last_source_watermark
      ? String(row.last_source_watermark)
      : null;
    const freshnessUnknown =
      sourceWatermarkRequired &&
      !freshnessBreached &&
      lastSourceWatermark === null;

    const monitorUnreachable = shouldSuppressSilentAbsence({
      monitoringMethod,
      connectorHealth,
    });

    const dimensions = buildContractDimensions({
      monitoringMethod,
      connectorHealth,
      scheduleHealth: health,
      hasOpenEmptyResult,
      emptyResultConfigured,
      volumeBreached,
      sourceWatermarkRequired,
      freshnessBreached,
      freshnessUnknown,
      watcherHealth: processWatchdogHealth,
      monitorUnreachable,
    });
    const displayHealth = rollUpCatalogDisplayHealth({
      scheduleHealth: health,
      dimensions,
      monitorUnreachable,
    });

    return {
      tenantId: String(row.tenant_id),
      workflowId,
      contractId: String(row.contract_id),
      clientId: (row.client_id as string | null) ?? null,
      clientName: (row.client_name as string | null) ?? null,
      businessPurposeName: String(row.business_purpose),
      contractKind: "workflow",
      health,
      displayHealth,
      dimensions,
      evidenceLevel,
      evidenceExplanation: evidenceExplanationForLevel(
        evidenceLevel,
        unverified,
      ),
      verifiedDimensions: [
        ...verifiedDimensionsForEvidenceLevel(evidenceLevel),
      ],
      unverifiedDimensions: [...unverified],
      expectedCadenceOrWindow: cadence,
      lastAcceptableEvidenceAt: row.last_acceptable_success_at
        ? String(row.last_acceptable_success_at)
        : null,
      lastReportAt: row.last_execution_at
        ? String(row.last_execution_at)
        : null,
      lastReportStatus: row.last_status ? String(row.last_status) : null,
      lastExternalExecutionRef: row.last_external_execution_ref
        ? String(row.last_external_execution_ref)
        : null,
      consecutiveFailures,
      lastNonEmptySuccessAt: row.last_nonempty_success_at
        ? String(row.last_nonempty_success_at)
        : null,
      lastItemsProcessed,
      emptyResultPolicy,
      nextDeadlineAt: row.next_expected_at
        ? String(row.next_expected_at)
        : null,
      overdueDurationSeconds,
      activeIncident: incident
        ? {
            id: incident.id,
            type: incident.incident_type,
            severity: incident.severity,
            status: incident.status,
            summary: incident.summary,
          }
        : null,
      connectorHealth,
      watcherHealth: deriveWatcherHealth(
        row.state_updated_at ? String(row.state_updated_at) : null,
        input.clock,
      ),
      processWatchdogHealth,
      sourceWatermarkRequired,
      emptyResultBreachThreshold,
      alertChannelHealth,
      monitoringMethod,
      detailUrl: `${input.publicBaseUrl.replace(/\/+$/, "")}/catalog/contracts/${workflowId}`,
      isActive: Boolean(row.contract_active) && Boolean(row.workflow_active),
      sourceCount: null,
      destinationCount: null,
      missingCount: null,
      oldestMissingAgeSeconds: null,
      evidenceStale: resolved.stale,
      lastVerifiedWindow: null,
      volumeSummary,
    };
  });

  mapped.push(...queryOutcomeCatalogRows({ ...input, processWatchdogHealth }));

  mapped.sort((a, b) => {
    const bucket = compareCatalogSortBuckets(
      catalogSortBucket({
        health: a.displayHealth,
        hasCriticalIncident: a.activeIncident?.severity === "critical",
        alertChannelHealth: a.alertChannelHealth,
      }),
      catalogSortBucket({
        health: b.displayHealth,
        hasCriticalIncident: b.activeIncident?.severity === "critical",
        alertChannelHealth: b.alertChannelHealth,
      }),
    );
    if (bucket !== 0) {
      return bucket;
    }
    return a.businessPurposeName.localeCompare(b.businessPurposeName);
  });

  const offset = Number.isFinite(input.offset) ? Math.max(0, input.offset!) : 0;
  const limit =
    input.limit !== undefined &&
    Number.isFinite(input.limit) &&
    input.limit >= 0
      ? input.limit
      : undefined;
  if (limit === undefined) {
    return mapped.slice(offset);
  }
  return mapped.slice(offset, offset + limit);
}

function queryOutcomeCatalogRows(input: {
  sqlite: Database.Database;
  clock: Clock;
  tenantId: string;
  publicBaseUrl: string;
  clientId?: string | null;
  processWatchdogHealth: "ok" | "stale" | "not_evaluated";
}): CatalogContractRow[] {
  const params: unknown[] = [input.tenantId];
  let clientFilter = "";
  if (input.clientId) {
    clientFilter = " AND oc.client_id = ? ";
    params.push(input.clientId);
  }

  const rows = input.sqlite
    .prepare(
      `SELECT
         oc.*,
         cl.name AS client_name,
         sc.status AS source_status,
         dc.status AS destination_status,
         sc.last_error_code AS source_error,
         dc.last_error_code AS destination_error
       FROM outcome_contracts oc
       LEFT JOIN clients cl ON cl.id = oc.client_id AND cl.tenant_id = oc.tenant_id
       LEFT JOIN connectors sc ON sc.id = oc.source_connector_id AND sc.tenant_id = oc.tenant_id
       LEFT JOIN connectors dc ON dc.id = oc.destination_connector_id AND dc.tenant_id = oc.tenant_id
       WHERE oc.tenant_id = ?
         ${clientFilter}`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const contractId = String(row.id);
    const latest = input.sqlite
      .prepare(
        `SELECT * FROM reconciliation_runs
         WHERE tenant_id = ? AND outcome_contract_id = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(input.tenantId, contractId) as Record<string, unknown> | undefined;

    const sourceStatus = String(row.source_status ?? "pending");
    const destStatus = String(row.destination_status ?? "pending");
    const connectorStale = sourceStatus !== "active" || destStatus !== "active";

    const contractType = String(row.contract_type);
    const target = row.evidence_level_target as "medium" | "high";
    const achieved = latest
      ? (String(latest.evidence_level_achieved) as "medium" | "high")
      : null;
    const runFresh =
      Boolean(latest?.completed_at) &&
      String(latest?.status) !== "failed" &&
      String(latest?.status) !== "unknown";

    const resolved = resolveEffectiveEvidenceLevel({
      declaredLevel: target,
      contractKind: "outcome",
      destinationAggregateImplemented: true,
      destinationAggregateFresh: runFresh,
      recordLevelReconciliationImplemented: contractType === "reconciliation",
      recordLevelReconciliationFresh:
        contractType === "reconciliation" && runFresh && achieved === "high",
      connectorStaleOrUnavailable: connectorStale,
    });

    let health: ContractHealth = "unknown";
    if (!row.is_active) {
      health = "inactive";
    } else if (!latest) {
      health = "unknown";
    } else if (String(latest.status) === "healthy") {
      health = "healthy";
    } else if (String(latest.status) === "warning") {
      health = "warning";
    } else if (String(latest.status) === "failed") {
      health = "overdue";
    }

    const incident = input.sqlite
      .prepare(
        `SELECT id, incident_type, severity, status, summary FROM incidents
         WHERE tenant_id = ? AND outcome_contract_id = ?
           AND status IN ('open', 'acknowledged')
         ORDER BY
           CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
           opened_at ASC
         LIMIT 1`,
      )
      .get(input.tenantId, contractId) as
      | {
          id: string;
          incident_type: string;
          severity: string;
          status: string;
          summary: string;
        }
      | undefined;

    const alertChannelHealth = worstAlertChannelHealthForOutcome(
      input.sqlite,
      input.tenantId,
      contractId,
    );

    const windowLabel = latest
      ? `window:${String(latest.window_start)}→${String(latest.window_end)}`
      : `schedule:${String(row.schedule_expression)}@${String(row.timezone)}`;

    let oldestMissingAgeSeconds: number | null = null;
    if (latest?.details_location_or_json) {
      try {
        const details = JSON.parse(String(latest.details_location_or_json)) as {
          oldestMissingAgeSeconds?: number | null;
        };
        oldestMissingAgeSeconds =
          typeof details.oldestMissingAgeSeconds === "number"
            ? details.oldestMissingAgeSeconds
            : null;
      } catch {
        oldestMissingAgeSeconds = null;
      }
    }

    if (incident?.severity === "critical") {
      health = "overdue";
    }

    const dimensions = buildContractDimensions({
      monitoringMethod: null,
      connectorHealth: connectorStale
        ? `${sourceStatus}/${destStatus}`
        : "healthy",
      scheduleHealth: health,
      hasOpenEmptyResult: false,
      emptyResultConfigured: false,
      volumeBreached: false,
      sourceWatermarkRequired: false,
      freshnessBreached: false,
      freshnessUnknown: false,
      watcherHealth: input.processWatchdogHealth,
      monitorUnreachable: false,
    });
    const displayHealth = rollUpCatalogDisplayHealth({
      scheduleHealth: health,
      dimensions,
      monitorUnreachable: false,
    });

    return {
      tenantId: String(row.tenant_id),
      workflowId: null,
      contractId,
      clientId: (row.client_id as string | null) ?? null,
      clientName: (row.client_name as string | null) ?? null,
      businessPurposeName: String(row.business_purpose),
      contractKind: "outcome" as const,
      health,
      displayHealth,
      dimensions,
      evidenceLevel: resolved.level,
      evidenceExplanation: evidenceExplanationForLevel(
        resolved.level,
        resolved.unverifiedDimensions,
      ),
      verifiedDimensions: [
        ...verifiedDimensionsForEvidenceLevel(resolved.level),
      ],
      unverifiedDimensions: [...resolved.unverifiedDimensions],
      expectedCadenceOrWindow: windowLabel,
      lastAcceptableEvidenceAt: latest?.completed_at
        ? String(latest.completed_at)
        : null,
      lastReportAt: null,
      lastReportStatus: null,
      lastExternalExecutionRef: null,
      consecutiveFailures: null,
      lastNonEmptySuccessAt: null,
      lastItemsProcessed: null,
      emptyResultPolicy: null,
      nextDeadlineAt: null,
      overdueDurationSeconds: oldestMissingAgeSeconds,
      activeIncident: incident
        ? {
            id: incident.id,
            type: incident.incident_type,
            severity: incident.severity,
            status: incident.status,
            summary: incident.summary,
          }
        : null,
      connectorHealth: connectorStale
        ? `${sourceStatus}/${destStatus}`
        : "healthy",
      watcherHealth: "ok",
      processWatchdogHealth: input.processWatchdogHealth,
      sourceWatermarkRequired: false,
      emptyResultBreachThreshold: 1,
      alertChannelHealth,
      monitoringMethod: null,
      detailUrl: `${input.publicBaseUrl.replace(/\/+$/, "")}/catalog/outcome/${contractId}`,
      isActive: Boolean(row.is_active),
      sourceCount: latest ? Number(latest.source_count) : null,
      destinationCount: latest ? Number(latest.destination_count) : null,
      missingCount: latest ? Number(latest.missing_count) : null,
      oldestMissingAgeSeconds,
      evidenceStale: resolved.stale || connectorStale,
      lastVerifiedWindow:
        runFresh && latest
          ? `${String(latest.window_start)}→${String(latest.window_end)}`
          : latest?.completed_at
            ? `last_verified:${String(latest.completed_at)}`
            : null,
    };
  });
}

function worstAlertChannelHealthForOutcome(
  sqlite: Database.Database,
  tenantId: string,
  outcomeContractId: string,
): AlertChannelHealthState | "none" {
  const rows = sqlite
    .prepare(
      `SELECT s.current_health
       FROM contract_alert_channels r
       JOIN alert_channel_states s
         ON s.tenant_id = r.tenant_id AND s.alert_channel_id = r.alert_channel_id
       WHERE r.tenant_id = ? AND r.contract_kind = 'outcome' AND r.contract_id = ?`,
    )
    .all(tenantId, outcomeContractId) as Array<{ current_health: string }>;

  return pickWorstAlertHealth(rows);
}

function deriveHealth(row: Record<string, unknown>): ContractHealth {
  if (!row.contract_active || !row.workflow_active) {
    return "inactive";
  }
  const health = row.current_health as ContractHealth | null;
  if (
    health === "healthy" ||
    health === "overdue" ||
    health === "warning" ||
    health === "unknown" ||
    health === "inactive"
  ) {
    return health;
  }
  return "unknown";
}

/** Matches default WATCHER_STALE_MS (3 minutes) for catalog card display. */
const WATCHER_STALE_MS = 180_000;

function deriveWatcherHealth(
  stateUpdatedAt: string | null,
  clock: Clock,
): "ok" | "stale" | "not_evaluated" {
  if (!stateUpdatedAt) {
    return "not_evaluated";
  }
  const updatedMs = Date.parse(stateUpdatedAt);
  if (!Number.isFinite(updatedMs)) {
    return "not_evaluated";
  }
  if (clock.now().getTime() - updatedMs > WATCHER_STALE_MS) {
    return "stale";
  }
  return "ok";
}

/** Process-level dead-man switch from watcher_run_state (not per-row updated_at). */
function deriveProcessWatchdogHealth(
  sqlite: Database.Database,
  clock: Clock,
): "ok" | "stale" | "not_evaluated" {
  const row = sqlite
    .prepare(`SELECT last_success_at FROM watcher_run_state WHERE id = 1`)
    .get() as { last_success_at: string | null } | undefined;
  return deriveWatcherHealth(
    row?.last_success_at ? String(row.last_success_at) : null,
    clock,
  );
}

function worstAlertChannelHealth(
  sqlite: Database.Database,
  tenantId: string,
  contractId: string,
  workflowId: string | null,
): AlertChannelHealthState | "none" {
  // Product paths store workflow_contracts.id; some tests/legacy rows used workflows.id.
  const rows = sqlite
    .prepare(
      `SELECT s.current_health
       FROM contract_alert_channels r
       JOIN alert_channel_states s
         ON s.tenant_id = r.tenant_id AND s.alert_channel_id = r.alert_channel_id
       WHERE r.tenant_id = ?
         AND r.contract_kind = 'workflow'
         AND (r.contract_id = ? OR (? IS NOT NULL AND r.contract_id = ?))`,
    )
    .all(tenantId, contractId, workflowId, workflowId) as Array<{
    current_health: string;
  }>;

  return pickWorstAlertHealth(rows);
}

function pickWorstAlertHealth(
  rows: Array<{ current_health: string }>,
): AlertChannelHealthState | "none" {
  if (rows.length === 0) {
    return "none";
  }
  const rank: Record<string, number> = {
    failing: 0,
    degraded: 1,
    unknown: 2,
    healthy: 3,
  };
  let best = rows[0]!.current_health;
  for (const row of rows) {
    if ((rank[row.current_health] ?? 9) < (rank[best] ?? 9)) {
      best = row.current_health;
    }
  }
  return best as AlertChannelHealthState;
}
