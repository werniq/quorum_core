import type Database from "better-sqlite3";
import type {
  ConnectorAuthMode,
  ConnectorHealth,
  ConnectorHealthView,
  ConnectorStatus,
} from "../../../domain/connectors/types.js";
import { createId } from "../../../domain/ids.js";
import { validateHostedPollBaseUrl } from "../../../domain/connectors/poll-base-url.js";
import { assertPublicHttpsUrl } from "../../security/secure-outbound-http.js";

export interface N8nConnectorRecord {
  id: string;
  tenantId: string;
  name: string;
  baseUrl: string;
  encryptedApiKey: string;
  authMode: ConnectorAuthMode;
  status: ConnectorStatus;
  health: ConnectorHealth;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  pollIntervalMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface N8nPollCheckpointRecord {
  tenantId: string;
  workflowId: string;
  connectorId: string;
  lastSeenExecutionId: string | null;
  lastFinishedAt: string | null;
  updatedAt: string;
}

export interface N8nPollClaimRecord {
  tenantId: string;
  workflowId: string;
  claimOwner: string;
  claimExpiresAt: string;
  lastPollStartedAt: string | null;
  lastPollFinishedAt: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export interface PollableWorkflowRow {
  tenantId: string;
  workflowId: string;
  connectorId: string;
  pollIntervalMs: number;
  health: ConnectorHealth;
  status: ConnectorStatus;
  lastPollFinishedAt: string | null;
  consecutiveFailures: number;
}

export class SqliteN8nConnectorRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  createConnector(
    tenantId: string,
    input: {
      id?: string;
      name: string;
      baseUrl: string;
      encryptedApiKey: string;
      authMode?: ConnectorAuthMode;
      status?: ConnectorStatus;
      pollIntervalMs?: number;
      nowIso: string;
      /** Validate public HTTPS URL before insert (SSRF guard). */
      enforcePublicUrl?: boolean;
    },
  ): N8nConnectorRecord {
    let baseUrl = input.baseUrl;
    if (input.enforcePublicUrl !== false) {
      const validated = validateHostedPollBaseUrl(
        baseUrl,
        assertPublicHttpsUrl,
      );
      if (!validated.ok) {
        throw new Error(`connector_url_rejected:${validated.code}`);
      }
      baseUrl = validated.normalizedBaseUrl;
    }
    const id = input.id ?? createId();
    this.sqlite
      .prepare(
        `INSERT INTO n8n_connectors (
           id, tenant_id, name, base_url, encrypted_api_key, auth_mode, status,
           health, last_checked_at, last_success_at, last_error_code, last_error_summary,
           poll_interval_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        input.name,
        baseUrl,
        input.encryptedApiKey,
        input.authMode ?? "api_key",
        input.status ?? "active",
        input.pollIntervalMs ?? 60_000,
        input.nowIso,
        input.nowIso,
      );
    return this.getConnector(tenantId, id)!;
  }

  getConnector(
    tenantId: string,
    connectorId: string,
  ): N8nConnectorRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM n8n_connectors WHERE tenant_id = ? AND id = ? LIMIT 1`,
      )
      .get(tenantId, connectorId) as Record<string, unknown> | undefined;
    return row ? mapConnector(row) : null;
  }

  listConnectors(tenantId: string): N8nConnectorRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM n8n_connectors
         WHERE tenant_id = ?
         ORDER BY created_at ASC`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map(mapConnector);
  }

  findConnectorByNormalizedBaseUrl(
    tenantId: string,
    normalizedBaseUrl: string,
  ): N8nConnectorRecord | null {
    const normalized = normalizedBaseUrl.replace(/\/+$/, "");
    const rows = this.listConnectors(tenantId);
    return (
      rows.find(
        (row) =>
          row.status === "active" &&
          row.baseUrl.replace(/\/+$/, "") === normalized,
      ) ?? null
    );
  }

  getConnectorHealthView(
    tenantId: string,
    connectorId: string,
  ): ConnectorHealthView | null {
    const connector = this.getConnector(tenantId, connectorId);
    if (!connector) {
      return null;
    }
    return {
      health: connector.health,
      lastCheckedAt: connector.lastCheckedAt
        ? new Date(connector.lastCheckedAt)
        : null,
      lastSuccessAt: connector.lastSuccessAt
        ? new Date(connector.lastSuccessAt)
        : null,
      lastErrorCode: connector.lastErrorCode,
      lastErrorSummary: connector.lastErrorSummary,
    };
  }

  updateConnectorCredential(
    tenantId: string,
    connectorId: string,
    input: { encryptedApiKey: string; nowIso: string },
  ): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE n8n_connectors
         SET encrypted_api_key = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(input.encryptedApiKey, input.nowIso, tenantId, connectorId);
    return result.changes === 1;
  }

  disableConnector(
    tenantId: string,
    connectorId: string,
    nowIso: string,
  ): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE n8n_connectors
         SET status = 'disabled', updated_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'active'`,
      )
      .run(nowIso, tenantId, connectorId);
    return result.changes === 1;
  }

  /**
   * Permanently removes an n8n connector. Unbinds workflows and deletes
   * poll checkpoints that reference it.
   */
  deleteConnector(tenantId: string, connectorId: string): boolean {
    const existing = this.getConnector(tenantId, connectorId);
    if (!existing) {
      return false;
    }
    const run = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `DELETE FROM n8n_poll_checkpoints
           WHERE tenant_id = ? AND connector_id = ?`,
        )
        .run(tenantId, connectorId);
      this.sqlite
        .prepare(
          `UPDATE workflows
           SET connector_id = NULL, updated_at = ?
           WHERE tenant_id = ? AND connector_id = ?`,
        )
        .run(new Date().toISOString(), tenantId, connectorId);
      const result = this.sqlite
        .prepare(`DELETE FROM n8n_connectors WHERE tenant_id = ? AND id = ?`)
        .run(tenantId, connectorId);
      return result.changes === 1;
    });
    return run();
  }

  updateConnectorHealth(
    tenantId: string,
    connectorId: string,
    input: {
      health: ConnectorHealth;
      checkedAtIso: string;
      success?: boolean;
      errorCode?: string | null;
      errorSummary?: string | null;
    },
  ): void {
    this.sqlite
      .prepare(
        `UPDATE n8n_connectors
         SET health = ?,
             last_checked_at = ?,
             last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
             last_error_code = ?,
             last_error_summary = ?,
             updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(
        input.health,
        input.checkedAtIso,
        input.success ? 1 : 0,
        input.checkedAtIso,
        input.errorCode ?? null,
        input.errorSummary ?? null,
        input.checkedAtIso,
        tenantId,
        connectorId,
      );
  }

  bindWorkflowConnector(
    tenantId: string,
    workflowId: string,
    connectorId: string,
  ): void {
    const result = this.sqlite
      .prepare(
        `UPDATE workflows
         SET connector_id = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(connectorId, new Date().toISOString(), tenantId, workflowId);
    if (result.changes !== 1) {
      throw new Error("Workflow not found for connector binding");
    }
  }

  listPollableWorkflows(): PollableWorkflowRow[] {
    const rows = this.sqlite
      .prepare(
        `SELECT w.tenant_id AS tenant_id,
                w.id AS workflow_id,
                c.id AS connector_id,
                c.poll_interval_ms AS poll_interval_ms,
                c.health AS health,
                c.status AS status,
                cl.last_poll_finished_at AS last_poll_finished_at,
                COALESCE(cl.consecutive_failures, 0) AS consecutive_failures
         FROM workflows w
         INNER JOIN n8n_connectors c
           ON c.id = w.connector_id AND c.tenant_id = w.tenant_id
         LEFT JOIN n8n_poll_claims cl
           ON cl.tenant_id = w.tenant_id AND cl.workflow_id = w.id
         WHERE w.monitoring_method = 'poll'
           AND w.is_active = 1
           AND c.status = 'active'
           AND w.connector_id IS NOT NULL`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      tenantId: String(row.tenant_id),
      workflowId: String(row.workflow_id),
      connectorId: String(row.connector_id),
      pollIntervalMs: Number(row.poll_interval_ms),
      health: row.health as ConnectorHealth,
      status: row.status as ConnectorStatus,
      lastPollFinishedAt: (row.last_poll_finished_at as string | null) ?? null,
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
    }));
  }

  getPollClaim(
    tenantId: string,
    workflowId: string,
  ): N8nPollClaimRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM n8n_poll_claims
         WHERE tenant_id = ? AND workflow_id = ?
         LIMIT 1`,
      )
      .get(tenantId, workflowId) as Record<string, unknown> | undefined;
    return row ? mapClaim(row) : null;
  }

  /**
   * Atomically claim a workflow for polling when the claim is absent,
   * expired, or already owned by `owner`.
   */
  tryClaimPoll(
    tenantId: string,
    workflowId: string,
    owner: string,
    nowIso: string,
    expiresIso: string,
  ): boolean {
    const existing = this.sqlite
      .prepare(
        `SELECT claim_owner, claim_expires_at FROM n8n_poll_claims
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
        this.sqlite
          .prepare(
            `INSERT INTO n8n_poll_claims (
               tenant_id, workflow_id, claim_owner, claim_expires_at,
               last_poll_started_at, last_poll_finished_at, consecutive_failures,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`,
          )
          .run(tenantId, workflowId, owner, expiresIso, nowIso, nowIso);
        return true;
      } catch {
        return false;
      }
    }

    const result = this.sqlite
      .prepare(
        `UPDATE n8n_poll_claims
         SET claim_owner = ?,
             claim_expires_at = ?,
             last_poll_started_at = ?,
             updated_at = ?
         WHERE tenant_id = ? AND workflow_id = ?
           AND (claim_owner = ? OR claim_expires_at < ?)`,
      )
      .run(
        owner,
        expiresIso,
        nowIso,
        nowIso,
        tenantId,
        workflowId,
        owner,
        nowIso,
      );
    return result.changes === 1;
  }

  finishPollClaim(
    tenantId: string,
    workflowId: string,
    owner: string,
    input: {
      finishedAtIso: string;
      success: boolean;
    },
  ): void {
    if (input.success) {
      this.sqlite
        .prepare(
          `UPDATE n8n_poll_claims
           SET claim_expires_at = ?,
               last_poll_finished_at = ?,
               consecutive_failures = 0,
               updated_at = ?
           WHERE tenant_id = ? AND workflow_id = ? AND claim_owner = ?`,
        )
        .run(
          input.finishedAtIso,
          input.finishedAtIso,
          input.finishedAtIso,
          tenantId,
          workflowId,
          owner,
        );
      return;
    }

    this.sqlite
      .prepare(
        `UPDATE n8n_poll_claims
         SET claim_expires_at = ?,
             last_poll_finished_at = ?,
             consecutive_failures = consecutive_failures + 1,
             updated_at = ?
         WHERE tenant_id = ? AND workflow_id = ? AND claim_owner = ?`,
      )
      .run(
        input.finishedAtIso,
        input.finishedAtIso,
        input.finishedAtIso,
        tenantId,
        workflowId,
        owner,
      );
  }

  getCheckpoint(
    tenantId: string,
    workflowId: string,
  ): N8nPollCheckpointRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM n8n_poll_checkpoints
         WHERE tenant_id = ? AND workflow_id = ?
         LIMIT 1`,
      )
      .get(tenantId, workflowId) as Record<string, unknown> | undefined;
    return row ? mapCheckpoint(row) : null;
  }

  upsertCheckpoint(
    tenantId: string,
    workflowId: string,
    input: {
      connectorId: string;
      lastSeenExecutionId: string | null;
      lastFinishedAt: string | null;
      updatedAtIso: string;
    },
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO n8n_poll_checkpoints (
           tenant_id, workflow_id, connector_id, last_seen_execution_id,
           last_finished_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, workflow_id) DO UPDATE SET
           connector_id = excluded.connector_id,
           last_seen_execution_id = excluded.last_seen_execution_id,
           last_finished_at = excluded.last_finished_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        tenantId,
        workflowId,
        input.connectorId,
        input.lastSeenExecutionId,
        input.lastFinishedAt,
        input.updatedAtIso,
      );
  }
}

function mapConnector(row: Record<string, unknown>): N8nConnectorRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    encryptedApiKey: String(row.encrypted_api_key),
    authMode: row.auth_mode as ConnectorAuthMode,
    status: row.status as ConnectorStatus,
    health: row.health as ConnectorHealth,
    lastCheckedAt: (row.last_checked_at as string | null) ?? null,
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorSummary: (row.last_error_summary as string | null) ?? null,
    pollIntervalMs: Number(row.poll_interval_ms ?? 60_000),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCheckpoint(row: Record<string, unknown>): N8nPollCheckpointRecord {
  return {
    tenantId: String(row.tenant_id),
    workflowId: String(row.workflow_id),
    connectorId: String(row.connector_id),
    lastSeenExecutionId: (row.last_seen_execution_id as string | null) ?? null,
    lastFinishedAt: (row.last_finished_at as string | null) ?? null,
    updatedAt: String(row.updated_at),
  };
}

function mapClaim(row: Record<string, unknown>): N8nPollClaimRecord {
  return {
    tenantId: String(row.tenant_id),
    workflowId: String(row.workflow_id),
    claimOwner: String(row.claim_owner),
    claimExpiresAt: String(row.claim_expires_at),
    lastPollStartedAt: (row.last_poll_started_at as string | null) ?? null,
    lastPollFinishedAt: (row.last_poll_finished_at as string | null) ?? null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    updatedAt: String(row.updated_at),
  };
}
