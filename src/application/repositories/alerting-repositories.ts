import type {
  AlertChannelHealthState,
  ContractKind,
  IncidentStatus,
} from "../../domain/terminology.js";

export type IncidentType =
  | "hard_failure"
  | "silent_absence"
  | "empty_result"
  | "malformed_heartbeat"
  | "volume_below_minimum"
  | "volume_above_maximum"
  | "missing_destination_records"
  | "partial_delivery"
  | "connector_unavailable"
  | "schema_drift"
  | "watcher_failure"
  | "alert_delivery_failure"
  | "freshness_stale"
  | "effect_count_mismatch";

export type IncidentSeverity = "warning" | "critical";

export type AlertChannelType = "webhook" | "email";

export type OutboxEventType =
  | "opened"
  | "renotification"
  | "acknowledged"
  | "resolved"
  | "channel_test";

export type NotificationAttemptStatus = "pending" | "sent" | "failed";

export interface IncidentRecord {
  id: string;
  tenantId: string;
  clientId: string | null;
  contractKind: ContractKind;
  workflowId: string | null;
  outcomeContractId: string | null;
  incidentType: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  lastObservedAt: string;
  lastNotifiedAt: string | null;
  notificationCount: number;
  summary: string;
  detailsJson: string | null;
  volumeRuleId: string | null;
  volumeWindowStart: string | null;
  assigneeUserId: string | null;
  resolutionNote: string | null;
  clientSafeResolutionNote: string | null;
  responseTargetMinutes: number | null;
  resolutionTargetMinutes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertChannelRecord {
  id: string;
  tenantId: string;
  name: string;
  type: AlertChannelType;
  encryptedConfig: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContractAlertChannelRecord {
  tenantId: string;
  contractKind: ContractKind;
  contractId: string;
  alertChannelId: string;
  createdAt: string;
}

export interface AlertChannelStateRecord {
  tenantId: string;
  alertChannelId: string;
  currentHealth: AlertChannelHealthState;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorMessageSanitized: string | null;
  updatedAt: string;
}

export interface NotificationOutboxRecord {
  id: string;
  tenantId: string;
  incidentId: string | null;
  eventType: OutboxEventType;
  payloadJson: string;
  availableAt: string;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  processedAt: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
}

export interface NotificationAttemptRecord {
  id: string;
  tenantId: string;
  incidentId: string | null;
  alertChannelId: string;
  outboxId: string;
  status: NotificationAttemptStatus;
  attemptedAt: string;
  deliveredAt: string | null;
  externalMessageId: string | null;
  externalThreadId: string | null;
  responseStatusCode: number | null;
  errorCode: string | null;
  errorMessageSanitized: string | null;
}

export interface OpenIncidentInput {
  id: string;
  clientId?: string | null;
  contractKind: ContractKind;
  workflowId?: string | null;
  outcomeContractId?: string | null;
  incidentType: IncidentType;
  severity: IncidentSeverity;
  summary: string;
  detailsJson?: string | null;
  observedAt?: string;
  volumeRuleId?: string | null;
  volumeWindowStart?: string | null;
  responseTargetMinutes?: number | null;
  resolutionTargetMinutes?: number | null;
}

/** Keyset cursor for incident listing (updatedAt DESC, id DESC). */
export interface IncidentListCursor {
  updatedAt: string;
  id: string;
}

export interface ListIncidentsQuery {
  statuses?: IncidentStatus[];
  severity?: IncidentSeverity;
  workflowId?: string;
  /** Matches workflow_id or outcome_contract_id. */
  contractId?: string;
  clientId?: string;
  /** Inclusive lower bound on updated_at (ISO-8601). */
  updatedAfter?: string;
  /** Page size; caller should clamp to 1..100 (API default 50). */
  limit: number;
  cursor?: IncidentListCursor;
}

export interface ListIncidentsResult {
  items: IncidentRecord[];
  nextCursor: IncidentListCursor | null;
}

/** Tenant-scoped incident, routing, health, and outbox persistence. */
export interface AlertingRepositories {
  openOrObserveIncident(
    tenantId: string,
    input: OpenIncidentInput,
  ): IncidentRecord;
  getUnresolvedIncident(
    tenantId: string,
    contractKind: ContractKind,
    contractId: string,
    incidentType: IncidentType,
  ): IncidentRecord | null;
  getUnresolvedVolumeIncident(
    tenantId: string,
    workflowId: string,
    volumeRuleId: string,
    volumeWindowStart: string,
    incidentType: "volume_below_minimum" | "volume_above_maximum",
  ): IncidentRecord | null;
  assignIncident(
    tenantId: string,
    incidentId: string,
    input: {
      assigneeUserId: string | null;
      actor?: string | null;
      edition?: "self_hosted" | "saas";
    },
  ): IncidentRecord;
  updateIncidentTriage(
    tenantId: string,
    incidentId: string,
    input: {
      severity?: IncidentSeverity;
      resolutionNote?: string | null;
      clientSafeResolutionNote?: string | null;
      actor?: string | null;
      edition?: "self_hosted" | "saas";
    },
  ): IncidentRecord;
  listIncidents(tenantId: string): IncidentRecord[];
  /**
   * Tenant-scoped incident listing with filters and keyset pagination.
   * Ordering: updated_at DESC, id DESC. Does not include alert-delivery history.
   */
  queryIncidents(
    tenantId: string,
    query: ListIncidentsQuery,
  ): ListIncidentsResult;
  createAlertChannel(
    tenantId: string,
    input: Omit<AlertChannelRecord, "tenantId" | "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): AlertChannelRecord;
  routeContractToChannel(
    tenantId: string,
    input: Omit<ContractAlertChannelRecord, "tenantId" | "createdAt"> & {
      createdAt?: string;
    },
  ): ContractAlertChannelRecord;
  listRoutesForContract(
    tenantId: string,
    contractKind: ContractKind,
    contractId: string,
  ): ContractAlertChannelRecord[];
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
    at?: string,
  ): AlertChannelStateRecord;
  getAlertChannelState(
    tenantId: string,
    alertChannelId: string,
  ): AlertChannelStateRecord | null;
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
  ): NotificationOutboxRecord;
  recordNotificationAttempt(
    tenantId: string,
    input: Omit<NotificationAttemptRecord, "tenantId">,
  ): NotificationAttemptRecord;
  listNotificationAttempts(
    tenantId: string,
    outboxId: string,
  ): NotificationAttemptRecord[];
  acknowledgeIncident(
    tenantId: string,
    incidentId: string,
    input?: {
      actor?: string | null;
      at?: string;
      edition?: "self_hosted" | "saas";
    },
  ): IncidentRecord;
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
  ): IncidentRecord;
  getIncident(tenantId: string, incidentId: string): IncidentRecord | null;
  markIncidentNotified(tenantId: string, incidentId: string, at: string): void;
  claimOutboxBatch(
    tenantId: string | null,
    input: {
      nowIso: string;
      claimOwner: string;
      claimExpiresAtIso: string;
      limit: number;
    },
  ): NotificationOutboxRecord[];
  markOutboxProcessed(tenantId: string, outboxId: string, at: string): void;
  scheduleOutboxRetry(
    tenantId: string,
    outboxId: string,
    input: {
      availableAtIso: string;
      attemptCount: number;
      lastError: string | null;
    },
  ): void;
  getAlertChannel(
    tenantId: string,
    alertChannelId: string,
  ): AlertChannelRecord | null;
  listAuditEvents(
    tenantId: string,
    incidentId: string,
  ): Array<{
    id: string;
    eventType: "acknowledged" | "resolved";
    actor: string | null;
    edition: string;
    createdAt: string;
  }>;
  findLatestExternalThreadId(
    tenantId: string,
    incidentId: string,
    alertChannelId: string,
  ): string | null;
}
