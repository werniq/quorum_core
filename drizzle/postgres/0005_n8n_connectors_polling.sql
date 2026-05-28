CREATE TABLE "n8n_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"auth_mode" text NOT NULL,
	"status" text NOT NULL,
	"health" text NOT NULL,
	"last_checked_at" timestamptz,
	"last_success_at" timestamptz,
	"last_error_code" text,
	"last_error_summary" text,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "n8n_connectors_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "n8n_connectors_auth_mode_check" CHECK ("auth_mode" IN ('api_key')),
	CONSTRAINT "n8n_connectors_status_check" CHECK ("status" IN ('active', 'disabled')),
	CONSTRAINT "n8n_connectors_health_check" CHECK ("health" IN ('unknown', 'healthy', 'auth_failed', 'unreachable', 'misconfigured'))
);
--> statement-breakpoint
CREATE INDEX "n8n_connectors_tenant_idx"
ON "n8n_connectors" ("tenant_id");
--> statement-breakpoint
CREATE TABLE "n8n_poll_checkpoints" (
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"last_seen_execution_id" text,
	"last_finished_at" timestamptz,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "n8n_poll_checkpoints_pkey" PRIMARY KEY ("tenant_id", "workflow_id"),
	CONSTRAINT "n8n_poll_checkpoints_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "n8n_poll_checkpoints_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id"),
	CONSTRAINT "n8n_poll_checkpoints_connector_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."n8n_connectors"("id")
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "connector_id" text;
--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_connector_id_fk"
FOREIGN KEY ("connector_id") REFERENCES "public"."n8n_connectors"("id");
