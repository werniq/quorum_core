CREATE TABLE "workflow_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"key_id" text NOT NULL,
	"encrypted_secret_or_verification_material" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamptz NOT NULL,
	"rotated_from_id" text,
	"revoked_at" timestamptz,
	CONSTRAINT "workflow_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "workflow_credentials_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id"),
	CONSTRAINT "workflow_credentials_rotated_from_id_fk" FOREIGN KEY ("rotated_from_id") REFERENCES "public"."workflow_credentials"("id"),
	CONSTRAINT "workflow_credentials_status_check" CHECK ("status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_credentials_tenant_key_id_uidx"
ON "workflow_credentials" USING btree ("tenant_id","key_id");
--> statement-breakpoint
CREATE TABLE "ingestion_rate_limit_states" (
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"window_started_at" timestamptz NOT NULL,
	"accepted_count" integer NOT NULL,
	"rejected_count" integer NOT NULL,
	"last_rejected_at" timestamptz,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "ingestion_rate_limit_states_pkey" PRIMARY KEY ("tenant_id","workflow_id","credential_id"),
	CONSTRAINT "ingestion_rate_limit_states_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "ingestion_rate_limit_states_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id"),
	CONSTRAINT "ingestion_rate_limit_states_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."workflow_credentials"("id"),
	CONSTRAINT "ingestion_rate_limit_states_accepted_check" CHECK ("accepted_count" >= 0),
	CONSTRAINT "ingestion_rate_limit_states_rejected_check" CHECK ("rejected_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "heartbeat_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"received_at" timestamptz NOT NULL,
	"executed_at" timestamptz NOT NULL,
	"status" text NOT NULL,
	"items_processed" integer,
	"external_execution_ref" text,
	"idempotency_key" text NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"metadata_json" text,
	"created_at" timestamptz NOT NULL,
	CONSTRAINT "heartbeat_events_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "heartbeat_events_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id"),
	CONSTRAINT "heartbeat_events_status_check" CHECK ("status" IN ('success', 'failure', 'empty_result')),
	CONSTRAINT "heartbeat_events_items_processed_check" CHECK ("items_processed" IS NULL OR "items_processed" >= 0),
	CONSTRAINT "heartbeat_events_metadata_size_check" CHECK ("metadata_json" IS NULL OR char_length("metadata_json") <= 8192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_events_workflow_idempotency_uidx"
ON "heartbeat_events" USING btree ("workflow_id","idempotency_key");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forbid_heartbeat_events_mutation()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'heartbeat_events are immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER heartbeat_events_immutable_update
BEFORE UPDATE ON "heartbeat_events"
FOR EACH ROW EXECUTE FUNCTION forbid_heartbeat_events_mutation();
--> statement-breakpoint
CREATE TRIGGER heartbeat_events_immutable_delete
BEFORE DELETE ON "heartbeat_events"
FOR EACH ROW EXECUTE FUNCTION forbid_heartbeat_events_mutation();
--> statement-breakpoint
CREATE TABLE "workflow_states" (
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"last_execution_at" timestamptz,
	"last_nonempty_success_at" timestamptz,
	"last_acceptable_success_at" timestamptz,
	"last_failure_at" timestamptz,
	"last_external_execution_ref" text,
	"last_status" text NOT NULL,
	"next_expected_at" timestamptz,
	"overdue_since" timestamptz,
	"current_health" text NOT NULL,
	"evidence_level" text NOT NULL,
	"evidence_summary_code" text,
	"unverified_dimensions_json" text,
	"consecutive_stale_checks" integer NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "workflow_states_pkey" PRIMARY KEY ("tenant_id","workflow_id"),
	CONSTRAINT "workflow_states_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "workflow_states_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id"),
	CONSTRAINT "workflow_states_last_status_check" CHECK ("last_status" IN ('success', 'failure', 'empty_result', 'unknown')),
	CONSTRAINT "workflow_states_current_health_check" CHECK ("current_health" IN ('healthy', 'warning', 'overdue', 'unknown', 'inactive')),
	CONSTRAINT "workflow_states_evidence_level_check" CHECK ("evidence_level" IN ('basic', 'medium', 'high')),
	CONSTRAINT "workflow_states_stale_checks_check" CHECK ("consecutive_stale_checks" >= 0),
	CONSTRAINT "workflow_states_unverified_size_check" CHECK ("unverified_dimensions_json" IS NULL OR char_length("unverified_dimensions_json") <= 8192)
);
