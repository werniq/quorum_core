CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text,
	"name" text NOT NULL,
	"source_platform" text NOT NULL,
	"external_workflow_id" text NOT NULL,
	"description" text,
	"monitoring_method" text NOT NULL,
	"is_active" boolean NOT NULL,
	"monitoring_started_at" timestamptz,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "workflows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "workflows_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id"),
	CONSTRAINT "workflows_source_platform_check" CHECK ("source_platform" IN ('n8n')),
	CONSTRAINT "workflows_monitoring_method_check" CHECK ("monitoring_method" IN ('push', 'poll'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_tenant_external_uidx" ON "workflows" USING btree ("tenant_id","source_platform","external_workflow_id");
--> statement-breakpoint
CREATE TABLE "workflow_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"name" text NOT NULL,
	"business_purpose" text NOT NULL,
	"contract_type" text NOT NULL,
	"cadence_type" text NOT NULL,
	"cadence_value" text NOT NULL,
	"interval_mode" text,
	"schedule_anchor_at" timestamptz,
	"timezone" text,
	"allowed_lateness_minutes" integer NOT NULL,
	"max_quiet_window_minutes" integer,
	"initial_grace_minutes" integer NOT NULL,
	"empty_result_policy" text NOT NULL,
	"count_less_success_allowed" boolean NOT NULL,
	"notification_backoff_minutes" integer DEFAULT 240 NOT NULL,
	"evidence_level" text NOT NULL,
	"schema_version" integer NOT NULL,
	"is_active" boolean NOT NULL,
	"activated_at" timestamptz,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "workflow_contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "workflow_contracts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id"),
	CONSTRAINT "workflow_contracts_contract_type_check" CHECK ("contract_type" IN ('heartbeat')),
	CONSTRAINT "workflow_contracts_cadence_type_check" CHECK ("cadence_type" IN ('interval', 'cron', 'event_driven')),
	CONSTRAINT "workflow_contracts_interval_mode_check" CHECK ("interval_mode" IS NULL OR "interval_mode" IN ('fixed_rate', 'since_last_success')),
	CONSTRAINT "workflow_contracts_empty_result_policy_check" CHECK ("empty_result_policy" IN ('allowed', 'warning', 'failure')),
	CONSTRAINT "workflow_contracts_evidence_level_check" CHECK ("evidence_level" IN ('basic', 'medium', 'high'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_contracts_one_active_heartbeat_uidx"
ON "workflow_contracts" ("workflow_id")
WHERE "is_active" = true AND "contract_type" = 'heartbeat';
