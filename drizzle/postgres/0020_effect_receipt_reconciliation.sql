ALTER TABLE "workflow_contracts" ADD COLUMN "effect_reconciliation_enabled" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "last_effect_reconciliation_status" text;
--> statement-breakpoint
ALTER TABLE "incidents" DROP CONSTRAINT IF EXISTS "incidents_incident_type_check";
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_incident_type_check" CHECK ("incident_type" IN (
	'hard_failure', 'silent_absence', 'empty_result', 'malformed_heartbeat',
	'volume_below_minimum', 'volume_above_maximum',
	'missing_destination_records', 'partial_delivery', 'connector_unavailable',
	'schema_drift', 'watcher_failure', 'alert_delivery_failure', 'freshness_stale',
	'effect_count_mismatch'
));
