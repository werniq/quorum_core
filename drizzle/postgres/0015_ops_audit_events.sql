-- Self-hosted ops audit: tenant-scoped mutable-action trail (immutable after insert).

CREATE TABLE "ops_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"details_json" text,
	"created_at" timestamptz NOT NULL,
	CONSTRAINT "ops_audit_events_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
);
--> statement-breakpoint
CREATE INDEX "ops_audit_events_tenant_idx" ON "ops_audit_events" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION quorum_forbid_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ops_audit_events_immutable_update ON ops_audit_events;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ops_audit_events_immutable_delete ON ops_audit_events;
--> statement-breakpoint
CREATE TRIGGER ops_audit_events_immutable_update
BEFORE UPDATE ON ops_audit_events
FOR EACH ROW EXECUTE FUNCTION quorum_forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER ops_audit_events_immutable_delete
BEFORE DELETE ON ops_audit_events
FOR EACH ROW EXECUTE FUNCTION quorum_forbid_audit_mutation();
