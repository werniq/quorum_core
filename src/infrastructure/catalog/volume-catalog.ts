import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import {
  formatWindowEndLabel,
  computeVolumeWindowForInstant,
} from "../../domain/volume/compute-window.js";
import {
  evaluateVolumeBand,
  formatVolumeRange,
  VOLUME_EVIDENCE_NOT_VERIFIED,
  VOLUME_EVIDENCE_VERIFIED,
} from "../../domain/volume/evaluate-volume-band.js";
import type { ContractVolumeRule } from "../../domain/volume/types.js";
import { SqliteVolumeRepositories } from "../db/repositories/sqlite-volume-repositories.js";

export interface VolumeCatalogSummary {
  label: string;
  expectedRange: string;
  currentCount: string;
  windowEndsLabel: string;
  status: string;
  unknownCountEvents: number;
  evidenceLevel: "basic";
  violationSeverity: string;
  lastFinalizedResult: string | null;
  verified: string[];
  unverified: string[];
}

function windowLabel(windowType: ContractVolumeRule["windowType"]): string {
  if (windowType === "weekly") return "Weekly reported volume";
  if (windowType === "monthly") return "Monthly reported volume";
  return "Daily reported volume";
}

function statusLabel(result: string, isFirstPartial: boolean): string {
  if (isFirstPartial || result === "collecting") return "Collecting";
  if (result === "within_band") return "Within band";
  if (result === "below_minimum") return "Below minimum";
  if (result === "above_maximum") return "Above maximum";
  if (result === "inconclusive") return "Inconclusive";
  return "Collecting";
}

function mapRule(row: Record<string, unknown>): ContractVolumeRule {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    workflowContractId: String(row.workflow_contract_id),
    minimumCount: Number(row.minimum_count),
    maximumCount:
      row.maximum_count === null || row.maximum_count === undefined
        ? null
        : Number(row.maximum_count),
    windowType: row.window_type as ContractVolumeRule["windowType"],
    timezone: String(row.timezone),
    weekStartsOn:
      row.week_starts_on === null || row.week_starts_on === undefined
        ? null
        : Number(row.week_starts_on),
    evaluationGraceMinutes: Number(row.evaluation_grace_minutes),
    violationSeverity:
      row.violation_severity as ContractVolumeRule["violationSeverity"],
    isActive: Boolean(row.is_active),
    activatedAt: new Date(String(row.activated_at)),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export function queryVolumeCatalogSummary(input: {
  sqlite: Database.Database;
  clock: Clock;
  tenantId: string;
  workflowContractId: string;
  workflowId: string;
}): VolumeCatalogSummary | null {
  const row = input.sqlite
    .prepare(
      `SELECT * FROM contract_volume_rules
       WHERE tenant_id = ? AND workflow_contract_id = ? AND is_active = 1
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(input.tenantId, input.workflowContractId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    return null;
  }

  const rule = mapRule(row);
  const volume = new SqliteVolumeRepositories(input.sqlite);
  const now = input.clock.now();
  const heartbeats = volume.listHeartbeatsForVolumeWindow({
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    windowStart: computeVolumeWindowForInstant({
      windowType: rule.windowType,
      timezone: rule.timezone,
      weekStartsOn: rule.weekStartsOn,
      ruleActivatedAt: rule.activatedAt,
      now,
      evaluationGraceMinutes: rule.evaluationGraceMinutes,
    }).windowStart.toISOString(),
    windowEnd: computeVolumeWindowForInstant({
      windowType: rule.windowType,
      timezone: rule.timezone,
      weekStartsOn: rule.weekStartsOn,
      ruleActivatedAt: rule.activatedAt,
      now,
      evaluationGraceMinutes: rule.evaluationGraceMinutes,
    }).windowEnd.toISOString(),
    ruleActivatedAt: rule.activatedAt.toISOString(),
  });

  const outcome = evaluateVolumeBand({ rule, now, heartbeats });
  const latestFinal = input.sqlite
    .prepare(
      `SELECT result FROM volume_band_evaluations
       WHERE tenant_id = ? AND rule_id = ? AND is_finalized = 1
       ORDER BY window_start DESC LIMIT 1`,
    )
    .get(input.tenantId, rule.id) as { result: string } | undefined;

  const currentCount =
    outcome.totalItems === null ? "unknown" : String(outcome.totalItems);

  return {
    label: windowLabel(rule.windowType),
    expectedRange: formatVolumeRange(rule.minimumCount, rule.maximumCount),
    currentCount,
    windowEndsLabel: formatWindowEndLabel(
      outcome.window.windowEnd,
      rule.timezone,
    ),
    status: statusLabel(outcome.result, outcome.window.isFirstPartialWindow),
    unknownCountEvents: outcome.unknownCountEvents,
    evidenceLevel: "basic",
    violationSeverity: rule.violationSeverity,
    lastFinalizedResult: latestFinal
      ? statusLabel(latestFinal.result, false)
      : null,
    verified: [...VOLUME_EVIDENCE_VERIFIED],
    unverified: [...VOLUME_EVIDENCE_NOT_VERIFIED],
  };
}
