import type Database from "better-sqlite3";
import { nextAlertChannelHealth } from "../../../domain/alerting/alert-channel-health.js";
import { sanitizeDeliveryErrorMessage } from "../../../domain/alerting/sanitize-delivery-error.js";
import { transitionIncidentStatus } from "../../../domain/incidents/lifecycle.js";
import { createId } from "../../../domain/ids.js";
import type {
  AlertChannelRecord,
  AlertChannelStateRecord,
  AlertingRepositories,
  ContractAlertChannelRecord,
  IncidentRecord,
  IncidentType,
  ListIncidentsQuery,
  ListIncidentsResult,
  NotificationAttemptRecord,
  NotificationOutboxRecord,
  OpenIncidentInput,
} from "../../../application/repositories/alerting-repositories.js";
import type { ContractKind } from "../../../domain/terminology.js";

function nowIso(): string {
  return new Date().toISOString();
}

function contractIdFromIncident(input: {
  contractKind: ContractKind;
  workflowId: string | null;
  outcomeContractId: string | null;
}): string {
  if (input.contractKind === "workflow") {
    if (!input.workflowId) {
      throw new Error("workflow incidents require workflow_id");
    }
    return input.workflowId;
  }
  if (input.contractKind === "outcome") {
    if (!input.outcomeContractId) {
      throw new Error("outcome incidents require outcome_contract_id");
    }
    return input.outcomeContractId;
  }
  return "";
}

export class SqliteAlertingRepositories implements AlertingRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  openOrObserveIncident(
    tenantId: string,
    input: OpenIncidentInput,
  ): IncidentRecord {
    this.assertTenantExists(tenantId);
    const observedAt = input.observedAt ?? nowIso();
    const workflowId = input.workflowId ?? null;
    const outcomeContractId = input.outcomeContractId ?? null;
    const clientId = input.clientId ?? null;
    const detailsJson = input.detailsJson ?? null;

    const existing =
      input.volumeRuleId && input.volumeWindowStart && input.workflowId
        ? this.getUnresolvedVolumeIncident(
            tenantId,
            input.workflowId,
            input.volumeRuleId,
            input.volumeWindowStart,
            input.incidentType as
              | "volume_below_minimum"
              | "volume_above_maximum",
          )
        : this.getUnresolvedIncident(
            tenantId,
            input.contractKind,
            contractIdFromIncident({
              contractKind: input.contractKind,
              workflowId,
              outcomeContractId,
            }),
            input.incidentType,
          );

    if (existing) {
      this.sqlite
        .prepare(
          `UPDATE incidents
           SET last_observed_at = ?, details_json = COALESCE(?, details_json), updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(observedAt, detailsJson, observedAt, tenantId, existing.id);
      return {
        ...existing,
        lastObservedAt: observedAt,
        detailsJson: detailsJson ?? existing.detailsJson,
        updatedAt: observedAt,
      };
    }

    const createdAt = observedAt;
    this.sqlite
      .prepare(
        `INSERT INTO incidents (
           id, tenant_id, client_id, contract_kind, workflow_id, outcome_contract_id,
           incident_type, severity, status, opened_at, acknowledged_at, resolved_at,
           last_observed_at, last_notified_at, notification_count, summary, details_json,
           volume_rule_id, volume_window_start, assignee_user_id, resolution_note,
           client_safe_resolution_note, response_target_minutes, resolution_target_minutes,
           created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, ?, NULL, 0, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?
         )`,
      )
      .run(
        input.id,
        tenantId,
        clientId,
        input.contractKind,
        workflowId,
        outcomeContractId,
        input.incidentType,
        input.severity,
        createdAt,
        observedAt,
        input.summary,
        detailsJson,
        input.volumeRuleId ?? null,
        input.volumeWindowStart ?? null,
        input.responseTargetMinutes ?? null,
        input.resolutionTargetMinutes ?? null,
        createdAt,
        createdAt,
      );

    return {
      id: input.id,
      tenantId,
      clientId,
      contractKind: input.contractKind,
      workflowId,
      outcomeContractId,
      incidentType: input.incidentType,
      severity: input.severity,
      status: "open",
      openedAt: createdAt,
      acknowledgedAt: null,
      resolvedAt: null,
      lastObservedAt: observedAt,
      lastNotifiedAt: null,
      notificationCount: 0,
      summary: input.summary,
      detailsJson,
      volumeRuleId: input.volumeRuleId ?? null,
      volumeWindowStart: input.volumeWindowStart ?? null,
      assigneeUserId: null,
      resolutionNote: null,
      clientSafeResolutionNote: null,
      responseTargetMinutes: input.responseTargetMinutes ?? null,
      resolutionTargetMinutes: input.resolutionTargetMinutes ?? null,
      createdAt,
      updatedAt: createdAt,
    };
  }

  getUnresolvedVolumeIncident(
    tenantId: string,
    workflowId: string,
    volumeRuleId: string,
    volumeWindowStart: string,
    incidentType: "volume_below_minimum" | "volume_above_maximum",
  ): IncidentRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM incidents
         WHERE tenant_id = ? AND workflow_id = ? AND volume_rule_id = ?
           AND volume_window_start = ? AND incident_type = ?
           AND status IN ('open', 'acknowledged')`,
      )
      .get(
        tenantId,
        workflowId,
        volumeRuleId,
        volumeWindowStart,
        incidentType,
      ) as Record<string, unknown> | undefined;
    return row ? mapIncident(row) : null;
  }

  assignIncident(
    tenantId: string,
    incidentId: string,
    input: {
      assigneeUserId: string | null;
      actor?: string | null;
      edition?: "self_hosted" | "saas";
    },
  ): IncidentRecord {
    this.requireIncident(tenantId, incidentId);
    const at = nowIso();
    this.sqlite
      .prepare(
        `UPDATE incidents SET assignee_user_id = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(input.assigneeUserId, at, tenantId, incidentId);
    this.recordAudit(
      tenantId,
      incidentId,
      "assigned",
      input.actor ?? null,
      input.edition ?? "self_hosted",
      at,
      JSON.stringify({ assigneeUserId: input.assigneeUserId }),
    );
    return this.requireIncident(tenantId, incidentId);
  }

  updateIncidentTriage(
    tenantId: string,
    incidentId: string,
    input: {
      severity?: IncidentRecord["severity"];
      resolutionNote?: string | null;
      clientSafeResolutionNote?: string | null;
      actor?: string | null;
      edition?: "self_hosted" | "saas";
    },
  ): IncidentRecord {
    this.requireIncident(tenantId, incidentId);
    const at = nowIso();
    if (input.severity) {
      this.sqlite
        .prepare(
          `UPDATE incidents SET severity = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
        )
        .run(input.severity, at, tenantId, incidentId);
      this.recordAudit(
        tenantId,
        incidentId,
        "severity_changed",
        input.actor ?? null,
        input.edition ?? "self_hosted",
        at,
        JSON.stringify({ severity: input.severity }),
      );
    }
    if (
      input.resolutionNote !== undefined ||
      input.clientSafeResolutionNote !== undefined
    ) {
      this.sqlite
        .prepare(
          `UPDATE incidents SET
             resolution_note = COALESCE(?, resolution_note),
             client_safe_resolution_note = COALESCE(?, client_safe_resolution_note),
             updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(
          input.resolutionNote ?? null,
          input.clientSafeResolutionNote ?? null,
          at,
          tenantId,
          incidentId,
        );
      this.recordAudit(
        tenantId,
        incidentId,
        "resolution_note_updated",
        input.actor ?? null,
        input.edition ?? "self_hosted",
        at,
        null,
      );
    }
    return this.requireIncident(tenantId, incidentId);
  }

  getUnresolvedIncident(
    tenantId: string,
    contractKind: ContractKind,
    contractId: string,
    incidentType: IncidentType,
  ): IncidentRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM incidents
         WHERE tenant_id = ?
           AND contract_kind = ?
           AND incident_type = ?
           AND status IN ('open', 'acknowledged')
           AND COALESCE(workflow_id, outcome_contract_id, '') = ?
         LIMIT 1`,
      )
      .get(tenantId, contractKind, incidentType, contractId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapIncident(row) : null;
  }

  listIncidents(tenantId: string): IncidentRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM incidents WHERE tenant_id = ? ORDER BY opened_at ASC`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map(mapIncident);
  }

  queryIncidents(
    tenantId: string,
    query: ListIncidentsQuery,
  ): ListIncidentsResult {
    this.assertTenantExists(tenantId);
    const limit = query.limit;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("list incidents limit must be a positive integer");
    }

    const where: string[] = ["tenant_id = ?"];
    const params: unknown[] = [tenantId];

    if (query.statuses && query.statuses.length > 0) {
      where.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      params.push(...query.statuses);
    }
    if (query.severity) {
      where.push("severity = ?");
      params.push(query.severity);
    }
    if (query.workflowId) {
      where.push("workflow_id = ?");
      params.push(query.workflowId);
    }
    if (query.contractId) {
      where.push("(workflow_id = ? OR outcome_contract_id = ?)");
      params.push(query.contractId, query.contractId);
    }
    if (query.clientId) {
      where.push("client_id = ?");
      params.push(query.clientId);
    }
    if (query.updatedAfter) {
      where.push("updated_at > ?");
      params.push(query.updatedAfter);
    }
    if (query.cursor) {
      where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      params.push(
        query.cursor.updatedAt,
        query.cursor.updatedAt,
        query.cursor.id,
      );
    }

    const rows = this.sqlite
      .prepare(
        `SELECT * FROM incidents
         WHERE ${where.join(" AND ")}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1) as Array<Record<string, unknown>>;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(mapIncident);
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;
    return { items, nextCursor };
  }

  createAlertChannel(
    tenantId: string,
    input: Omit<AlertChannelRecord, "tenantId" | "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): AlertChannelRecord {
    this.assertTenantExists(tenantId);
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.sqlite
      .prepare(
        `INSERT INTO alert_channels (
           id, tenant_id, name, type, encrypted_config, is_active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        tenantId,
        input.name,
        input.type,
        input.encryptedConfig,
        input.isActive ? 1 : 0,
        createdAt,
        updatedAt,
      );

    this.sqlite
      .prepare(
        `INSERT INTO alert_channel_states (
           tenant_id, alert_channel_id, current_health, consecutive_failures, updated_at
         ) VALUES (?, ?, 'unknown', 0, ?)`,
      )
      .run(tenantId, input.id, createdAt);

    return { ...input, tenantId, createdAt, updatedAt };
  }

  routeContractToChannel(
    tenantId: string,
    input: Omit<ContractAlertChannelRecord, "tenantId" | "createdAt"> & {
      createdAt?: string;
    },
  ): ContractAlertChannelRecord {
    this.assertTenantExists(tenantId);
    this.assertChannelInTenant(tenantId, input.alertChannelId);
    const createdAt = input.createdAt ?? nowIso();
    this.sqlite
      .prepare(
        `INSERT INTO contract_alert_channels (
           tenant_id, contract_kind, contract_id, alert_channel_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        input.contractKind,
        input.contractId,
        input.alertChannelId,
        createdAt,
      );
    return { ...input, tenantId, createdAt };
  }

  listRoutesForContract(
    tenantId: string,
    contractKind: ContractKind,
    contractId: string,
  ): ContractAlertChannelRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM contract_alert_channels
         WHERE tenant_id = ? AND contract_kind = ? AND contract_id = ?`,
      )
      .all(tenantId, contractKind, contractId) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      tenantId: String(row.tenant_id),
      contractKind: row.contract_kind as ContractKind,
      contractId: String(row.contract_id),
      alertChannelId: String(row.alert_channel_id),
      createdAt: String(row.created_at),
    }));
  }

  applyChannelDeliveryResult(
    tenantId: string,
    alertChannelId: string,
    event:
      | {
          type: "delivery_failed";
          retriesRemaining: boolean;
          errorCode?: string;
          errorMessage?: string;
        }
      | { type: "delivery_succeeded" }
      | { type: "test_succeeded" },
    at = nowIso(),
  ): AlertChannelStateRecord {
    this.assertChannelInTenant(tenantId, alertChannelId);
    const current =
      this.getAlertChannelState(tenantId, alertChannelId) ??
      ({
        tenantId,
        alertChannelId,
        currentHealth: "unknown",
        lastTestedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorMessageSanitized: null,
        updatedAt: at,
      } satisfies AlertChannelStateRecord);

    const health = nextAlertChannelHealth(current.currentHealth, event);
    const failed = event.type === "delivery_failed";
    const next: AlertChannelStateRecord = {
      ...current,
      currentHealth: health,
      lastTestedAt:
        event.type === "test_succeeded" ||
        failed ||
        event.type === "delivery_succeeded"
          ? at
          : current.lastTestedAt,
      lastSuccessAt:
        event.type === "delivery_succeeded" || event.type === "test_succeeded"
          ? at
          : current.lastSuccessAt,
      lastFailureAt: failed ? at : current.lastFailureAt,
      consecutiveFailures: failed ? current.consecutiveFailures + 1 : 0,
      lastErrorCode: failed ? (event.errorCode ?? null) : null,
      lastErrorMessageSanitized: failed
        ? sanitizeDeliveryErrorMessage(event.errorMessage)
        : null,
      updatedAt: at,
    };

    this.sqlite
      .prepare(
        `INSERT INTO alert_channel_states (
           tenant_id, alert_channel_id, current_health, last_tested_at, last_success_at,
           last_failure_at, consecutive_failures, last_error_code,
           last_error_message_sanitized, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, alert_channel_id) DO UPDATE SET
           current_health = excluded.current_health,
           last_tested_at = excluded.last_tested_at,
           last_success_at = excluded.last_success_at,
           last_failure_at = excluded.last_failure_at,
           consecutive_failures = excluded.consecutive_failures,
           last_error_code = excluded.last_error_code,
           last_error_message_sanitized = excluded.last_error_message_sanitized,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.tenantId,
        next.alertChannelId,
        next.currentHealth,
        next.lastTestedAt,
        next.lastSuccessAt,
        next.lastFailureAt,
        next.consecutiveFailures,
        next.lastErrorCode,
        next.lastErrorMessageSanitized,
        next.updatedAt,
      );
    return next;
  }

  getAlertChannelState(
    tenantId: string,
    alertChannelId: string,
  ): AlertChannelStateRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM alert_channel_states
         WHERE tenant_id = ? AND alert_channel_id = ?`,
      )
      .get(tenantId, alertChannelId) as Record<string, unknown> | undefined;
    return row ? mapChannelState(row) : null;
  }

  enqueueOutbox(
    tenantId: string,
    input: Omit<
      NotificationOutboxRecord,
      | "tenantId"
      | "createdAt"
      | "claimedAt"
      | "claimExpiresAt"
      | "processedAt"
      | "attemptCount"
      | "lastError"
    > & {
      attemptCount?: number;
      lastError?: string | null;
      createdAt?: string;
    },
  ): NotificationOutboxRecord {
    this.assertTenantExists(tenantId);
    if (input.incidentId) {
      this.requireIncident(tenantId, input.incidentId);
    }
    const createdAt = input.createdAt ?? nowIso();
    const record: NotificationOutboxRecord = {
      id: input.id,
      tenantId,
      incidentId: input.incidentId,
      eventType: input.eventType,
      payloadJson: input.payloadJson,
      availableAt: input.availableAt,
      claimedAt: null,
      claimExpiresAt: null,
      processedAt: null,
      attemptCount: input.attemptCount ?? 0,
      lastError: input.lastError ?? null,
      createdAt,
    };
    this.sqlite
      .prepare(
        `INSERT INTO notification_outbox (
           id, tenant_id, incident_id, event_type, payload_json, available_at,
           claimed_at, claim_expires_at, processed_at, attempt_count, last_error, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.tenantId,
        record.incidentId,
        record.eventType,
        record.payloadJson,
        record.availableAt,
        record.attemptCount,
        record.lastError,
        record.createdAt,
      );
    return record;
  }

  recordNotificationAttempt(
    tenantId: string,
    input: Omit<NotificationAttemptRecord, "tenantId">,
  ): NotificationAttemptRecord {
    this.assertTenantExists(tenantId);
    this.assertChannelInTenant(tenantId, input.alertChannelId);
    if (input.incidentId) {
      this.requireIncident(tenantId, input.incidentId);
    }
    const sanitized = sanitizeDeliveryErrorMessage(input.errorMessageSanitized);
    this.sqlite
      .prepare(
        `INSERT INTO notification_attempts (
           id, tenant_id, incident_id, alert_channel_id, outbox_id, status,
           attempted_at, delivered_at, external_message_id, external_thread_id,
           response_status_code, error_code, error_message_sanitized
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        tenantId,
        input.incidentId,
        input.alertChannelId,
        input.outboxId,
        input.status,
        input.attemptedAt,
        input.deliveredAt,
        input.externalMessageId,
        input.externalThreadId,
        input.responseStatusCode,
        input.errorCode,
        sanitized,
      );
    return { ...input, tenantId, errorMessageSanitized: sanitized };
  }

  listNotificationAttempts(
    tenantId: string,
    outboxId: string,
  ): NotificationAttemptRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM notification_attempts
         WHERE tenant_id = ? AND outbox_id = ?
         ORDER BY attempted_at ASC`,
      )
      .all(tenantId, outboxId) as Array<Record<string, unknown>>;
    return rows.map(mapAttempt);
  }

  listNotificationAttemptsForChannel(
    tenantId: string,
    alertChannelId: string,
    limit = 50,
  ): NotificationAttemptRecord[] {
    this.assertChannelInTenant(tenantId, alertChannelId);
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM notification_attempts
         WHERE tenant_id = ? AND alert_channel_id = ?
         ORDER BY attempted_at DESC
         LIMIT ?`,
      )
      .all(tenantId, alertChannelId, limit) as Array<Record<string, unknown>>;
    return rows.map(mapAttempt);
  }

  getIncident(tenantId: string, incidentId: string): IncidentRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM incidents WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, incidentId) as Record<string, unknown> | undefined;
    return row ? mapIncident(row) : null;
  }

  acknowledgeIncident(
    tenantId: string,
    incidentId: string,
    input?: {
      actor?: string | null;
      at?: string;
      edition?: "self_hosted" | "saas";
    },
  ): IncidentRecord {
    const current = this.requireIncident(tenantId, incidentId);
    const next = transitionIncidentStatus(current.status, "acknowledged");
    const at = input?.at ?? nowIso();
    this.sqlite
      .prepare(
        `UPDATE incidents
         SET status = ?, acknowledged_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(next, at, at, tenantId, incidentId);
    this.recordAudit(
      tenantId,
      incidentId,
      "acknowledged",
      input?.actor ?? null,
      input?.edition ?? "self_hosted",
      at,
    );
    return this.requireIncident(tenantId, incidentId);
  }

  resolveIncident(
    tenantId: string,
    incidentId: string,
    input?: {
      actor?: string | null;
      at?: string;
      edition?: "self_hosted" | "saas";
      resolutionNote?: string | null;
      clientSafeResolutionNote?: string | null;
    },
  ): IncidentRecord {
    const current = this.requireIncident(tenantId, incidentId);
    const next = transitionIncidentStatus(current.status, "resolved");
    const at = input?.at ?? nowIso();
    this.sqlite
      .prepare(
        `UPDATE incidents
         SET status = ?, resolved_at = ?, updated_at = ?,
             resolution_note = COALESCE(?, resolution_note),
             client_safe_resolution_note = COALESCE(?, client_safe_resolution_note)
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(
        next,
        at,
        at,
        input?.resolutionNote ?? null,
        input?.clientSafeResolutionNote ?? null,
        tenantId,
        incidentId,
      );
    this.recordAudit(
      tenantId,
      incidentId,
      "resolved",
      input?.actor ?? null,
      input?.edition ?? "self_hosted",
      at,
    );
    return this.requireIncident(tenantId, incidentId);
  }

  markIncidentNotified(tenantId: string, incidentId: string, at: string): void {
    this.sqlite
      .prepare(
        `UPDATE incidents
         SET last_notified_at = ?,
             notification_count = notification_count + 1,
             updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(at, at, tenantId, incidentId);
  }

  claimOutboxBatch(
    tenantId: string | null,
    input: {
      nowIso: string;
      claimOwner: string;
      claimExpiresAtIso: string;
      limit: number;
    },
  ): NotificationOutboxRecord[] {
    const rows = (
      tenantId
        ? this.sqlite
            .prepare(
              `SELECT * FROM notification_outbox
               WHERE tenant_id = ?
                 AND processed_at IS NULL
                 AND available_at <= ?
                 AND (claim_expires_at IS NULL OR claim_expires_at < ?)
               ORDER BY available_at ASC
               LIMIT ?`,
            )
            .all(tenantId, input.nowIso, input.nowIso, input.limit)
        : this.sqlite
            .prepare(
              `SELECT * FROM notification_outbox
               WHERE processed_at IS NULL
                 AND available_at <= ?
                 AND (claim_expires_at IS NULL OR claim_expires_at < ?)
               ORDER BY available_at ASC
               LIMIT ?`,
            )
            .all(input.nowIso, input.nowIso, input.limit)
    ) as Array<Record<string, unknown>>;

    const claimed: NotificationOutboxRecord[] = [];
    for (const row of rows) {
      const result = this.sqlite
        .prepare(
          `UPDATE notification_outbox
           SET claimed_at = ?, claim_expires_at = ?
           WHERE id = ? AND tenant_id = ?
             AND processed_at IS NULL
             AND (claim_expires_at IS NULL OR claim_expires_at < ?)`,
        )
        .run(
          input.nowIso,
          input.claimExpiresAtIso,
          String(row.id),
          String(row.tenant_id),
          input.nowIso,
        );
      if (result.changes === 1) {
        claimed.push(
          mapOutbox({
            ...row,
            claimed_at: input.nowIso,
            claim_expires_at: input.claimExpiresAtIso,
          }),
        );
      }
    }
    return claimed;
  }

  markOutboxProcessed(tenantId: string, outboxId: string, at: string): void {
    this.sqlite
      .prepare(
        `UPDATE notification_outbox
         SET processed_at = ?, claimed_at = NULL, claim_expires_at = NULL
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(at, tenantId, outboxId);
  }

  scheduleOutboxRetry(
    tenantId: string,
    outboxId: string,
    input: {
      availableAtIso: string;
      attemptCount: number;
      lastError: string | null;
    },
  ): void {
    this.sqlite
      .prepare(
        `UPDATE notification_outbox
         SET available_at = ?,
             attempt_count = ?,
             last_error = ?,
             claimed_at = NULL,
             claim_expires_at = NULL
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(
        input.availableAtIso,
        input.attemptCount,
        input.lastError,
        tenantId,
        outboxId,
      );
  }

  disableAlertChannel(
    tenantId: string,
    alertChannelId: string,
    nowIso: string,
  ): boolean {
    this.assertTenantExists(tenantId);
    const result = this.sqlite
      .prepare(
        `UPDATE alert_channels
         SET is_active = 0, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND is_active = 1`,
      )
      .run(nowIso, tenantId, alertChannelId);
    return result.changes === 1;
  }

  getAlertChannel(
    tenantId: string,
    alertChannelId: string,
  ): AlertChannelRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM alert_channels WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, alertChannelId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      type: row.type as AlertChannelRecord["type"],
      encryptedConfig: String(row.encrypted_config),
      isActive: Boolean(row.is_active),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listAuditEvents(
    tenantId: string,
    incidentId: string,
  ): Array<{
    id: string;
    eventType: "acknowledged" | "resolved";
    actor: string | null;
    edition: string;
    createdAt: string;
  }> {
    const rows = this.sqlite
      .prepare(
        `SELECT id, event_type, actor, edition, created_at
         FROM incident_audit_events
         WHERE tenant_id = ? AND incident_id = ?
         ORDER BY created_at ASC`,
      )
      .all(tenantId, incidentId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      eventType: row.event_type as "acknowledged" | "resolved",
      actor: (row.actor as string | null) ?? null,
      edition: String(row.edition),
      createdAt: String(row.created_at),
    }));
  }

  findLatestExternalThreadId(
    tenantId: string,
    incidentId: string,
    alertChannelId: string,
  ): string | null {
    const row = this.sqlite
      .prepare(
        `SELECT external_thread_id FROM notification_attempts
         WHERE tenant_id = ? AND incident_id = ? AND alert_channel_id = ?
           AND external_thread_id IS NOT NULL
         ORDER BY attempted_at DESC
         LIMIT 1`,
      )
      .get(tenantId, incidentId, alertChannelId) as
      | { external_thread_id: string }
      | undefined;
    return row?.external_thread_id ?? null;
  }

  private recordAudit(
    tenantId: string,
    incidentId: string,
    eventType:
      | "acknowledged"
      | "resolved"
      | "assigned"
      | "severity_changed"
      | "resolution_note_updated",
    actor: string | null,
    edition: "self_hosted" | "saas",
    at: string,
    detailsJson: string | null = null,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO incident_audit_events (
           id, tenant_id, incident_id, event_type, actor, edition, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createId(),
        tenantId,
        incidentId,
        eventType,
        actor,
        edition,
        detailsJson,
        at,
      );
  }

  private requireIncident(
    tenantId: string,
    incidentId: string,
  ): IncidentRecord {
    const row = this.sqlite
      .prepare(`SELECT * FROM incidents WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, incidentId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(
        `Incident ${incidentId} is not visible in tenant ${tenantId}`,
      );
    }
    return mapIncident(row);
  }

  private assertTenantExists(tenantId: string): void {
    const row = this.sqlite
      .prepare(`SELECT id FROM tenants WHERE id = ?`)
      .get(tenantId);
    if (!row) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
  }

  private assertChannelInTenant(tenantId: string, channelId: string): void {
    const row = this.sqlite
      .prepare(`SELECT id FROM alert_channels WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, channelId);
    if (!row) {
      throw new Error(
        `Alert channel ${channelId} is not visible in tenant ${tenantId}`,
      );
    }
  }
}

function mapIncident(row: Record<string, unknown>): IncidentRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    clientId: (row.client_id as string | null) ?? null,
    contractKind: row.contract_kind as IncidentRecord["contractKind"],
    workflowId: (row.workflow_id as string | null) ?? null,
    outcomeContractId: (row.outcome_contract_id as string | null) ?? null,
    incidentType: row.incident_type as IncidentRecord["incidentType"],
    severity: row.severity as IncidentRecord["severity"],
    status: row.status as IncidentRecord["status"],
    openedAt: String(row.opened_at),
    acknowledgedAt: (row.acknowledged_at as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    lastObservedAt: String(row.last_observed_at),
    lastNotifiedAt: (row.last_notified_at as string | null) ?? null,
    notificationCount: Number(row.notification_count),
    summary: String(row.summary),
    detailsJson: (row.details_json as string | null) ?? null,
    volumeRuleId: (row.volume_rule_id as string | null) ?? null,
    volumeWindowStart: (row.volume_window_start as string | null) ?? null,
    assigneeUserId: (row.assignee_user_id as string | null) ?? null,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    clientSafeResolutionNote:
      (row.client_safe_resolution_note as string | null) ?? null,
    responseTargetMinutes:
      row.response_target_minutes === null ||
      row.response_target_minutes === undefined
        ? null
        : Number(row.response_target_minutes),
    resolutionTargetMinutes:
      row.resolution_target_minutes === null ||
      row.resolution_target_minutes === undefined
        ? null
        : Number(row.resolution_target_minutes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapChannelState(
  row: Record<string, unknown>,
): AlertChannelStateRecord {
  return {
    tenantId: String(row.tenant_id),
    alertChannelId: String(row.alert_channel_id),
    currentHealth:
      row.current_health as AlertChannelStateRecord["currentHealth"],
    lastTestedAt: (row.last_tested_at as string | null) ?? null,
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    lastFailureAt: (row.last_failure_at as string | null) ?? null,
    consecutiveFailures: Number(row.consecutive_failures),
    lastErrorCode: (row.last_error_code as string | null) ?? null,
    lastErrorMessageSanitized:
      (row.last_error_message_sanitized as string | null) ?? null,
    updatedAt: String(row.updated_at),
  };
}

function mapAttempt(row: Record<string, unknown>): NotificationAttemptRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    incidentId: (row.incident_id as string | null) ?? null,
    alertChannelId: String(row.alert_channel_id),
    outboxId: String(row.outbox_id),
    status: row.status as NotificationAttemptRecord["status"],
    attemptedAt: String(row.attempted_at),
    deliveredAt: (row.delivered_at as string | null) ?? null,
    externalMessageId: (row.external_message_id as string | null) ?? null,
    externalThreadId: (row.external_thread_id as string | null) ?? null,
    responseStatusCode: (row.response_status_code as number | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessageSanitized:
      (row.error_message_sanitized as string | null) ?? null,
  };
}

function mapOutbox(row: Record<string, unknown>): NotificationOutboxRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    incidentId: (row.incident_id as string | null) ?? null,
    eventType: row.event_type as NotificationOutboxRecord["eventType"],
    payloadJson: String(row.payload_json),
    availableAt: String(row.available_at),
    claimedAt: (row.claimed_at as string | null) ?? null,
    claimExpiresAt: (row.claim_expires_at as string | null) ?? null,
    processedAt: (row.processed_at as string | null) ?? null,
    attemptCount: Number(row.attempt_count),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}
