import type Database from "better-sqlite3";
import { createId } from "../../../domain/ids.js";
import type {
  OutcomeConnectorProvider,
  OutcomeConnectorStatus,
  OutcomeConnectorType,
} from "../../../domain/outcome/types.js";
import { sanitizeRemoteErrorMessage } from "../../../domain/connectors/sanitize-remote-error.js";

export interface ConnectorRecord {
  id: string;
  tenantId: string;
  clientId: string | null;
  provider: OutcomeConnectorProvider;
  connectorType: OutcomeConnectorType;
  name: string;
  encryptedCredentials: string;
  status: OutcomeConnectorStatus;
  lastHealthCheckAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: Record<string, unknown>): ConnectorRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    clientId: (row.client_id as string | null) ?? null,
    provider: row.provider as OutcomeConnectorProvider,
    connectorType: row.connector_type as OutcomeConnectorType,
    name: String(row.name),
    encryptedCredentials: String(row.encrypted_credentials),
    status: row.status as OutcomeConnectorStatus,
    lastHealthCheckAt: (row.last_health_check_at as string | null) ?? null,
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorSummary: (row.last_error_summary as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteOutcomeConnectorRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  create(
    tenantId: string,
    input: {
      id?: string;
      clientId?: string | null;
      provider: OutcomeConnectorProvider;
      connectorType: OutcomeConnectorType;
      name: string;
      encryptedCredentials: string;
      status?: OutcomeConnectorStatus;
      nowIso: string;
    },
  ): ConnectorRecord {
    this.assertTenant(tenantId);
    const id = input.id ?? createId();
    this.sqlite
      .prepare(
        `INSERT INTO connectors (
           id, tenant_id, client_id, provider, connector_type, name,
           encrypted_credentials, status, last_health_check_at, last_success_at,
           last_error_code, last_error_summary, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        input.clientId ?? null,
        input.provider,
        input.connectorType,
        input.name,
        input.encryptedCredentials,
        input.status ?? "pending",
        input.nowIso,
        input.nowIso,
      );
    return this.get(tenantId, id)!;
  }

  get(tenantId: string, id: string): ConnectorRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM connectors WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  list(tenantId: string): ConnectorRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM connectors WHERE tenant_id = ? ORDER BY created_at ASC`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  updateStatus(
    tenantId: string,
    id: string,
    status: OutcomeConnectorStatus,
    nowIso: string,
  ): void {
    const result = this.sqlite
      .prepare(
        `UPDATE connectors SET status = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(status, nowIso, tenantId, id);
    if (result.changes === 0) {
      throw new Error("connector_not_found");
    }
  }

  recordHealth(
    tenantId: string,
    id: string,
    input: {
      ok: boolean;
      nowIso: string;
      errorCode?: string | null;
      errorSummary?: string | null;
    },
  ): void {
    if (input.ok) {
      this.sqlite
        .prepare(
          `UPDATE connectors
           SET status = 'active',
               last_health_check_at = ?,
               last_success_at = ?,
               last_error_code = NULL,
               last_error_summary = NULL,
               updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(input.nowIso, input.nowIso, input.nowIso, tenantId, id);
      return;
    }
    this.sqlite
      .prepare(
        `UPDATE connectors
         SET status = 'invalid',
             last_health_check_at = ?,
             last_error_code = ?,
             last_error_summary = ?,
             updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(
        input.nowIso,
        input.errorCode ?? "health_failed",
        input.errorSummary
          ? sanitizeRemoteErrorMessage(input.errorSummary)
          : null,
        input.nowIso,
        tenantId,
        id,
      );
  }

  revoke(tenantId: string, id: string, nowIso: string): void {
    this.updateStatus(tenantId, id, "disconnected", nowIso);
  }

  private assertTenant(tenantId: string): void {
    const row = this.sqlite
      .prepare(`SELECT id FROM tenants WHERE id = ?`)
      .get(tenantId) as { id: string } | undefined;
    if (!row) {
      throw new Error("tenant_not_found");
    }
  }
}
