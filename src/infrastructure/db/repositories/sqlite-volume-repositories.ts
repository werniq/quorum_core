import type Database from "better-sqlite3";
import type {
  CreateVolumeRuleInput,
  UpsertVolumeEvaluationInput,
  VolumeRepositories,
} from "../../../application/repositories/volume-repositories.js";
import type {
  ContractVolumeRule,
  HeartbeatVolumeContribution,
  VolumeBandEvaluation,
} from "../../../domain/volume/types.js";

function nowIso(): string {
  return new Date().toISOString();
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

function mapEvaluation(row: Record<string, unknown>): VolumeBandEvaluation {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ruleId: String(row.rule_id),
    workflowContractId: String(row.workflow_contract_id),
    windowStart: new Date(String(row.window_start)),
    windowEnd: new Date(String(row.window_end)),
    evaluatedAt: row.evaluated_at ? new Date(String(row.evaluated_at)) : null,
    totalItems:
      row.total_items === null || row.total_items === undefined
        ? null
        : Number(row.total_items),
    countedEvents: Number(row.counted_events),
    unknownCountEvents: Number(row.unknown_count_events),
    result: row.result as VolumeBandEvaluation["result"],
    minimumCount: Number(row.minimum_count),
    maximumCount:
      row.maximum_count === null || row.maximum_count === undefined
        ? null
        : Number(row.maximum_count),
    isFinalized: Boolean(row.is_finalized),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

export class SqliteVolumeRepositories implements VolumeRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  createVolumeRule(
    tenantId: string,
    input: CreateVolumeRuleInput,
  ): ContractVolumeRule {
    const createdAt = nowIso();
    this.sqlite
      .prepare(
        `INSERT INTO contract_volume_rules (
           id, tenant_id, workflow_contract_id, minimum_count, maximum_count,
           window_type, timezone, week_starts_on, evaluation_grace_minutes,
           violation_severity, is_active, activated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        input.id,
        tenantId,
        input.workflowContractId,
        input.minimumCount,
        input.maximumCount,
        input.windowType,
        input.timezone,
        input.weekStartsOn,
        input.evaluationGraceMinutes,
        input.violationSeverity,
        input.activatedAt,
        createdAt,
        createdAt,
      );
    return mapRule(
      this.sqlite
        .prepare(`SELECT * FROM contract_volume_rules WHERE id = ?`)
        .get(input.id) as Record<string, unknown>,
    );
  }

  listActiveVolumeRulesForContract(
    tenantId: string,
    workflowContractId: string,
  ): ContractVolumeRule[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM contract_volume_rules
         WHERE tenant_id = ? AND workflow_contract_id = ? AND is_active = 1`,
      )
      .all(tenantId, workflowContractId) as Array<Record<string, unknown>>;
    return rows.map(mapRule);
  }

  listActiveVolumeRules(tenantId: string): ContractVolumeRule[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM contract_volume_rules
         WHERE tenant_id = ? AND is_active = 1`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map(mapRule);
  }

  deactivateVolumeRule(tenantId: string, ruleId: string): void {
    const at = nowIso();
    this.sqlite
      .prepare(
        `UPDATE contract_volume_rules SET is_active = 0, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(at, tenantId, ruleId);
  }

  getVolumeEvaluation(
    tenantId: string,
    ruleId: string,
    windowStart: string,
  ): VolumeBandEvaluation | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM volume_band_evaluations
         WHERE tenant_id = ? AND rule_id = ? AND window_start = ?`,
      )
      .get(tenantId, ruleId, windowStart) as
      | Record<string, unknown>
      | undefined;
    return row ? mapEvaluation(row) : null;
  }

  upsertVolumeEvaluation(
    tenantId: string,
    input: UpsertVolumeEvaluationInput,
  ): VolumeBandEvaluation {
    const existing = this.getVolumeEvaluation(
      tenantId,
      input.ruleId,
      input.windowStart,
    );
    const at = nowIso();
    if (existing?.isFinalized) {
      return existing;
    }
    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE volume_band_evaluations SET
             evaluated_at = ?, total_items = ?, counted_events = ?,
             unknown_count_events = ?, result = ?, minimum_count = ?,
             maximum_count = ?, is_finalized = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(
          input.evaluatedAt,
          input.totalItems,
          input.countedEvents,
          input.unknownCountEvents,
          input.result,
          input.minimumCount,
          input.maximumCount,
          input.isFinalized ? 1 : 0,
          at,
          tenantId,
          existing.id,
        );
      return this.getVolumeEvaluation(
        tenantId,
        input.ruleId,
        input.windowStart,
      )!;
    }
    this.sqlite
      .prepare(
        `INSERT INTO volume_band_evaluations (
           id, tenant_id, rule_id, workflow_contract_id, window_start, window_end,
           evaluated_at, total_items, counted_events, unknown_count_events, result,
           minimum_count, maximum_count, is_finalized, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        tenantId,
        input.ruleId,
        input.workflowContractId,
        input.windowStart,
        input.windowEnd,
        input.evaluatedAt,
        input.totalItems,
        input.countedEvents,
        input.unknownCountEvents,
        input.result,
        input.minimumCount,
        input.maximumCount,
        input.isFinalized ? 1 : 0,
        at,
        at,
      );
    return this.getVolumeEvaluation(tenantId, input.ruleId, input.windowStart)!;
  }

  listHeartbeatsForVolumeWindow(input: {
    tenantId: string;
    workflowId: string;
    windowStart: string;
    windowEnd: string;
    ruleActivatedAt: string;
  }): HeartbeatVolumeContribution[] {
    const rows = this.sqlite
      .prepare(
        `SELECT executed_at, status, items_processed FROM heartbeat_events
         WHERE tenant_id = ? AND workflow_id = ?
           AND executed_at >= ? AND executed_at < ?
           AND executed_at >= ?
           AND status IN ('success', 'empty_result')
         ORDER BY executed_at ASC`,
      )
      .all(
        input.tenantId,
        input.workflowId,
        input.windowStart,
        input.windowEnd,
        input.ruleActivatedAt,
      ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      executedAt: new Date(String(row.executed_at)),
      status: row.status as HeartbeatVolumeContribution["status"],
      itemsProcessed:
        row.items_processed === null || row.items_processed === undefined
          ? null
          : Number(row.items_processed),
    }));
  }

  tryClaimVolumeEvaluation(input: {
    tenantId: string;
    ruleId: string;
    windowStart: string;
    claimOwner: string;
    claimExpiresAt: string;
    nowIso: string;
  }): boolean {
    const existing = this.sqlite
      .prepare(
        `SELECT claim_owner, claim_expires_at FROM volume_evaluation_claims
         WHERE tenant_id = ? AND rule_id = ? AND window_start = ?`,
      )
      .get(input.tenantId, input.ruleId, input.windowStart) as
      | Record<string, unknown>
      | undefined;
    if (
      existing &&
      String(existing.claim_owner) !== input.claimOwner &&
      String(existing.claim_expires_at) > input.nowIso
    ) {
      return false;
    }
    this.sqlite
      .prepare(
        `INSERT INTO volume_evaluation_claims (
           tenant_id, rule_id, window_start, claim_owner, claim_expires_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, rule_id, window_start) DO UPDATE SET
           claim_owner = excluded.claim_owner,
           claim_expires_at = excluded.claim_expires_at,
           updated_at = excluded.updated_at
         WHERE claim_expires_at < excluded.updated_at OR claim_owner = excluded.claim_owner`,
      )
      .run(
        input.tenantId,
        input.ruleId,
        input.windowStart,
        input.claimOwner,
        input.claimExpiresAt,
        input.nowIso,
      );
    const row = this.sqlite
      .prepare(
        `SELECT claim_owner FROM volume_evaluation_claims
         WHERE tenant_id = ? AND rule_id = ? AND window_start = ?`,
      )
      .get(input.tenantId, input.ruleId, input.windowStart) as
      | Record<string, unknown>
      | undefined;
    return String(row?.claim_owner) === input.claimOwner;
  }

  releaseVolumeEvaluationClaim(input: {
    tenantId: string;
    ruleId: string;
    windowStart: string;
    claimOwner: string;
  }): void {
    this.sqlite
      .prepare(
        `DELETE FROM volume_evaluation_claims
         WHERE tenant_id = ? AND rule_id = ? AND window_start = ? AND claim_owner = ?`,
      )
      .run(input.tenantId, input.ruleId, input.windowStart, input.claimOwner);
  }

  getLatestVolumeEvaluationForRule(
    tenantId: string,
    ruleId: string,
  ): VolumeBandEvaluation | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM volume_band_evaluations
         WHERE tenant_id = ? AND rule_id = ?
         ORDER BY window_start DESC LIMIT 1`,
      )
      .get(tenantId, ruleId) as Record<string, unknown> | undefined;
    return row ? mapEvaluation(row) : null;
  }

  listVolumeEvaluationsForContract(
    tenantId: string,
    workflowContractId: string,
    limit = 10,
  ): VolumeBandEvaluation[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM volume_band_evaluations
         WHERE tenant_id = ? AND workflow_contract_id = ?
         ORDER BY window_start DESC LIMIT ?`,
      )
      .all(tenantId, workflowContractId, limit) as Array<
      Record<string, unknown>
    >;
    return rows.map(mapEvaluation);
  }
}
