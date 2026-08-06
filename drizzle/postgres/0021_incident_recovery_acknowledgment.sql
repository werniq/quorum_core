ALTER TABLE "incidents" ADD COLUMN "lifecycle_status" text NOT NULL DEFAULT 'active' CHECK ("lifecycle_status" IN ('active', 'recovered'));
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledgment_status" text NOT NULL DEFAULT 'unacknowledged' CHECK ("acknowledgment_status" IN ('unacknowledged', 'acknowledged'));
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovered_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_evidence" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledged_by" text;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledgment_note" text;
--> statement-breakpoint
UPDATE "incidents"
SET "lifecycle_status" = CASE WHEN "status" = 'resolved' THEN 'recovered' ELSE 'active' END,
    "acknowledgment_status" = CASE WHEN "status" IN ('acknowledged', 'resolved') THEN 'acknowledged' ELSE 'unacknowledged' END,
    "recovered_at" = CASE WHEN "status" = 'resolved' THEN "resolved_at" ELSE NULL END,
    "acknowledged_at" = CASE WHEN "status" = 'resolved' THEN COALESCE("acknowledged_at", "resolved_at") ELSE "acknowledged_at" END,
    "acknowledged_by" = CASE WHEN "status" IN ('acknowledged', 'resolved') THEN 'migration:legacy-status' ELSE NULL END,
    "status" = CASE WHEN "status" = 'resolved' THEN 'resolved' ELSE 'open' END;
