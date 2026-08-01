ALTER TABLE "n8n_connectors" ADD COLUMN "unknown_reason" text;
--> statement-breakpoint
ALTER TABLE "n8n_connectors" ADD COLUMN "first_failure_at" text;
--> statement-breakpoint
ALTER TABLE "n8n_connectors" ADD COLUMN "latest_failure_at" text;
--> statement-breakpoint
ALTER TABLE "watcher_run_state" ADD COLUMN "unknown_reason" text;
--> statement-breakpoint
ALTER TABLE "watcher_run_state" ADD COLUMN "first_failure_at" text;
--> statement-breakpoint
ALTER TABLE "watcher_run_state" ADD COLUMN "latest_failure_at" text;
--> statement-breakpoint
ALTER TABLE "workflow_contracts" ADD COLUMN "watermark_comparison_type" text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE "workflow_contracts" ADD COLUMN "freshness_allowed_staleness_seconds" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "workflow_states" ADD COLUMN "last_source_watermark_at" text;
