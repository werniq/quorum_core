import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import { evaluateCadence } from "../../domain/cadence/evaluate-cadence.js";
import type { CadenceContractFields } from "../../domain/cadence/evaluate-deadline.js";
import { shouldEnqueueRenotification } from "../../domain/alerting/renotification.js";
import { createId } from "../../domain/ids.js";
import { unverifiedDimensionsForEvidenceLevel } from "../../domain/evidence/unverified-dimensions.js";
import { SILENT_ABSENCE_MESSAGE } from "../../domain/n8n/workflow-editor-url.js";
import { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";
import {
  assertProcessingAllowed,
  type SchemaReadinessState,
} from "../../application/schema-readiness.js";
import { localMetrics } from "../observability/metrics.js";
import { SqliteVolumeRepositories } from "../db/repositories/sqlite-volume-repositories.js";
import { runVolumeEvaluatorTick } from "../volume/run-volume-evaluator.js";

export interface WatcherTickResult {
  evaluated: number;
  claimed: number;
  openedSilentAbsence: number;
  resolvedSilentAbsence: number;
  renotifications: number;
  volumeRulesEvaluated: number;
  volumeEvaluationsUpserted: number;
  volumeIncidentsOpened: number;
  volumeIncidentsResolved: number;
}

export function createWatcher(deps: {
  sqlite: Database.Database;
  clock: Clock;
  claimOwner: string;
  claimTtlMs: number;
  getSchemaReadiness: () => SchemaReadinessState;
}) {
  const alerting = new SqliteAlertingRepositories(deps.sqlite);
  const volumeRepos = new SqliteVolumeRepositories(deps.sqlite);

  function getRunState(): {
    lastSuccessAt: string | null;
    lastStartedAt: string | null;
    lastErrorSummary: string | null;
    evaluatedContracts: number;
  } {
    const row = deps.sqlite
      .prepare(`SELECT * FROM watcher_run_state WHERE id = 1`)
      .get() as
      | {
          last_success_at: string | null;
          last_started_at: string | null;
          last_error_summary: string | null;
          evaluated_contracts: number;
        }
      | undefined;
    return {
      lastSuccessAt: row?.last_success_at ?? null,
      lastStartedAt: row?.last_started_at ?? null,
      lastErrorSummary: row?.last_error_summary ?? null,
      evaluatedContracts: row?.evaluated_contracts ?? 0,
    };
  }

  function runTick(tenantId?: string): WatcherTickResult {
    assertProcessingAllowed(deps.getSchemaReadiness(), "watcher");
    const tickStarted = Date.now();
    const now = deps.clock.now();
    const nowIso = now.toISOString();
    deps.sqlite
      .prepare(
        `UPDATE watcher_run_state
         SET last_started_at = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(nowIso, nowIso);

    try {
      const contracts = listActiveContracts(deps.sqlite, tenantId);
      let evaluated = 0;
      let claimed = 0;
      let openedSilentAbsence = 0;
      let resolvedSilentAbsence = 0;
      let renotifications = 0;

      for (const contract of contracts) {
        if (
          !tryClaim(
            deps.sqlite,
            contract.tenant_id,
            contract.workflow_id,
            deps.claimOwner,
            nowIso,
            new Date(now.getTime() + deps.claimTtlMs).toISOString(),
          )
        ) {
          continue;
        }
        claimed += 1;
        try {
          const result = evaluateOne(contract, now, nowIso);
          evaluated += 1;
          openedSilentAbsence += result.openedSilentAbsence;
          resolvedSilentAbsence += result.resolvedSilentAbsence;
          renotifications += result.renotifications;
        } finally {
          releaseClaim(
            deps.sqlite,
            contract.tenant_id,
            contract.workflow_id,
            deps.claimOwner,
          );
        }
      }

      deps.sqlite
        .prepare(
          `UPDATE watcher_run_state
           SET last_success_at = ?,
               last_error_summary = NULL,
               evaluated_contracts = ?,
               updated_at = ?
           WHERE id = 1`,
        )
        .run(nowIso, evaluated, nowIso);

      localMetrics.inc("quorum_watcher_ticks_total");
      localMetrics.setGauge("quorum_watcher_contracts_evaluated", evaluated);
      localMetrics.observe(
        "quorum_watcher_tick_duration_ms",
        Date.now() - tickStarted,
      );

      let volumeRulesEvaluated = 0;
      let volumeEvaluationsUpserted = 0;
      let volumeIncidentsOpened = 0;
      let volumeIncidentsResolved = 0;
      if (tenantId) {
        const volumeResult = runVolumeEvaluatorTick(tenantId, {
          volume: volumeRepos,
          alerting,
          clock: () => deps.clock.now(),
          claimOwner: deps.claimOwner,
          claimTtlMs: deps.claimTtlMs,
          listContractsForRule: (rule) => {
            const row = deps.sqlite
              .prepare(
                `SELECT c.is_active AS contract_active, w.id AS workflow_id,
                        w.client_id, w.is_active AS workflow_active
                 FROM workflow_contracts c
                 JOIN workflows w
                   ON w.id = c.workflow_id AND w.tenant_id = c.tenant_id
                 WHERE c.tenant_id = ? AND c.id = ?`,
              )
              .get(tenantId, rule.workflowContractId) as
              | {
                  contract_active: number;
                  workflow_id: string;
                  client_id: string | null;
                  workflow_active: number;
                }
              | undefined;
            if (!row || !row.contract_active || !row.workflow_active) {
              return null;
            }
            return {
              workflowId: row.workflow_id,
              clientId: row.client_id,
              contractActive: true,
            };
          },
        });
        volumeRulesEvaluated = volumeResult.rulesEvaluated;
        volumeEvaluationsUpserted = volumeResult.evaluationsUpserted;
        volumeIncidentsOpened = volumeResult.incidentsOpened;
        volumeIncidentsResolved = volumeResult.incidentsResolved;
      }

      return {
        evaluated,
        claimed,
        openedSilentAbsence,
        resolvedSilentAbsence,
        renotifications,
        volumeRulesEvaluated,
        volumeEvaluationsUpserted,
        volumeIncidentsOpened,
        volumeIncidentsResolved,
      };
    } catch (error) {
      localMetrics.inc("quorum_watcher_tick_failures_total");
      const summary =
        error instanceof Error ? error.message.slice(0, 240) : "watcher_failed";
      deps.sqlite
        .prepare(
          `UPDATE watcher_run_state
           SET last_error_summary = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(summary, nowIso);
      throw error;
    }
  }

  function evaluateOne(
    contract: ActiveContractRow,
    now: Date,
    nowIso: string,
  ): {
    openedSilentAbsence: number;
    resolvedSilentAbsence: number;
    renotifications: number;
  } {
    let openedSilentAbsence = 0;
    let resolvedSilentAbsence = 0;
    let renotifications = 0;

    const state = deps.sqlite
      .prepare(
        `SELECT * FROM workflow_states
         WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .get(contract.tenant_id, contract.workflow_id) as
      | Record<string, unknown>
      | undefined;

    const cadenceFields: CadenceContractFields = {
      cadenceType:
        contract.cadence_type as CadenceContractFields["cadenceType"],
      cadenceValue: contract.cadence_value,
      intervalMode:
        (contract.interval_mode as CadenceContractFields["intervalMode"]) ??
        null,
      scheduleAnchorAt: contract.schedule_anchor_at
        ? new Date(contract.schedule_anchor_at)
        : null,
      timezone: contract.timezone,
      allowedLatenessMinutes: contract.allowed_lateness_minutes,
      maxQuietWindowMinutes: contract.max_quiet_window_minutes,
      monitoringStartedAt: new Date(
        contract.monitoring_started_at ??
          contract.activated_at ??
          contract.created_at,
      ),
      lastEvidenceAt: state?.last_execution_at
        ? new Date(String(state.last_execution_at))
        : null,
    };

    const evaluation = evaluateCadence(
      {
        isActive: Boolean(contract.workflow_is_active && contract.is_active),
        initialGraceMinutes: contract.initial_grace_minutes,
        contract: cadenceFields,
      },
      deps.clock,
    );

    const unverified = unverifiedDimensionsForEvidenceLevel(
      (contract.evidence_level as "basic" | "medium" | "high") ?? "basic",
    );

    deps.sqlite
      .prepare(
        `INSERT INTO workflow_states (
           tenant_id, workflow_id, last_status, next_expected_at, overdue_since,
           current_health, evidence_level, evidence_summary_code,
           unverified_dimensions_json, consecutive_stale_checks, updated_at
         ) VALUES (?, ?, COALESCE((SELECT last_status FROM workflow_states WHERE tenant_id = ? AND workflow_id = ?), 'unknown'),
           ?, ?, ?, 'basic', ?, ?, 0, ?)
         ON CONFLICT(tenant_id, workflow_id) DO UPDATE SET
           next_expected_at = excluded.next_expected_at,
           overdue_since = excluded.overdue_since,
           current_health = excluded.current_health,
           evidence_level = 'basic',
           evidence_summary_code = excluded.evidence_summary_code,
           unverified_dimensions_json = excluded.unverified_dimensions_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        contract.tenant_id,
        contract.workflow_id,
        contract.tenant_id,
        contract.workflow_id,
        evaluation.expectedAt?.toISOString() ?? null,
        evaluation.overdueSince?.toISOString() ?? null,
        evaluation.health === "inactive"
          ? "inactive"
          : evaluation.health === "unknown"
            ? "unknown"
            : evaluation.health === "warning"
              ? "warning"
              : evaluation.health === "overdue"
                ? "overdue"
                : "healthy",
        evaluation.reasonCode,
        JSON.stringify(unverified),
        nowIso,
      );

    if (evaluation.health === "overdue") {
      const before = alerting.getUnresolvedIncident(
        contract.tenant_id,
        "workflow",
        contract.workflow_id,
        "silent_absence",
      );
      const incident = alerting.openOrObserveIncident(contract.tenant_id, {
        id: createId(),
        clientId: contract.client_id,
        contractKind: "workflow",
        workflowId: contract.workflow_id,
        incidentType: "silent_absence",
        severity: "critical",
        summary: SILENT_ABSENCE_MESSAGE,
        detailsJson: JSON.stringify({
          expectedAt: evaluation.expectedAt?.toISOString() ?? null,
          deadlineAt: evaluation.deadlineAt?.toISOString() ?? null,
          overdueSince: evaluation.overdueSince?.toISOString() ?? null,
          reasonCode: evaluation.reasonCode,
        }),
        observedAt: nowIso,
      });
      if (!before) {
        openedSilentAbsence = 1;
        alerting.enqueueOutbox(contract.tenant_id, {
          id: createId(),
          incidentId: incident.id,
          eventType: "opened",
          payloadJson: JSON.stringify({ incidentId: incident.id }),
          availableAt: nowIso,
        });
      } else if (
        shouldEnqueueRenotification({
          lastNotifiedAt: before.lastNotifiedAt
            ? new Date(before.lastNotifiedAt)
            : null,
          openedAt: new Date(before.openedAt),
          backoffMinutes: contract.notification_backoff_minutes,
          clock: deps.clock,
        })
      ) {
        alerting.enqueueOutbox(contract.tenant_id, {
          id: createId(),
          incidentId: before.id,
          eventType: "renotification",
          payloadJson: JSON.stringify({ incidentId: before.id }),
          availableAt: nowIso,
        });
        renotifications = 1;
      }
    } else if (
      evaluation.health === "healthy" ||
      evaluation.health === "unknown" ||
      evaluation.health === "warning"
    ) {
      const open = alerting.getUnresolvedIncident(
        contract.tenant_id,
        "workflow",
        contract.workflow_id,
        "silent_absence",
      );
      if (open && evaluation.health === "healthy") {
        alerting.resolveIncident(contract.tenant_id, open.id, {
          at: nowIso,
        });
        alerting.enqueueOutbox(contract.tenant_id, {
          id: createId(),
          incidentId: open.id,
          eventType: "resolved",
          payloadJson: JSON.stringify({ incidentId: open.id }),
          availableAt: nowIso,
        });
        resolvedSilentAbsence = 1;
      }
    }

    return { openedSilentAbsence, resolvedSilentAbsence, renotifications };
  }

  return { runTick, getRunState };
}

interface ActiveContractRow {
  tenant_id: string;
  workflow_id: string;
  client_id: string | null;
  cadence_type: string;
  cadence_value: string;
  interval_mode: string | null;
  schedule_anchor_at: string | null;
  timezone: string | null;
  allowed_lateness_minutes: number;
  max_quiet_window_minutes: number | null;
  initial_grace_minutes: number;
  notification_backoff_minutes: number;
  evidence_level: string;
  is_active: number;
  activated_at: string | null;
  created_at: string;
  monitoring_started_at: string | null;
  workflow_is_active: number;
}

function listActiveContracts(
  sqlite: Database.Database,
  tenantId?: string,
): ActiveContractRow[] {
  if (tenantId) {
    return sqlite
      .prepare(
        `SELECT c.*, w.client_id, w.is_active AS workflow_is_active,
                w.monitoring_started_at
         FROM workflow_contracts c
         JOIN workflows w ON w.id = c.workflow_id AND w.tenant_id = c.tenant_id
         WHERE c.tenant_id = ?
           AND c.contract_type = 'heartbeat'
           AND c.is_active = 1
           AND w.is_active = 1`,
      )
      .all(tenantId) as ActiveContractRow[];
  }
  return sqlite
    .prepare(
      `SELECT c.*, w.client_id, w.is_active AS workflow_is_active,
              w.monitoring_started_at
       FROM workflow_contracts c
       JOIN workflows w ON w.id = c.workflow_id AND w.tenant_id = c.tenant_id
       WHERE c.contract_type = 'heartbeat'
         AND c.is_active = 1
         AND w.is_active = 1`,
    )
    .all() as ActiveContractRow[];
}

function tryClaim(
  sqlite: Database.Database,
  tenantId: string,
  workflowId: string,
  owner: string,
  nowIso: string,
  expiresIso: string,
): boolean {
  const existing = sqlite
    .prepare(
      `SELECT claim_owner, claim_expires_at FROM watcher_contract_claims
       WHERE tenant_id = ? AND workflow_id = ?`,
    )
    .get(tenantId, workflowId) as
    | { claim_owner: string; claim_expires_at: string }
    | undefined;

  if (
    existing &&
    existing.claim_expires_at >= nowIso &&
    existing.claim_owner !== owner
  ) {
    return false;
  }

  if (!existing) {
    try {
      sqlite
        .prepare(
          `INSERT INTO watcher_contract_claims (
             tenant_id, workflow_id, claim_owner, claimed_at, claim_expires_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(tenantId, workflowId, owner, nowIso, expiresIso);
      return true;
    } catch {
      return false;
    }
  }

  const result = sqlite
    .prepare(
      `UPDATE watcher_contract_claims
       SET claim_owner = ?, claimed_at = ?, claim_expires_at = ?
       WHERE tenant_id = ? AND workflow_id = ?
         AND (claim_owner = ? OR claim_expires_at < ?)`,
    )
    .run(owner, nowIso, expiresIso, tenantId, workflowId, owner, nowIso);
  return result.changes === 1;
}

function releaseClaim(
  sqlite: Database.Database,
  tenantId: string,
  workflowId: string,
  owner: string,
): void {
  sqlite
    .prepare(
      `DELETE FROM watcher_contract_claims
       WHERE tenant_id = ? AND workflow_id = ? AND claim_owner = ?`,
    )
    .run(tenantId, workflowId, owner);
}
