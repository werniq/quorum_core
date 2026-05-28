CREATE TABLE "contract_volume_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workflow_contract_id" text NOT NULL,
	"minimum_count" integer NOT NULL,
	"maximum_count" integer,
	"window_type" text NOT NULL,
	"timezone" text NOT NULL,
	"week_starts_on" integer,
	"evaluation_grace_minutes" integer NOT NULL,
	"violation_severity" text NOT NULL,
	"is_active" boolean NOT NULL DEFAULT true,
	"activated_at" timestamptz NOT NULL,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "contract_volume_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
	CONSTRAINT "contract_volume_rules_workflow_contract_id_fkey" FOREIGN KEY ("workflow_contract_id") REFERENCES "workflow_contracts"("id"),
	CONSTRAINT "contract_volume_rules_minimum_nonneg" CHECK ("minimum_count" >= 0),
	CONSTRAINT "contract_volume_rules_max_gte_min" CHECK ("maximum_count" IS NULL OR "maximum_count" >= "minimum_count"),
	CONSTRAINT "contract_volume_rules_window_type" CHECK ("window_type" IN ('daily', 'weekly', 'monthly')),
	CONSTRAINT "contract_volume_rules_grace_bounded" CHECK ("evaluation_grace_minutes" >= 0 AND "evaluation_grace_minutes" <= 1440),
	CONSTRAINT "contract_volume_rules_violation_severity" CHECK ("violation_severity" IN ('warning', 'critical')),
	CONSTRAINT "contract_volume_rules_week_starts_on" CHECK ("week_starts_on" IS NULL OR ("week_starts_on" >= 0 AND "week_starts_on" <= 6))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "contract_volume_rules_active_dedupe_uidx"
ON "contract_volume_rules" (
	"tenant_id",
	"workflow_contract_id",
	"window_type",
	"minimum_count",
	COALESCE("maximum_count", -1),
	"timezone",
	COALESCE("week_starts_on", -1)
)
WHERE "is_active" = true;
--> statement-breakpoint
CREATE TABLE "volume_band_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"workflow_contract_id" text NOT NULL,
	"window_start" timestamptz NOT NULL,
	"window_end" timestamptz NOT NULL,
	"evaluated_at" timestamptz,
	"total_items" integer,
	"counted_events" integer NOT NULL DEFAULT 0,
	"unknown_count_events" integer NOT NULL DEFAULT 0,
	"result" text NOT NULL,
	"minimum_count" integer NOT NULL,
	"maximum_count" integer,
	"is_finalized" boolean NOT NULL DEFAULT false,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "volume_band_evaluations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
	CONSTRAINT "volume_band_evaluations_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "contract_volume_rules"("id"),
	CONSTRAINT "volume_band_evaluations_workflow_contract_id_fkey" FOREIGN KEY ("workflow_contract_id") REFERENCES "workflow_contracts"("id"),
	CONSTRAINT "volume_band_evaluations_result" CHECK ("result" IN ('collecting', 'within_band', 'below_minimum', 'above_maximum', 'inconclusive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "volume_band_evaluations_rule_window_uidx"
ON "volume_band_evaluations" ("tenant_id", "rule_id", "window_start");
--> statement-breakpoint
CREATE TABLE "volume_evaluation_claims" (
	"tenant_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"window_start" timestamptz NOT NULL,
	"claim_owner" text NOT NULL,
	"claim_expires_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	PRIMARY KEY ("tenant_id", "rule_id", "window_start"),
	CONSTRAINT "volume_evaluation_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
	CONSTRAINT "volume_evaluation_claims_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "contract_volume_rules"("id")
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "volume_rule_id" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "volume_window_start" timestamptz;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "assignee_user_id" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolution_note" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "client_safe_resolution_note" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "response_target_minutes" integer;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolution_target_minutes" integer;
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_volume_rule_id_fkey" FOREIGN KEY ("volume_rule_id") REFERENCES "contract_volume_rules"("id");
--> statement-breakpoint
ALTER TABLE "incidents" DROP CONSTRAINT IF EXISTS "incidents_incident_type_check";
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_incident_type_check" CHECK ("incident_type" IN (
	'hard_failure', 'silent_absence', 'empty_result', 'malformed_heartbeat',
	'volume_below_minimum', 'volume_above_maximum',
	'missing_destination_records', 'partial_delivery', 'connector_unavailable',
	'schema_drift', 'watcher_failure', 'alert_delivery_failure'
));
--> statement-breakpoint
DROP INDEX IF EXISTS "incidents_one_unresolved_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_unresolved_standard_uidx"
ON "incidents" (
	"tenant_id",
	"contract_kind",
	COALESCE("workflow_id", "outcome_contract_id", ''),
	"incident_type"
)
WHERE "status" IN ('open', 'acknowledged')
AND "incident_type" NOT IN ('volume_below_minimum', 'volume_above_maximum');
--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_unresolved_volume_uidx"
ON "incidents" (
	"tenant_id",
	"workflow_id",
	"volume_rule_id",
	"volume_window_start",
	"incident_type"
)
WHERE "status" IN ('open', 'acknowledged')
AND "incident_type" IN ('volume_below_minimum', 'volume_above_maximum')
AND "volume_rule_id" IS NOT NULL
AND "volume_window_start" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "incident_audit_events" DROP CONSTRAINT IF EXISTS "incident_audit_events_event_type_check";
--> statement-breakpoint
ALTER TABLE "incident_audit_events" ADD CONSTRAINT "incident_audit_events_event_type_check" CHECK ("event_type" IN (
	'acknowledged', 'resolved', 'assigned', 'severity_changed', 'resolution_note_updated'
));
