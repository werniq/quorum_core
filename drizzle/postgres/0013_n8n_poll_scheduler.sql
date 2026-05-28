ALTER TABLE "n8n_connectors" ADD COLUMN "poll_interval_ms" integer NOT NULL DEFAULT 60000;
--> statement-breakpoint
ALTER TABLE "n8n_connectors" ADD CONSTRAINT "n8n_connectors_poll_interval_ms_check" CHECK ("poll_interval_ms" > 0);
--> statement-breakpoint
CREATE TABLE "n8n_poll_claims" (
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"claim_owner" text NOT NULL,
	"claim_expires_at" timestamptz NOT NULL,
	"last_poll_started_at" timestamptz,
	"last_poll_finished_at" timestamptz,
	"consecutive_failures" integer NOT NULL DEFAULT 0,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "n8n_poll_claims_pkey" PRIMARY KEY ("tenant_id", "workflow_id"),
	CONSTRAINT "n8n_poll_claims_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "n8n_poll_claims_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id"),
	CONSTRAINT "n8n_poll_claims_failures_check" CHECK ("consecutive_failures" >= 0)
);
