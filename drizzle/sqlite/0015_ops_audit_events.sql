-- Self-hosted ops audit: tenant-scoped mutable-action trail (immutable after insert).

CREATE TABLE `ops_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`resource_type` text,
	`resource_id` text,
	`details_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);
--> statement-breakpoint
CREATE INDEX `ops_audit_events_tenant_idx` ON `ops_audit_events` (`tenant_id`, `created_at`);
--> statement-breakpoint
CREATE TRIGGER `ops_audit_events_immutable_update`
BEFORE UPDATE ON `ops_audit_events`
BEGIN
	SELECT RAISE(ABORT, 'ops_audit_events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `ops_audit_events_immutable_delete`
BEFORE DELETE ON `ops_audit_events`
BEGIN
	SELECT RAISE(ABORT, 'ops_audit_events are immutable');
END;
