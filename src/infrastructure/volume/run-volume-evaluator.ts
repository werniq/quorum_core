/**
 * Volume band evaluation tick — runs alongside cadence watcher.
 */

import type { AlertingRepositories } from "../../application/repositories/alerting-repositories.js";
import type { VolumeRepositories } from "../../application/repositories/volume-repositories.js";
import { createId } from "../../domain/ids.js";
import {
  evaluateVolumeBand,
  formatVolumeRange,
  volumeIncidentTypeForResult,
} from "../../domain/volume/evaluate-volume-band.js";
import type { ContractVolumeRule } from "../../domain/volume/types.js";

export interface VolumeEvaluatorDeps {
  volume: VolumeRepositories;
  alerting: AlertingRepositories;
  clock: () => Date;
  claimOwner: string;
  claimTtlMs?: number;
  listContractsForRule: (rule: ContractVolumeRule) => {
    workflowId: string;
    clientId: string | null;
    contractActive: boolean;
  } | null;
}

export interface VolumeEvaluatorTickResult {
  rulesEvaluated: number;
  evaluationsUpserted: number;
  incidentsOpened: number;
  incidentsResolved: number;
}

export function runVolumeEvaluatorTick(
  tenantId: string,
  deps: VolumeEvaluatorDeps,
): VolumeEvaluatorTickResult {
  const rules = deps.volume.listActiveVolumeRules(tenantId);
  let evaluationsUpserted = 0;
  let incidentsOpened = 0;
  let incidentsResolved = 0;
  const now = deps.clock();
  const nowIso = now.toISOString();
  const claimTtlMs = deps.claimTtlMs ?? 30_000;

  for (const rule of rules) {
    const contract = deps.listContractsForRule(rule);
    if (!contract || !contract.contractActive) {
      continue;
    }

    const preview = evaluateVolumeBand({ rule, now, heartbeats: [] });
    const windowStartIso = preview.window.windowStart.toISOString();
    const windowEndIso = preview.window.windowEnd.toISOString();

    const claimed = deps.volume.tryClaimVolumeEvaluation({
      tenantId,
      ruleId: rule.id,
      windowStart: windowStartIso,
      claimOwner: deps.claimOwner,
      claimExpiresAt: new Date(now.getTime() + claimTtlMs).toISOString(),
      nowIso,
    });
    if (!claimed) {
      continue;
    }

    try {
      const heartbeats = deps.volume.listHeartbeatsForVolumeWindow({
        tenantId,
        workflowId: contract.workflowId,
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
        ruleActivatedAt: rule.activatedAt.toISOString(),
      });

      const outcome = evaluateVolumeBand({ rule, now, heartbeats });
      const existing = deps.volume.getVolumeEvaluation(
        tenantId,
        rule.id,
        outcome.window.windowStart.toISOString(),
      );
      if (existing?.isFinalized) {
        continue;
      }

      const shouldFinalize =
        outcome.canEvaluate && now >= outcome.evaluationDeadline;

      deps.volume.upsertVolumeEvaluation(tenantId, {
        id: existing?.id ?? createId(),
        ruleId: rule.id,
        workflowContractId: rule.workflowContractId,
        windowStart: outcome.window.windowStart.toISOString(),
        windowEnd: outcome.window.windowEnd.toISOString(),
        evaluatedAt: shouldFinalize ? nowIso : null,
        totalItems: outcome.totalItems,
        countedEvents: outcome.countedEvents,
        unknownCountEvents: outcome.unknownCountEvents,
        result: outcome.result,
        minimumCount: rule.minimumCount,
        maximumCount: rule.maximumCount,
        isFinalized: shouldFinalize && outcome.result !== "collecting",
      });
      evaluationsUpserted += 1;

      const incidentType = shouldFinalize
        ? volumeIncidentTypeForResult(outcome.result)
        : null;

      if (incidentType) {
        const before = deps.alerting.getUnresolvedVolumeIncident(
          tenantId,
          contract.workflowId,
          rule.id,
          outcome.window.windowStart.toISOString(),
          incidentType,
        );
        if (!before) {
          deps.alerting.openOrObserveIncident(tenantId, {
            id: createId(),
            clientId: contract.clientId,
            contractKind: "workflow",
            workflowId: contract.workflowId,
            incidentType,
            severity: rule.violationSeverity,
            summary: `Volume ${incidentType === "volume_below_minimum" ? "below minimum" : "above maximum"}: ${formatVolumeRange(rule.minimumCount, rule.maximumCount)} (reported ${outcome.totalItems ?? "unknown"})`,
            volumeRuleId: rule.id,
            volumeWindowStart: outcome.window.windowStart.toISOString(),
            detailsJson: JSON.stringify({
              totalItems: outcome.totalItems,
              windowStart: outcome.window.windowStart.toISOString(),
              windowEnd: outcome.window.windowEnd.toISOString(),
            }),
            observedAt: nowIso,
          });
          incidentsOpened += 1;
        }
      }

      if (
        shouldFinalize &&
        (outcome.result === "within_band" || outcome.result === "inconclusive")
      ) {
        for (const type of [
          "volume_below_minimum",
          "volume_above_maximum",
        ] as const) {
          const open = deps.alerting.getUnresolvedVolumeIncident(
            tenantId,
            contract.workflowId,
            rule.id,
            outcome.window.windowStart.toISOString(),
            type,
          );
          if (open) {
            deps.alerting.resolveIncident(tenantId, open.id, {
              actor: "volume_evaluator",
              edition: "self_hosted",
            });
            incidentsResolved += 1;
          }
        }
      }
    } finally {
      deps.volume.releaseVolumeEvaluationClaim({
        tenantId,
        ruleId: rule.id,
        windowStart: windowStartIso,
        claimOwner: deps.claimOwner,
      });
    }
  }

  return {
    rulesEvaluated: rules.length,
    evaluationsUpserted,
    incidentsOpened,
    incidentsResolved,
  };
}
