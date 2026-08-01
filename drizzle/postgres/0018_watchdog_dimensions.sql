ALTER TABLE "workflow_contracts" ADD COLUMN "empty_result_breach_threshold" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "workflow_contracts" ADD COLUMN "source_watermark_required" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "consecutive_empty_results" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "last_source_watermark" text;
--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "consecutive_stale_watermarks" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "incidents" DROP CONSTRAINT IF EXISTS "incidents_incident_type_check";
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_incident_type_check" CHECK ("incident_type" IN (
	'hard_failure', 'silent_absence', 'empty_result', 'malformed_heartbeat',
	'volume_below_minimum', 'volume_above_maximum',
	'missing_destination_records', 'partial_delivery', 'connector_unavailable',
	'schema_drift', 'watcher_failure', 'alert_delivery_failure', 'freshness_stale'
));
