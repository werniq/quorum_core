CREATE TABLE "reconciliation_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"outcome_contract_id" text NOT NULL,
	"reconciliation_run_id" text,
	"event_type" text NOT NULL,
	"actor" text,
	"details_json" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "reconciliation_audit_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "reconciliation_audit_contract_fk" FOREIGN KEY ("outcome_contract_id") REFERENCES "public"."outcome_contracts"("id"),
	CONSTRAINT "reconciliation_audit_run_fk" FOREIGN KEY ("reconciliation_run_id") REFERENCES "public"."reconciliation_runs"("id"),
	CONSTRAINT "reconciliation_audit_type_check" CHECK ("event_type" IN (
		'export', 'waive_missing', 'retention_purge', 'run_resumed', 'run_idempotent_hit'
	))
);
--> statement-breakpoint
CREATE INDEX "reconciliation_audit_tenant_idx"
ON "reconciliation_audit_events" ("tenant_id", "outcome_contract_id", "created_at");
--> statement-breakpoint
CREATE TABLE "reconciliation_export_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"outcome_contract_id" text NOT NULL,
	"reconciliation_run_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "reconciliation_export_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "reconciliation_export_contract_fk" FOREIGN KEY ("outcome_contract_id") REFERENCES "public"."outcome_contracts"("id"),
	CONSTRAINT "reconciliation_export_run_fk" FOREIGN KEY ("reconciliation_run_id") REFERENCES "public"."reconciliation_runs"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_window_uidx"
ON "reconciliation_runs" ("tenant_id", "outcome_contract_id", "window_start", "window_end");
