ALTER TABLE `n8n_connectors` ADD COLUMN `poll_interval_ms` integer NOT NULL DEFAULT 60000 CHECK (`poll_interval_ms` > 0);
--> statement-breakpoint
CREATE TABLE `n8n_poll_claims` (
	`tenant_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`claim_owner` text NOT NULL,
	`claim_expires_at` text NOT NULL,
	`last_poll_started_at` text,
	`last_poll_finished_at` text,
	`consecutive_failures` integer NOT NULL DEFAULT 0,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `workflow_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	CHECK (`consecutive_failures` >= 0)
);
