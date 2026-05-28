import type Database from "better-sqlite3";
import { createId } from "../../../domain/ids.js";

const SENSITIVE_KEY =
  /^(password|passwd|secret|token|api[_-]?key|authorization|cookie|encrypted|credential|hmac|private[_-]?key|setup[_-]?token)$/i;

export type OpsAuditEventRecord = {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  detailsJson: string | null;
  createdAt: string;
};

/** Strip secret-bearing fields from audit detail payloads. */
export function sanitizeOpsAuditDetails(details: unknown): unknown {
  if (details == null) {
    return null;
  }
  if (Array.isArray(details)) {
    return details.map((item) => sanitizeOpsAuditDetails(item));
  }
  if (typeof details !== "object") {
    return details;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    details as Record<string, unknown>,
  )) {
    if (SENSITIVE_KEY.test(key)) {
      continue;
    }
    out[key] = sanitizeOpsAuditDetails(value);
  }
  return out;
}

export class SqliteOpsAuditRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  recordOpsAudit(input: {
    tenantId: string;
    actorUserId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    details?: unknown;
    nowIso: string;
  }): OpsAuditEventRecord {
    const id = createId();
    const sanitized =
      input.details === undefined
        ? null
        : sanitizeOpsAuditDetails(input.details);
    const detailsJson = sanitized == null ? null : JSON.stringify(sanitized);
    this.sqlite
      .prepare(
        `INSERT INTO ops_audit_events (
           id, tenant_id, actor_user_id, action, resource_type, resource_id, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.actorUserId ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        detailsJson,
        input.nowIso,
      );
    return {
      id,
      tenantId: input.tenantId,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      detailsJson,
      createdAt: input.nowIso,
    };
  }

  listForTenant(
    tenantId: string,
    options?: { action?: string; limit?: number },
  ): OpsAuditEventRecord[] {
    const limit = options?.limit ?? 100;
    const rows = (
      options?.action
        ? this.sqlite
            .prepare(
              `SELECT * FROM ops_audit_events
               WHERE tenant_id = ? AND action = ?
               ORDER BY created_at DESC
               LIMIT ?`,
            )
            .all(tenantId, options.action, limit)
        : this.sqlite
            .prepare(
              `SELECT * FROM ops_audit_events
               WHERE tenant_id = ?
               ORDER BY created_at DESC
               LIMIT ?`,
            )
            .all(tenantId, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }
}

function mapRow(row: Record<string, unknown>): OpsAuditEventRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorUserId: (row.actor_user_id as string | null) ?? null,
    action: String(row.action),
    resourceType: (row.resource_type as string | null) ?? null,
    resourceId: (row.resource_id as string | null) ?? null,
    detailsJson: (row.details_json as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}
