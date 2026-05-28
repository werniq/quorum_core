import type Database from "better-sqlite3";
import { createId } from "../../../domain/ids.js";
import type {
  ReconciliationMatchStatus,
  ReconciliationRunStatus,
} from "../../../domain/outcome/types.js";

export interface ReconciliationRunRecord {
  id: string;
  tenantId: string;
  outcomeContractId: string;
  windowStart: string;
  windowEnd: string;
  sourceCount: number;
  destinationCount: number;
  matchedCount: number;
  missingCount: number;
  duplicateCount: number;
  lateCount: number;
  status: ReconciliationRunStatus;
  evidenceLevelAchieved: "medium" | "high";
  startedAt: string;
  completedAt: string | null;
  detailsLocationOrJson: string | null;
}

export interface ReconciliationItemRecord {
  id: string;
  tenantId: string;
  reconciliationRunId: string;
  sourceIdentifierHash: string;
  destinationIdentifierHash: string | null;
  matchStatus: ReconciliationMatchStatus;
  sourceObservedAt: string | null;
  destinationObservedAt: string | null;
  metadataJsonSanitized: string | null;
}

export class SqliteReconciliationRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  createRun(
    tenantId: string,
    input: Omit<ReconciliationRunRecord, "tenantId" | "completedAt" | "id"> & {
      id?: string;
      completedAt?: string | null;
    },
  ): ReconciliationRunRecord {
    const id = input.id ?? createId();
    this.sqlite
      .prepare(
        `INSERT INTO reconciliation_runs (
           id, tenant_id, outcome_contract_id, window_start, window_end,
           source_count, destination_count, matched_count, missing_count,
           duplicate_count, late_count, status, evidence_level_achieved,
           started_at, completed_at, details_location_or_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        input.outcomeContractId,
        input.windowStart,
        input.windowEnd,
        input.sourceCount,
        input.destinationCount,
        input.matchedCount,
        input.missingCount,
        input.duplicateCount,
        input.lateCount,
        input.status,
        input.evidenceLevelAchieved,
        input.startedAt,
        input.completedAt ?? null,
        input.detailsLocationOrJson,
      );
    return this.getRun(tenantId, id)!;
  }

  getRun(tenantId: string, id: string): ReconciliationRunRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM reconciliation_runs WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      outcomeContractId: String(row.outcome_contract_id),
      windowStart: String(row.window_start),
      windowEnd: String(row.window_end),
      sourceCount: Number(row.source_count),
      destinationCount: Number(row.destination_count),
      matchedCount: Number(row.matched_count),
      missingCount: Number(row.missing_count),
      duplicateCount: Number(row.duplicate_count),
      lateCount: Number(row.late_count),
      status: row.status as ReconciliationRunStatus,
      evidenceLevelAchieved: row.evidence_level_achieved as "medium" | "high",
      startedAt: String(row.started_at),
      completedAt: (row.completed_at as string | null) ?? null,
      detailsLocationOrJson:
        (row.details_location_or_json as string | null) ?? null,
    };
  }

  latestRunForContract(
    tenantId: string,
    outcomeContractId: string,
  ): ReconciliationRunRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM reconciliation_runs
         WHERE tenant_id = ? AND outcome_contract_id = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(tenantId, outcomeContractId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.getRun(tenantId, String(row.id));
  }

  insertItems(
    tenantId: string,
    items: Array<
      Omit<ReconciliationItemRecord, "tenantId" | "id"> & { id?: string }
    >,
  ): void {
    const stmt = this.sqlite.prepare(
      `INSERT INTO reconciliation_items (
         id, tenant_id, reconciliation_run_id, source_identifier_hash,
         destination_identifier_hash, match_status, source_observed_at,
         destination_observed_at, metadata_json_sanitized
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.sqlite.transaction(() => {
      for (const item of items) {
        stmt.run(
          item.id ?? createId(),
          tenantId,
          item.reconciliationRunId,
          item.sourceIdentifierHash,
          item.destinationIdentifierHash,
          item.matchStatus,
          item.sourceObservedAt,
          item.destinationObservedAt,
          item.metadataJsonSanitized,
        );
      }
    });
    run();
  }

  listItems(tenantId: string, runId: string): ReconciliationItemRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM reconciliation_items
         WHERE tenant_id = ? AND reconciliation_run_id = ?
         ORDER BY match_status, source_identifier_hash`,
      )
      .all(tenantId, runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      reconciliationRunId: String(row.reconciliation_run_id),
      sourceIdentifierHash: String(row.source_identifier_hash),
      destinationIdentifierHash:
        (row.destination_identifier_hash as string | null) ?? null,
      matchStatus: row.match_status as ReconciliationMatchStatus,
      sourceObservedAt: (row.source_observed_at as string | null) ?? null,
      destinationObservedAt:
        (row.destination_observed_at as string | null) ?? null,
      metadataJsonSanitized:
        (row.metadata_json_sanitized as string | null) ?? null,
    }));
  }

  findByWindow(
    tenantId: string,
    outcomeContractId: string,
    windowStart: string,
    windowEnd: string,
  ): ReconciliationRunRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id FROM reconciliation_runs
         WHERE tenant_id = ? AND outcome_contract_id = ?
           AND window_start = ? AND window_end = ?
         LIMIT 1`,
      )
      .get(tenantId, outcomeContractId, windowStart, windowEnd) as
      | { id: string }
      | undefined;
    return row ? this.getRun(tenantId, row.id) : null;
  }

  deleteItemsForRun(tenantId: string, runId: string): void {
    this.sqlite
      .prepare(
        `DELETE FROM reconciliation_items
         WHERE tenant_id = ? AND reconciliation_run_id = ?`,
      )
      .run(tenantId, runId);
  }

  markRunning(tenantId: string, runId: string, nowIso: string): void {
    this.sqlite
      .prepare(
        `UPDATE reconciliation_runs
         SET status = 'running', completed_at = NULL, started_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(nowIso, tenantId, runId);
  }

  recordAudit(input: {
    tenantId: string;
    outcomeContractId: string;
    reconciliationRunId?: string | null;
    eventType:
      | "export"
      | "waive_missing"
      | "retention_purge"
      | "run_resumed"
      | "run_idempotent_hit";
    actor?: string | null;
    detailsJson?: string | null;
    createdAt: string;
    expiresAt?: string | null;
  }): string {
    const id = createId();
    this.sqlite
      .prepare(
        `INSERT INTO reconciliation_audit_events (
           id, tenant_id, outcome_contract_id, reconciliation_run_id,
           event_type, actor, details_json, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.outcomeContractId,
        input.reconciliationRunId ?? null,
        input.eventType,
        input.actor ?? null,
        input.detailsJson ?? null,
        input.createdAt,
        input.expiresAt ?? null,
      );
    return id;
  }

  createExportToken(input: {
    tokenHash: string;
    tenantId: string;
    outcomeContractId: string;
    reconciliationRunId: string;
    createdAt: string;
    expiresAt: string;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO reconciliation_export_tokens (
           token_hash, tenant_id, outcome_contract_id, reconciliation_run_id,
           created_at, expires_at, consumed_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.tokenHash,
        input.tenantId,
        input.outcomeContractId,
        input.reconciliationRunId,
        input.createdAt,
        input.expiresAt,
      );
  }

  consumeExportToken(
    tokenHash: string,
    nowIso: string,
  ): {
    tenantId: string;
    outcomeContractId: string;
    reconciliationRunId: string;
  } | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM reconciliation_export_tokens WHERE token_hash = ?`,
      )
      .get(tokenHash) as
      | {
          tenant_id: string;
          outcome_contract_id: string;
          reconciliation_run_id: string;
          expires_at: string;
          consumed_at: string | null;
        }
      | undefined;
    if (!row || row.consumed_at || row.expires_at < nowIso) {
      return null;
    }
    this.sqlite
      .prepare(
        `UPDATE reconciliation_export_tokens SET consumed_at = ? WHERE token_hash = ?`,
      )
      .run(nowIso, tokenHash);
    return {
      tenantId: row.tenant_id,
      outcomeContractId: row.outcome_contract_id,
      reconciliationRunId: row.reconciliation_run_id,
    };
  }

  purgeExpiredEvidence(
    tenantId: string,
    outcomeContractId: string,
    retainAfterIso: string,
    nowIso: string,
  ): number {
    const oldRuns = this.sqlite
      .prepare(
        `SELECT id FROM reconciliation_runs
         WHERE tenant_id = ? AND outcome_contract_id = ?
           AND completed_at IS NOT NULL AND completed_at < ?`,
      )
      .all(tenantId, outcomeContractId, retainAfterIso) as Array<{
      id: string;
    }>;
    for (const run of oldRuns) {
      this.deleteItemsForRun(tenantId, run.id);
      this.sqlite
        .prepare(
          `DELETE FROM reconciliation_runs WHERE tenant_id = ? AND id = ?`,
        )
        .run(tenantId, run.id);
    }
    if (oldRuns.length > 0) {
      this.recordAudit({
        tenantId,
        outcomeContractId,
        eventType: "retention_purge",
        detailsJson: JSON.stringify({ purgedRuns: oldRuns.length }),
        createdAt: nowIso,
      });
    }
    return oldRuns.length;
  }

  listMissingHashes(tenantId: string, runId: string): string[] {
    const rows = this.sqlite
      .prepare(
        `SELECT source_identifier_hash FROM reconciliation_items
         WHERE tenant_id = ? AND reconciliation_run_id = ?
           AND match_status = 'missing'
         ORDER BY source_identifier_hash`,
      )
      .all(tenantId, runId) as Array<{ source_identifier_hash: string }>;
    return rows.map((r) => r.source_identifier_hash);
  }
}
