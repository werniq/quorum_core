CREATE TABLE `watcher_run_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_started_at` text,
	`last_success_at` text,
	`last_error_summary` text,
	`evaluated_contracts` integer NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (`id` = 1),
	CHECK (`evaluated_contracts` >= 0)
);
--> statement-breakpoint
INSERT INTO `watcher_run_state` (`id`, `evaluated_contracts`, `updated_at`)
VALUES (1, 0, '1970-01-01T00:00:00.000Z');
--> statement-breakpoint
CREATE TABLE `watcher_contract_claims` (
	`tenant_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`claim_owner` text NOT NULL,
	`claimed_at` text NOT NULL,
	`claim_expires_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `workflow_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`)
);
--> statement-breakpoint
CREATE TABLE `incident_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`incident_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor` text,
	`edition` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`),
	CHECK (`event_type` IN ('acknowledged', 'resolved')),
	CHECK (`edition` IN ('self_hosted', 'saas'))
);
--> statement-breakpoint
CREATE INDEX `incident_audit_events_tenant_incident_idx`
ON `incident_audit_events` (`tenant_id`, `incident_id`);
