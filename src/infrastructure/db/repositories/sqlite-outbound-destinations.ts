import type Database from "better-sqlite3";
import { createId } from "../../../domain/ids.js";
import { sanitizeRemoteErrorMessage } from "../../../domain/connectors/sanitize-remote-error.js";

export type OutboundKind = "n8n" | "webhook" | "smtp";

export class SqliteOutboundDestinationRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  upsertDestination(input: {
    tenantId: string;
    kind: OutboundKind;
    label: string;
    destination: string;
    nowIso: string;
  }): void {
    const existing = this.sqlite
      .prepare(
        `SELECT id FROM outbound_destinations
         WHERE tenant_id = ? AND kind = ? AND destination = ?
         LIMIT 1`,
      )
      .get(input.tenantId, input.kind, input.destination) as
      | { id: string }
      | undefined;
    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE outbound_destinations
           SET label = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.label, input.nowIso, existing.id);
      return;
    }
    this.sqlite
      .prepare(
        `INSERT INTO outbound_destinations (
           id, tenant_id, kind, label, destination, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createId(),
        input.tenantId,
        input.kind,
        input.label,
        input.destination,
        input.nowIso,
        input.nowIso,
      );
  }

  recordAttempt(input: {
    tenantId: string;
    kind: OutboundKind;
    destination: string;
    status: "success" | "failure";
    errorSummary?: string | null;
    nowIso: string;
  }): void {
    this.upsertDestination({
      tenantId: input.tenantId,
      kind: input.kind,
      label: input.kind,
      destination: input.destination,
      nowIso: input.nowIso,
    });
    this.sqlite
      .prepare(
        `UPDATE outbound_destinations
         SET last_attempt_at = ?,
             last_attempt_status = ?,
             last_error_summary = ?,
             updated_at = ?
         WHERE tenant_id = ? AND kind = ? AND destination = ?`,
      )
      .run(
        input.nowIso,
        input.status,
        input.errorSummary
          ? sanitizeRemoteErrorMessage(input.errorSummary)
          : null,
        input.nowIso,
        input.tenantId,
        input.kind,
        input.destination,
      );
  }

  list(tenantId: string): Array<{
    id: string;
    kind: OutboundKind;
    label: string;
    destination: string;
    lastAttemptAt: string | null;
    lastAttemptStatus: string | null;
    lastErrorSummary: string | null;
  }> {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM outbound_destinations WHERE tenant_id = ? ORDER BY kind, label`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      kind: row.kind as OutboundKind,
      label: String(row.label),
      destination: String(row.destination),
      lastAttemptAt: (row.last_attempt_at as string | null) ?? null,
      lastAttemptStatus: (row.last_attempt_status as string | null) ?? null,
      lastErrorSummary: (row.last_error_summary as string | null) ?? null,
    }));
  }
}
