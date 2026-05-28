CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text,
	"contract_kind" text NOT NULL,
	"workflow_id" text,
	"outcome_contract_id" text,
	"incident_type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamptz NOT NULL,
	"acknowledged_at" timestamptz,
	"resolved_at" timestamptz,
	"last_observed_at" timestamptz NOT NULL,
	"last_notified_at" timestamptz,
	"notification_count" integer NOT NULL,
	"summary" text NOT NULL,
	"details_json" text,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "incidents_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "incidents_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id"),
	CONSTRAINT "incidents_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id"),
	CONSTRAINT "incidents_contract_kind_check" CHECK ("contract_kind" IN ('workflow', 'outcome', 'system')),
	CONSTRAINT "incidents_incident_type_check" CHECK ("incident_type" IN (
		'hard_failure', 'silent_absence', 'empty_result', 'malformed_heartbeat',
		'missing_destination_records', 'partial_delivery', 'connector_unavailable',
		'schema_drift', 'watcher_failure', 'alert_delivery_failure'
	)),
	CONSTRAINT "incidents_severity_check" CHECK ("severity" IN ('warning', 'critical')),
	CONSTRAINT "incidents_status_check" CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
	CONSTRAINT "incidents_notification_count_check" CHECK ("notification_count" >= 0),
	CONSTRAINT "incidents_contract_refs_check" CHECK (
		("contract_kind" = 'workflow' AND "workflow_id" IS NOT NULL AND "outcome_contract_id" IS NULL)
		OR ("contract_kind" = 'outcome' AND "outcome_contract_id" IS NOT NULL AND "workflow_id" IS NULL)
		OR ("contract_kind" = 'system' AND "workflow_id" IS NULL AND "outcome_contract_id" IS NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_unresolved_uidx"
ON "incidents" (
	"tenant_id",
	"contract_kind",
	COALESCE("workflow_id", "outcome_contract_id", ''),
	"incident_type"
)
WHERE "status" IN ('open', 'acknowledged');
--> statement-breakpoint
CREATE TABLE "alert_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"encrypted_config" text NOT NULL,
	"is_active" boolean NOT NULL,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "alert_channels_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "alert_channels_type_check" CHECK ("type" IN ('webhook', 'email'))
);
--> statement-breakpoint
CREATE TABLE "contract_alert_channels" (
	"tenant_id" text NOT NULL,
	"contract_kind" text NOT NULL,
	"contract_id" text NOT NULL,
	"alert_channel_id" text NOT NULL,
	"created_at" timestamptz NOT NULL,
	CONSTRAINT "contract_alert_channels_pkey" PRIMARY KEY ("tenant_id","contract_kind","contract_id","alert_channel_id"),
	CONSTRAINT "contract_alert_channels_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "contract_alert_channels_alert_channel_id_fk" FOREIGN KEY ("alert_channel_id") REFERENCES "public"."alert_channels"("id"),
	CONSTRAINT "contract_alert_channels_kind_check" CHECK ("contract_kind" IN ('workflow', 'outcome', 'system'))
);
--> statement-breakpoint
CREATE TABLE "alert_channel_states" (
	"tenant_id" text NOT NULL,
	"alert_channel_id" text NOT NULL,
	"current_health" text NOT NULL,
	"last_tested_at" timestamptz,
	"last_success_at" timestamptz,
	"last_failure_at" timestamptz,
	"consecutive_failures" integer NOT NULL,
	"last_error_code" text,
	"last_error_message_sanitized" text,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "alert_channel_states_pkey" PRIMARY KEY ("tenant_id","alert_channel_id"),
	CONSTRAINT "alert_channel_states_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "alert_channel_states_alert_channel_id_fk" FOREIGN KEY ("alert_channel_id") REFERENCES "public"."alert_channels"("id"),
	CONSTRAINT "alert_channel_states_health_check" CHECK ("current_health" IN ('unknown', 'healthy', 'degraded', 'failing')),
	CONSTRAINT "alert_channel_states_failures_check" CHECK ("consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"incident_id" text,
	"event_type" text NOT NULL,
	"payload_json" text NOT NULL,
	"available_at" timestamptz NOT NULL,
	"claimed_at" timestamptz,
	"claim_expires_at" timestamptz,
	"processed_at" timestamptz,
	"attempt_count" integer NOT NULL,
	"last_error" text,
	"created_at" timestamptz NOT NULL,
	CONSTRAINT "notification_outbox_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "notification_outbox_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id"),
	CONSTRAINT "notification_outbox_event_type_check" CHECK ("event_type" IN ('opened', 'renotification', 'acknowledged', 'resolved', 'channel_test')),
	CONSTRAINT "notification_outbox_attempt_count_check" CHECK ("attempt_count" >= 0),
	CONSTRAINT "notification_outbox_incident_ref_check" CHECK (
		("event_type" = 'channel_test' AND "incident_id" IS NULL)
		OR ("event_type" != 'channel_test' AND "incident_id" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE TABLE "notification_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"incident_id" text,
	"alert_channel_id" text NOT NULL,
	"outbox_id" text NOT NULL,
	"status" text NOT NULL,
	"attempted_at" timestamptz NOT NULL,
	"delivered_at" timestamptz,
	"external_message_id" text,
	"external_thread_id" text,
	"response_status_code" integer,
	"error_code" text,
	"error_message_sanitized" text,
	CONSTRAINT "notification_attempts_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "notification_attempts_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id"),
	CONSTRAINT "notification_attempts_alert_channel_id_fk" FOREIGN KEY ("alert_channel_id") REFERENCES "public"."alert_channels"("id"),
	CONSTRAINT "notification_attempts_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id"),
	CONSTRAINT "notification_attempts_status_check" CHECK ("status" IN ('pending', 'sent', 'failed'))
);
