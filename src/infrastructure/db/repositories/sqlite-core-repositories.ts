import type Database from "better-sqlite3";
import { createId } from "../../../domain/ids.js";
import {
  assertItemsProcessedValid,
  sanitizeHeartbeatMetadata,
} from "../../../domain/evidence/heartbeat-metadata.js";
import type {
  ClientRecord,
  CoreRepositories,
  HeartbeatEventRecord,
  TenantRecord,
  WorkflowContractRecord,
  WorkflowCredentialRecord,
  WorkflowRecord,
  WorkflowStateRecord,
} from "../../../application/repositories/core-repositories.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** Marker stored in workflows.description when soft-removed from the UI. */
export const WORKFLOW_REMOVED_MARKER = "__quorum_removed__";

export class SqliteCoreRepositories implements CoreRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  ensureSelfHostedTenant(name = "Self-hosted"): TenantRecord {
    const existing = this.sqlite
      .prepare(
        `SELECT id, name, edition, created_at, updated_at
         FROM tenants WHERE edition = 'self_hosted' LIMIT 1`,
      )
      .get() as
      | {
          id: string;
          name: string;
          edition: "self_hosted";
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (existing) {
      return {
        id: existing.id,
        name: existing.name,
        edition: existing.edition,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at,
      };
    }

    const id = createId();
    const ts = nowIso();
    this.sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, ?, 'self_hosted', ?, ?)`,
      )
      .run(id, name, ts, ts);

    return {
      id,
      name,
      edition: "self_hosted",
      createdAt: ts,
      updatedAt: ts,
    };
  }

  createClient(
    tenantId: string,
    input: Omit<ClientRecord, "tenantId" | "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): ClientRecord {
    this.assertTenantExists(tenantId);
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.sqlite
      .prepare(
        `INSERT INTO clients (
           id, tenant_id, name, slug, status, protection_started_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        tenantId,
        input.name,
        input.slug,
        input.status,
        input.protectionStartedAt,
        createdAt,
        updatedAt,
      );
    return { ...input, tenantId, createdAt, updatedAt };
  }

  listClients(tenantId: string): ClientRecord[] {
    const rows = this.sqlite
      .prepare(`SELECT * FROM clients WHERE tenant_id = ? ORDER BY name ASC`)
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      slug: String(row.slug),
      status: row.status as ClientRecord["status"],
      protectionStartedAt: (row.protection_started_at as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  getClient(tenantId: string, clientId: string): ClientRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM clients WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, clientId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      slug: String(row.slug),
      status: row.status as ClientRecord["status"],
      protectionStartedAt: (row.protection_started_at as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  updateClientStatus(
    tenantId: string,
    clientId: string,
    status: ClientRecord["status"],
    protectionStartedAt: string | null,
    nowIso: string,
  ): ClientRecord {
    this.sqlite
      .prepare(
        `UPDATE clients
         SET status = ?, protection_started_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(status, protectionStartedAt, nowIso, tenantId, clientId);
    const updated = this.getClient(tenantId, clientId);
    if (!updated) {
      throw new Error("client_not_found");
    }
    return updated;
  }

  removeWorkflow(
    tenantId: string,
    workflowId: string,
    nowIso: string,
  ): boolean {
    this.assertTenantExists(tenantId);
    const existing = this.getWorkflow(tenantId, workflowId);
    if (!existing) {
      return false;
    }
    if (existing.description === WORKFLOW_REMOVED_MARKER) {
      return true;
    }

    const run = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE workflow_contracts
           SET is_active = 0, updated_at = ?
           WHERE tenant_id = ? AND workflow_id = ? AND is_active = 1`,
        )
        .run(nowIso, tenantId, workflowId);

      const contractIds = this.sqlite
        .prepare(
          `SELECT id FROM workflow_contracts
           WHERE tenant_id = ? AND workflow_id = ?`,
        )
        .all(tenantId, workflowId) as Array<{ id: string }>;
      for (const row of contractIds) {
        this.sqlite
          .prepare(
            `DELETE FROM contract_alert_channels
             WHERE tenant_id = ? AND contract_kind = 'workflow' AND contract_id = ?`,
          )
          .run(tenantId, row.id);
      }

      this.sqlite
        .prepare(
          `UPDATE workflow_credentials
           SET status = 'revoked', revoked_at = ?
           WHERE tenant_id = ? AND workflow_id = ? AND status = 'active'`,
        )
        .run(nowIso, tenantId, workflowId);

      this.sqlite
        .prepare(
          `DELETE FROM n8n_poll_checkpoints
           WHERE tenant_id = ? AND workflow_id = ?`,
        )
        .run(tenantId, workflowId);
      this.sqlite
        .prepare(
          `DELETE FROM n8n_poll_claims
           WHERE tenant_id = ? AND workflow_id = ?`,
        )
        .run(tenantId, workflowId);
      this.sqlite
        .prepare(
          `DELETE FROM watcher_contract_claims
           WHERE tenant_id = ? AND workflow_id = ?`,
        )
        .run(tenantId, workflowId);

      const result = this.sqlite
        .prepare(
          `UPDATE workflows
           SET is_active = 0,
               connector_id = NULL,
               description = ?,
               updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(WORKFLOW_REMOVED_MARKER, nowIso, tenantId, workflowId);
      return result.changes === 1;
    });
    return run();
  }

  removeClient(tenantId: string, clientId: string, nowIso: string): boolean {
    this.assertTenantExists(tenantId);
    const existing = this.getClient(tenantId, clientId);
    if (!existing) {
      return false;
    }
    if (existing.status === "archived") {
      return true;
    }

    const run = this.sqlite.transaction(() => {
      const workflows = this.sqlite
        .prepare(
          `SELECT id FROM workflows
           WHERE tenant_id = ? AND client_id = ?`,
        )
        .all(tenantId, clientId) as Array<{ id: string }>;
      for (const row of workflows) {
        this.removeWorkflow(tenantId, row.id, nowIso);
      }
      this.updateClientStatus(tenantId, clientId, "archived", null, nowIso);
      return true;
    });
    return run();
  }

  createWorkflow(
    tenantId: string,
    input: Omit<
      WorkflowRecord,
      "tenantId" | "createdAt" | "updatedAt" | "sourcePlatform"
    > & {
      sourcePlatform?: "n8n";
      createdAt?: string;
      updatedAt?: string;
    },
  ): WorkflowRecord {
    this.assertTenantExists(tenantId);
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const sourcePlatform = input.sourcePlatform ?? "n8n";
    this.sqlite
      .prepare(
        `INSERT INTO workflows (
           id, tenant_id, client_id, name, source_platform, external_workflow_id,
           description, monitoring_method, is_active, monitoring_started_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        tenantId,
        input.clientId,
        input.name,
        sourcePlatform,
        input.externalWorkflowId,
        input.description,
        input.monitoringMethod,
        input.isActive ? 1 : 0,
        input.monitoringStartedAt,
        createdAt,
        updatedAt,
      );
    return {
      ...input,
      tenantId,
      sourcePlatform,
      createdAt,
      updatedAt,
    };
  }

  createWorkflowContract(
    tenantId: string,
    input: Omit<
      WorkflowContractRecord,
      "tenantId" | "createdAt" | "updatedAt" | "contractType"
    > & {
      contractType?: "heartbeat";
      createdAt?: string;
      updatedAt?: string;
    },
  ): WorkflowContractRecord {
    this.assertTenantExists(tenantId);
    this.assertWorkflowInTenant(tenantId, input.workflowId);
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const contractType = input.contractType ?? "heartbeat";
    this.sqlite
      .prepare(
        `INSERT INTO workflow_contracts (
           id, tenant_id, workflow_id, name, business_purpose, contract_type,
           cadence_type, cadence_value, interval_mode, schedule_anchor_at, timezone,
           allowed_lateness_minutes, max_quiet_window_minutes, initial_grace_minutes,
           empty_result_policy, count_less_success_allowed, notification_backoff_minutes,
           evidence_level, schema_version, is_active, activated_at, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        input.id,
        tenantId,
        input.workflowId,
        input.name,
        input.businessPurpose,
        contractType,
        input.cadenceType,
        input.cadenceValue,
        input.intervalMode,
        input.scheduleAnchorAt,
        input.timezone,
        input.allowedLatenessMinutes,
        input.maxQuietWindowMinutes,
        input.initialGraceMinutes,
        input.emptyResultPolicy,
        input.countLessSuccessAllowed ? 1 : 0,
        input.notificationBackoffMinutes,
        input.evidenceLevel,
        input.schemaVersion,
        input.isActive ? 1 : 0,
        input.activatedAt,
        createdAt,
        updatedAt,
      );
    return {
      ...input,
      tenantId,
      contractType,
      createdAt,
      updatedAt,
    };
  }

  createCredential(
    tenantId: string,
    input: Omit<WorkflowCredentialRecord, "tenantId" | "createdAt"> & {
      createdAt?: string;
    },
  ): WorkflowCredentialRecord {
    this.assertTenantExists(tenantId);
    this.assertWorkflowInTenant(tenantId, input.workflowId);
    const createdAt = input.createdAt ?? nowIso();
    this.sqlite
      .prepare(
        `INSERT INTO workflow_credentials (
           id, tenant_id, workflow_id, key_id,
           encrypted_secret_or_verification_material, status, created_at,
           rotated_from_id, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        tenantId,
        input.workflowId,
        input.keyId,
        input.encryptedSecretOrVerificationMaterial,
        input.status,
        createdAt,
        input.rotatedFromId,
        input.revokedAt,
      );
    return { ...input, tenantId, createdAt };
  }

  revokeCredential(
    tenantId: string,
    credentialId: string,
    nowIso: string,
  ): WorkflowCredentialRecord | null {
    this.assertTenantExists(tenantId);
    const result = this.sqlite
      .prepare(
        `UPDATE workflow_credentials
         SET status = 'revoked', revoked_at = ?
         WHERE tenant_id = ? AND id = ? AND status = 'active'`,
      )
      .run(nowIso, tenantId, credentialId);
    if (result.changes !== 1) {
      return null;
    }
    const row = this.sqlite
      .prepare(
        `SELECT * FROM workflow_credentials WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, credentialId) as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          tenantId: String(row.tenant_id),
          workflowId: String(row.workflow_id),
          keyId: String(row.key_id),
          encryptedSecretOrVerificationMaterial: String(
            row.encrypted_secret_or_verification_material,
          ),
          status: "revoked",
          createdAt: String(row.created_at),
          rotatedFromId: (row.rotated_from_id as string | null) ?? null,
          revokedAt: (row.revoked_at as string | null) ?? null,
        }
      : null;
  }

  rotateCredential(
    tenantId: string,
    input: {
      workflowId: string;
      previousCredentialId: string;
      newCredential: Omit<
        WorkflowCredentialRecord,
        "tenantId" | "createdAt" | "rotatedFromId" | "revokedAt" | "status"
      > & { createdAt?: string };
      nowIso: string;
    },
  ): { previous: WorkflowCredentialRecord; next: WorkflowCredentialRecord } {
    const rotated = this.sqlite.transaction(() => {
      const previous = this.revokeCredential(
        tenantId,
        input.previousCredentialId,
        input.nowIso,
      );
      if (!previous) {
        throw new Error("credential_not_active");
      }
      const next = this.createCredential(tenantId, {
        ...input.newCredential,
        status: "active",
        rotatedFromId: previous.id,
        revokedAt: null,
        createdAt: input.newCredential.createdAt ?? input.nowIso,
      });
      return { previous, next };
    });
    return rotated();
  }

  deactivateWorkflowContract(
    tenantId: string,
    contractId: string,
    nowIso: string,
  ): boolean {
    this.assertTenantExists(tenantId);
    const result = this.sqlite
      .prepare(
        `UPDATE workflow_contracts
         SET is_active = 0, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND is_active = 1`,
      )
      .run(nowIso, tenantId, contractId);
    return result.changes === 1;
  }

  updateWorkflowContractCadence(
    tenantId: string,
    contractId: string,
    input: {
      cadenceType: "interval" | "cron" | "event_driven";
      cadenceValue: string;
      nowIso: string;
    },
  ): boolean {
    this.assertTenantExists(tenantId);
    const result = this.sqlite
      .prepare(
        `UPDATE workflow_contracts
         SET cadence_type = ?, cadence_value = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(
        input.cadenceType,
        input.cadenceValue,
        input.nowIso,
        tenantId,
        contractId,
      );
    return result.changes === 1;
  }

  insertHeartbeatEvent(
    tenantId: string,
    input: Omit<
      HeartbeatEventRecord,
      "tenantId" | "createdAt" | "metadataJson"
    > & {
      metadata?: unknown;
      createdAt?: string;
    },
  ): HeartbeatEventRecord {
    this.assertTenantExists(tenantId);
    this.assertWorkflowInTenant(tenantId, input.workflowId);

    if (!assertItemsProcessedValid(input.itemsProcessed)) {
      throw new Error("items_processed must be null or >= 0");
    }

    const sanitized = sanitizeHeartbeatMetadata(input.metadata);
    if (!sanitized.ok) {
      throw new Error(sanitized.issues.join("; "));
    }

    const createdAt = input.createdAt ?? nowIso();
    this.sqlite
      .prepare(
        `INSERT INTO heartbeat_events (
           id, tenant_id, workflow_id, received_at, executed_at, status,
           items_processed, external_execution_ref, idempotency_key,
           payload_schema_version, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        tenantId,
        input.workflowId,
        input.receivedAt,
        input.executedAt,
        input.status,
        input.itemsProcessed,
        input.externalExecutionRef,
        input.idempotencyKey,
        input.payloadSchemaVersion,
        sanitized.metadataJson,
        createdAt,
      );

    return {
      id: input.id,
      tenantId,
      workflowId: input.workflowId,
      receivedAt: input.receivedAt,
      executedAt: input.executedAt,
      status: input.status,
      itemsProcessed: input.itemsProcessed,
      externalExecutionRef: input.externalExecutionRef,
      idempotencyKey: input.idempotencyKey,
      payloadSchemaVersion: input.payloadSchemaVersion,
      metadataJson: sanitized.metadataJson,
      createdAt,
    };
  }

  upsertWorkflowState(
    tenantId: string,
    state: WorkflowStateRecord,
  ): WorkflowStateRecord {
    if (state.tenantId !== tenantId) {
      throw new Error("workflow state tenant_id mismatch");
    }
    this.assertTenantExists(tenantId);
    this.assertWorkflowInTenant(tenantId, state.workflowId);

    this.sqlite
      .prepare(
        `INSERT INTO workflow_states (
           tenant_id, workflow_id, last_execution_at, last_nonempty_success_at,
           last_acceptable_success_at, last_failure_at, last_external_execution_ref,
           last_status, next_expected_at, overdue_since, current_health, evidence_level,
           evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, workflow_id) DO UPDATE SET
           last_execution_at = excluded.last_execution_at,
           last_nonempty_success_at = excluded.last_nonempty_success_at,
           last_acceptable_success_at = excluded.last_acceptable_success_at,
           last_failure_at = excluded.last_failure_at,
           last_external_execution_ref = excluded.last_external_execution_ref,
           last_status = excluded.last_status,
           next_expected_at = excluded.next_expected_at,
           overdue_since = excluded.overdue_since,
           current_health = excluded.current_health,
           evidence_level = excluded.evidence_level,
           evidence_summary_code = excluded.evidence_summary_code,
           unverified_dimensions_json = excluded.unverified_dimensions_json,
           consecutive_stale_checks = excluded.consecutive_stale_checks,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.tenantId,
        state.workflowId,
        state.lastExecutionAt,
        state.lastNonemptySuccessAt,
        state.lastAcceptableSuccessAt,
        state.lastFailureAt,
        state.lastExternalExecutionRef,
        state.lastStatus,
        state.nextExpectedAt,
        state.overdueSince,
        state.currentHealth,
        state.evidenceLevel,
        state.evidenceSummaryCode,
        state.unverifiedDimensionsJson,
        state.consecutiveStaleChecks,
        state.updatedAt,
      );
    return state;
  }

  getWorkflow(tenantId: string, workflowId: string): WorkflowRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM workflows WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, workflowId) as Record<string, unknown> | undefined;
    return row ? mapWorkflow(row) : null;
  }

  findWorkflowByExternalId(
    tenantId: string,
    externalWorkflowId: string,
    sourcePlatform: string = "n8n",
  ): WorkflowRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM workflows
         WHERE tenant_id = ? AND source_platform = ? AND external_workflow_id = ?
         LIMIT 1`,
      )
      .get(tenantId, sourcePlatform, externalWorkflowId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapWorkflow(row) : null;
  }

  listWorkflows(tenantId: string): WorkflowRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM workflows WHERE tenant_id = ? ORDER BY created_at ASC`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map(mapWorkflow);
  }

  getHeartbeatByIdempotencyKey(
    tenantId: string,
    workflowId: string,
    idempotencyKey: string,
  ): HeartbeatEventRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM heartbeat_events
         WHERE tenant_id = ? AND workflow_id = ? AND idempotency_key = ?`,
      )
      .get(tenantId, workflowId, idempotencyKey) as
      | Record<string, unknown>
      | undefined;
    return row ? mapHeartbeat(row) : null;
  }

  getWorkflowState(
    tenantId: string,
    workflowId: string,
  ): WorkflowStateRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM workflow_states WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .get(tenantId, workflowId) as Record<string, unknown> | undefined;
    return row ? mapWorkflowState(row) : null;
  }

  private assertTenantExists(tenantId: string): void {
    const row = this.sqlite
      .prepare(`SELECT id FROM tenants WHERE id = ?`)
      .get(tenantId);
    if (!row) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
  }

  private assertWorkflowInTenant(tenantId: string, workflowId: string): void {
    const row = this.sqlite
      .prepare(`SELECT id FROM workflows WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, workflowId);
    if (!row) {
      throw new Error(
        `Workflow ${workflowId} is not visible in tenant ${tenantId}`,
      );
    }
  }
}

function mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    clientId: (row.client_id as string | null) ?? null,
    name: String(row.name),
    sourcePlatform: "n8n",
    externalWorkflowId: String(row.external_workflow_id),
    description: (row.description as string | null) ?? null,
    monitoringMethod:
      row.monitoring_method as WorkflowRecord["monitoringMethod"],
    isActive: Boolean(row.is_active),
    monitoringStartedAt: (row.monitoring_started_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapHeartbeat(row: Record<string, unknown>): HeartbeatEventRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    workflowId: String(row.workflow_id),
    receivedAt: String(row.received_at),
    executedAt: String(row.executed_at),
    status: row.status as HeartbeatEventRecord["status"],
    itemsProcessed: (row.items_processed as number | null) ?? null,
    externalExecutionRef: (row.external_execution_ref as string | null) ?? null,
    idempotencyKey: String(row.idempotency_key),
    payloadSchemaVersion: Number(row.payload_schema_version),
    metadataJson: (row.metadata_json as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

function mapWorkflowState(row: Record<string, unknown>): WorkflowStateRecord {
  return {
    tenantId: String(row.tenant_id),
    workflowId: String(row.workflow_id),
    lastExecutionAt: (row.last_execution_at as string | null) ?? null,
    lastNonemptySuccessAt:
      (row.last_nonempty_success_at as string | null) ?? null,
    lastAcceptableSuccessAt:
      (row.last_acceptable_success_at as string | null) ?? null,
    lastFailureAt: (row.last_failure_at as string | null) ?? null,
    lastExternalExecutionRef:
      (row.last_external_execution_ref as string | null) ?? null,
    lastStatus: row.last_status as WorkflowStateRecord["lastStatus"],
    nextExpectedAt: (row.next_expected_at as string | null) ?? null,
    overdueSince: (row.overdue_since as string | null) ?? null,
    currentHealth: row.current_health as WorkflowStateRecord["currentHealth"],
    evidenceLevel: row.evidence_level as WorkflowStateRecord["evidenceLevel"],
    evidenceSummaryCode: (row.evidence_summary_code as string | null) ?? null,
    unverifiedDimensionsJson:
      (row.unverified_dimensions_json as string | null) ?? null,
    consecutiveStaleChecks: Number(row.consecutive_stale_checks),
    updatedAt: String(row.updated_at),
  };
}
