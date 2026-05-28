CREATE TABLE "watcher_run_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_started_at" timestamptz,
	"last_success_at" timestamptz,
	"last_error_summary" text,
	"evaluated_contracts" integer NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "watcher_run_state_singleton_check" CHECK ("id" = 1),
	CONSTRAINT "watcher_run_state_evaluated_check" CHECK ("evaluated_contracts" >= 0)
);
--> statement-breakpoint
INSERT INTO "watcher_run_state" ("id", "evaluated_contracts", "updated_at")
VALUES (1, 0, '1970-01-01T00:00:00.000Z');
--> statement-breakpoint
CREATE TABLE "watcher_contract_claims" (
	"tenant_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"claim_owner" text NOT NULL,
	"claimed_at" timestamptz NOT NULL,
	"claim_expires_at" timestamptz NOT NULL,
	CONSTRAINT "watcher_contract_claims_pkey" PRIMARY KEY ("tenant_id", "workflow_id"),
	CONSTRAINT "watcher_contract_claims_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "watcher_contract_claims_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id")
);
--> statement-breakpoint
CREATE TABLE "incident_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor" text,
	"edition" text NOT NULL,
	"details_json" text,
	"created_at" timestamptz NOT NULL,
	CONSTRAINT "incident_audit_events_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "incident_audit_events_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id"),
	CONSTRAINT "incident_audit_events_event_type_check" CHECK ("event_type" IN ('acknowledged', 'resolved')),
	CONSTRAINT "incident_audit_events_edition_check" CHECK ("edition" IN ('self_hosted', 'saas'))
);
--> statement-breakpoint
CREATE INDEX "incident_audit_events_tenant_incident_idx"
ON "incident_audit_events" ("tenant_id", "incident_id");
