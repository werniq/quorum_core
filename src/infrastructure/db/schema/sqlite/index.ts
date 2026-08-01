import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const tenants = sqliteTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  edition: text("edition", { enum: ["self_hosted", "saas"] }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const clients = sqliteTable(
  "clients",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status", {
      enum: ["onboarding", "protected", "paused", "archived"],
    }).notNull(),
    protectionStartedAt: text("protection_started_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("clients_tenant_slug_uidx").on(table.tenantId, table.slug),
  ],
);

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    clientId: text("client_id").references(() => clients.id),
    name: text("name").notNull(),
    sourcePlatform: text("source_platform", { enum: ["n8n"] }).notNull(),
    externalWorkflowId: text("external_workflow_id").notNull(),
    description: text("description"),
    monitoringMethod: text("monitoring_method", {
      enum: ["push", "poll"],
    }).notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull(),
    monitoringStartedAt: text("monitoring_started_at"),
    connectorId: text("connector_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("workflows_tenant_external_uidx").on(
      table.tenantId,
      table.sourcePlatform,
      table.externalWorkflowId,
    ),
  ],
);

export const n8nConnectors = sqliteTable("n8n_connectors", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  authMode: text("auth_mode", { enum: ["api_key"] }).notNull(),
  status: text("status", { enum: ["active", "disabled"] }).notNull(),
  health: text("health", {
    enum: ["unknown", "healthy", "auth_failed", "unreachable", "misconfigured"],
  }).notNull(),
  lastCheckedAt: text("last_checked_at"),
  lastSuccessAt: text("last_success_at"),
  lastErrorCode: text("last_error_code"),
  lastErrorSummary: text("last_error_summary"),
  unknownReason: text("unknown_reason"),
  firstFailureAt: text("first_failure_at"),
  latestFailureAt: text("latest_failure_at"),
  pollIntervalMs: integer("poll_interval_ms").notNull().default(60_000),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const n8nPollClaims = sqliteTable("n8n_poll_claims", {
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id),
  claimOwner: text("claim_owner").notNull(),
  claimExpiresAt: text("claim_expires_at").notNull(),
  lastPollStartedAt: text("last_poll_started_at"),
  lastPollFinishedAt: text("last_poll_finished_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const n8nPollCheckpoints = sqliteTable("n8n_poll_checkpoints", {
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id),
  connectorId: text("connector_id")
    .notNull()
    .references(() => n8nConnectors.id),
  lastSeenExecutionId: text("last_seen_execution_id"),
  lastFinishedAt: text("last_finished_at"),
  updatedAt: text("updated_at").notNull(),
});

export const workflowContracts = sqliteTable("workflow_contracts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id),
  name: text("name").notNull(),
  businessPurpose: text("business_purpose").notNull(),
  contractType: text("contract_type", { enum: ["heartbeat"] }).notNull(),
  cadenceType: text("cadence_type", {
    enum: ["interval", "cron", "event_driven"],
  }).notNull(),
  cadenceValue: text("cadence_value").notNull(),
  intervalMode: text("interval_mode", {
    enum: ["fixed_rate", "since_last_success"],
  }),
  scheduleAnchorAt: text("schedule_anchor_at"),
  timezone: text("timezone"),
  allowedLatenessMinutes: integer("allowed_lateness_minutes").notNull(),
  maxQuietWindowMinutes: integer("max_quiet_window_minutes"),
  initialGraceMinutes: integer("initial_grace_minutes").notNull(),
  emptyResultPolicy: text("empty_result_policy", {
    enum: ["allowed", "warning", "failure"],
  }).notNull(),
  countLessSuccessAllowed: integer("count_less_success_allowed", {
    mode: "boolean",
  }).notNull(),
  notificationBackoffMinutes: integer("notification_backoff_minutes")
    .notNull()
    .default(240),
  evidenceLevel: text("evidence_level", {
    enum: ["basic", "medium", "high"],
  }).notNull(),
  schemaVersion: integer("schema_version").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull(),
  activatedAt: text("activated_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workflowCredentials = sqliteTable(
  "workflow_credentials",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    keyId: text("key_id").notNull(),
    encryptedSecretOrVerificationMaterial: text(
      "encrypted_secret_or_verification_material",
    ).notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull(),
    createdAt: text("created_at").notNull(),
    rotatedFromId: text("rotated_from_id"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("workflow_credentials_tenant_key_id_uidx").on(
      table.tenantId,
      table.keyId,
    ),
  ],
);

export const ingestionRateLimitStates = sqliteTable(
  "ingestion_rate_limit_states",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    credentialId: text("credential_id")
      .notNull()
      .references(() => workflowCredentials.id),
    windowStartedAt: text("window_started_at").notNull(),
    acceptedCount: integer("accepted_count").notNull(),
    rejectedCount: integer("rejected_count").notNull(),
    lastRejectedAt: text("last_rejected_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // Composite primary key expressed in SQL migrations.
    uniqueIndex("ingestion_rate_limit_states_pkey").on(
      table.tenantId,
      table.workflowId,
      table.credentialId,
    ),
  ],
);

export const heartbeatEvents = sqliteTable(
  "heartbeat_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    receivedAt: text("received_at").notNull(),
    executedAt: text("executed_at").notNull(),
    status: text("status", {
      enum: ["success", "failure", "empty_result"],
    }).notNull(),
    itemsProcessed: integer("items_processed"),
    externalExecutionRef: text("external_execution_ref"),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadSchemaVersion: integer("payload_schema_version").notNull(),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("heartbeat_events_workflow_idempotency_uidx").on(
      table.workflowId,
      table.idempotencyKey,
    ),
  ],
);

export const workflowStates = sqliteTable(
  "workflow_states",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    lastExecutionAt: text("last_execution_at"),
    lastNonemptySuccessAt: text("last_nonempty_success_at"),
    lastAcceptableSuccessAt: text("last_acceptable_success_at"),
    lastFailureAt: text("last_failure_at"),
    lastExternalExecutionRef: text("last_external_execution_ref"),
    lastStatus: text("last_status", {
      enum: ["success", "failure", "empty_result", "unknown"],
    }).notNull(),
    nextExpectedAt: text("next_expected_at"),
    overdueSince: text("overdue_since"),
    currentHealth: text("current_health", {
      enum: ["healthy", "warning", "overdue", "unknown", "inactive"],
    }).notNull(),
    evidenceLevel: text("evidence_level", {
      enum: ["basic", "medium", "high"],
    }).notNull(),
    evidenceSummaryCode: text("evidence_summary_code"),
    unverifiedDimensionsJson: text("unverified_dimensions_json"),
    consecutiveStaleChecks: integer("consecutive_stale_checks").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("workflow_states_pkey").on(table.tenantId, table.workflowId),
  ],
);

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  clientId: text("client_id").references(() => clients.id),
  contractKind: text("contract_kind", {
    enum: ["workflow", "outcome", "system"],
  }).notNull(),
  workflowId: text("workflow_id").references(() => workflows.id),
  outcomeContractId: text("outcome_contract_id"),
  incidentType: text("incident_type", {
    enum: [
      "hard_failure",
      "silent_absence",
      "empty_result",
      "malformed_heartbeat",
      "volume_below_minimum",
      "volume_above_maximum",
      "missing_destination_records",
      "partial_delivery",
      "connector_unavailable",
      "schema_drift",
      "watcher_failure",
      "alert_delivery_failure",
      "freshness_stale",
    ],
  }).notNull(),
  severity: text("severity", { enum: ["warning", "critical"] }).notNull(),
  status: text("status", {
    enum: ["open", "acknowledged", "resolved"],
  }).notNull(),
  openedAt: text("opened_at").notNull(),
  acknowledgedAt: text("acknowledged_at"),
  resolvedAt: text("resolved_at"),
  lastObservedAt: text("last_observed_at").notNull(),
  lastNotifiedAt: text("last_notified_at"),
  notificationCount: integer("notification_count").notNull(),
  summary: text("summary").notNull(),
  detailsJson: text("details_json"),
  volumeRuleId: text("volume_rule_id"),
  volumeWindowStart: text("volume_window_start"),
  assigneeUserId: text("assignee_user_id"),
  resolutionNote: text("resolution_note"),
  clientSafeResolutionNote: text("client_safe_resolution_note"),
  responseTargetMinutes: integer("response_target_minutes"),
  resolutionTargetMinutes: integer("resolution_target_minutes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const alertChannels = sqliteTable("alert_channels", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  type: text("type", { enum: ["webhook", "email"] }).notNull(),
  encryptedConfig: text("encrypted_config").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const contractAlertChannels = sqliteTable(
  "contract_alert_channels",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    contractKind: text("contract_kind", {
      enum: ["workflow", "outcome", "system"],
    }).notNull(),
    contractId: text("contract_id").notNull(),
    alertChannelId: text("alert_channel_id")
      .notNull()
      .references(() => alertChannels.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("contract_alert_channels_pkey").on(
      table.tenantId,
      table.contractKind,
      table.contractId,
      table.alertChannelId,
    ),
  ],
);

export const alertChannelStates = sqliteTable(
  "alert_channel_states",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    alertChannelId: text("alert_channel_id")
      .notNull()
      .references(() => alertChannels.id),
    currentHealth: text("current_health", {
      enum: ["unknown", "healthy", "degraded", "failing"],
    }).notNull(),
    lastTestedAt: text("last_tested_at"),
    lastSuccessAt: text("last_success_at"),
    lastFailureAt: text("last_failure_at"),
    consecutiveFailures: integer("consecutive_failures").notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorMessageSanitized: text("last_error_message_sanitized"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("alert_channel_states_pkey").on(
      table.tenantId,
      table.alertChannelId,
    ),
  ],
);

export const notificationOutbox = sqliteTable("notification_outbox", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  incidentId: text("incident_id").references(() => incidents.id),
  eventType: text("event_type", {
    enum: [
      "opened",
      "renotification",
      "acknowledged",
      "resolved",
      "channel_test",
    ],
  }).notNull(),
  payloadJson: text("payload_json").notNull(),
  availableAt: text("available_at").notNull(),
  claimedAt: text("claimed_at"),
  claimExpiresAt: text("claim_expires_at"),
  processedAt: text("processed_at"),
  attemptCount: integer("attempt_count").notNull(),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
});

export const notificationAttempts = sqliteTable("notification_attempts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  incidentId: text("incident_id").references(() => incidents.id),
  alertChannelId: text("alert_channel_id")
    .notNull()
    .references(() => alertChannels.id),
  outboxId: text("outbox_id")
    .notNull()
    .references(() => notificationOutbox.id),
  status: text("status", {
    enum: ["pending", "sent", "failed"],
  }).notNull(),
  attemptedAt: text("attempted_at").notNull(),
  deliveredAt: text("delivered_at"),
  externalMessageId: text("external_message_id"),
  externalThreadId: text("external_thread_id"),
  responseStatusCode: integer("response_status_code"),
  errorCode: text("error_code"),
  errorMessageSanitized: text("error_message_sanitized"),
});

export const sqliteSchema = {
  tenants,
  clients,
  workflows,
  workflowContracts,
  workflowCredentials,
  ingestionRateLimitStates,
  heartbeatEvents,
  workflowStates,
  incidents,
  alertChannels,
  contractAlertChannels,
  alertChannelStates,
  notificationOutbox,
  notificationAttempts,
};
