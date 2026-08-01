import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  edition: text("edition", { enum: ["self_hosted", "saas"] }).notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const clients = pgTable(
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
    protectionStartedAt: timestamp("protection_started_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("clients_tenant_slug_uidx").on(table.tenantId, table.slug),
  ],
);

export const workflows = pgTable(
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
    isActive: boolean("is_active").notNull(),
    monitoringStartedAt: timestamp("monitoring_started_at", {
      withTimezone: true,
      mode: "date",
    }),
    connectorId: text("connector_id"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("workflows_tenant_external_uidx").on(
      table.tenantId,
      table.sourcePlatform,
      table.externalWorkflowId,
    ),
  ],
);

export const n8nConnectors = pgTable("n8n_connectors", {
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
  lastCheckedAt: timestamp("last_checked_at", {
    withTimezone: true,
    mode: "date",
  }),
  lastSuccessAt: timestamp("last_success_at", {
    withTimezone: true,
    mode: "date",
  }),
  lastErrorCode: text("last_error_code"),
  lastErrorSummary: text("last_error_summary"),
  unknownReason: text("unknown_reason"),
  firstFailureAt: timestamp("first_failure_at", {
    withTimezone: true,
    mode: "date",
  }),
  latestFailureAt: timestamp("latest_failure_at", {
    withTimezone: true,
    mode: "date",
  }),
  pollIntervalMs: integer("poll_interval_ms").notNull().default(60_000),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const n8nPollClaims = pgTable("n8n_poll_claims", {
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  workflowId: text("workflow_id")
    .notNull()
    .references(() => workflows.id),
  claimOwner: text("claim_owner").notNull(),
  claimExpiresAt: timestamp("claim_expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  lastPollStartedAt: timestamp("last_poll_started_at", {
    withTimezone: true,
    mode: "date",
  }),
  lastPollFinishedAt: timestamp("last_poll_finished_at", {
    withTimezone: true,
    mode: "date",
  }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const n8nPollCheckpoints = pgTable("n8n_poll_checkpoints", {
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
  lastFinishedAt: timestamp("last_finished_at", {
    withTimezone: true,
    mode: "date",
  }),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const workflowContracts = pgTable("workflow_contracts", {
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
  scheduleAnchorAt: timestamp("schedule_anchor_at", {
    withTimezone: true,
    mode: "date",
  }),
  timezone: text("timezone"),
  allowedLatenessMinutes: integer("allowed_lateness_minutes").notNull(),
  maxQuietWindowMinutes: integer("max_quiet_window_minutes"),
  initialGraceMinutes: integer("initial_grace_minutes").notNull(),
  emptyResultPolicy: text("empty_result_policy", {
    enum: ["allowed", "warning", "failure"],
  }).notNull(),
  countLessSuccessAllowed: boolean("count_less_success_allowed").notNull(),
  notificationBackoffMinutes: integer("notification_backoff_minutes")
    .notNull()
    .default(240),
  evidenceLevel: text("evidence_level", {
    enum: ["basic", "medium", "high"],
  }).notNull(),
  schemaVersion: integer("schema_version").notNull(),
  isActive: boolean("is_active").notNull(),
  activatedAt: timestamp("activated_at", {
    withTimezone: true,
    mode: "date",
  }),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const workflowCredentials = pgTable(
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
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    rotatedFromId: text("rotated_from_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("workflow_credentials_tenant_key_id_uidx").on(
      table.tenantId,
      table.keyId,
    ),
  ],
);

export const ingestionRateLimitStates = pgTable(
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
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    acceptedCount: integer("accepted_count").notNull(),
    rejectedCount: integer("rejected_count").notNull(),
    lastRejectedAt: timestamp("last_rejected_at", {
      withTimezone: true,
      mode: "date",
    }),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("ingestion_rate_limit_states_pkey").on(
      table.tenantId,
      table.workflowId,
      table.credentialId,
    ),
  ],
);

export const heartbeatEvents = pgTable(
  "heartbeat_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    executedAt: timestamp("executed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    status: text("status", {
      enum: ["success", "failure", "empty_result"],
    }).notNull(),
    itemsProcessed: integer("items_processed"),
    externalExecutionRef: text("external_execution_ref"),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadSchemaVersion: integer("payload_schema_version").notNull(),
    metadataJson: text("metadata_json"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("heartbeat_events_workflow_idempotency_uidx").on(
      table.workflowId,
      table.idempotencyKey,
    ),
  ],
);

export const workflowStates = pgTable(
  "workflow_states",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id),
    lastExecutionAt: timestamp("last_execution_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastNonemptySuccessAt: timestamp("last_nonempty_success_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastAcceptableSuccessAt: timestamp("last_acceptable_success_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastFailureAt: timestamp("last_failure_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastExternalExecutionRef: text("last_external_execution_ref"),
    lastStatus: text("last_status", {
      enum: ["success", "failure", "empty_result", "unknown"],
    }).notNull(),
    nextExpectedAt: timestamp("next_expected_at", {
      withTimezone: true,
      mode: "date",
    }),
    overdueSince: timestamp("overdue_since", {
      withTimezone: true,
      mode: "date",
    }),
    currentHealth: text("current_health", {
      enum: ["healthy", "warning", "overdue", "unknown", "inactive"],
    }).notNull(),
    evidenceLevel: text("evidence_level", {
      enum: ["basic", "medium", "high"],
    }).notNull(),
    evidenceSummaryCode: text("evidence_summary_code"),
    unverifiedDimensionsJson: text("unverified_dimensions_json"),
    consecutiveStaleChecks: integer("consecutive_stale_checks").notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("workflow_states_pkey").on(table.tenantId, table.workflowId),
  ],
);

export const incidents = pgTable("incidents", {
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
      "missing_destination_records",
      "partial_delivery",
      "connector_unavailable",
      "schema_drift",
      "watcher_failure",
      "alert_delivery_failure",
      "freshness_stale",
      "effect_count_mismatch",
    ],
  }).notNull(),
  severity: text("severity", { enum: ["warning", "critical"] }).notNull(),
  status: text("status", {
    enum: ["open", "acknowledged", "resolved"],
  }).notNull(),
  openedAt: timestamp("opened_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  acknowledgedAt: timestamp("acknowledged_at", {
    withTimezone: true,
    mode: "date",
  }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  lastObservedAt: timestamp("last_observed_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  lastNotifiedAt: timestamp("last_notified_at", {
    withTimezone: true,
    mode: "date",
  }),
  notificationCount: integer("notification_count").notNull(),
  summary: text("summary").notNull(),
  detailsJson: text("details_json"),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const alertChannels = pgTable("alert_channels", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  type: text("type", { enum: ["webhook", "email"] }).notNull(),
  encryptedConfig: text("encrypted_config").notNull(),
  isActive: boolean("is_active").notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const contractAlertChannels = pgTable(
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
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
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

export const alertChannelStates = pgTable(
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
    lastTestedAt: timestamp("last_tested_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastSuccessAt: timestamp("last_success_at", {
      withTimezone: true,
      mode: "date",
    }),
    lastFailureAt: timestamp("last_failure_at", {
      withTimezone: true,
      mode: "date",
    }),
    consecutiveFailures: integer("consecutive_failures").notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorMessageSanitized: text("last_error_message_sanitized"),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("alert_channel_states_pkey").on(
      table.tenantId,
      table.alertChannelId,
    ),
  ],
);

export const notificationOutbox = pgTable("notification_outbox", {
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
  availableAt: timestamp("available_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
  claimExpiresAt: timestamp("claim_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  processedAt: timestamp("processed_at", {
    withTimezone: true,
    mode: "date",
  }),
  attemptCount: integer("attempt_count").notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});

export const notificationAttempts = pgTable("notification_attempts", {
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
  attemptedAt: timestamp("attempted_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  deliveredAt: timestamp("delivered_at", {
    withTimezone: true,
    mode: "date",
  }),
  externalMessageId: text("external_message_id"),
  externalThreadId: text("external_thread_id"),
  responseStatusCode: integer("response_status_code"),
  errorCode: text("error_code"),
  errorMessageSanitized: text("error_message_sanitized"),
});

export const postgresSchema = {
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
