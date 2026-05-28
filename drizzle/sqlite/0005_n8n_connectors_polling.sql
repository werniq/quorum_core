CREATE TABLE `n8n_connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`auth_mode` text NOT NULL,
	`status` text NOT NULL,
	`health` text NOT NULL,
	`last_checked_at` text,
	`last_success_at` text,
	`last_error_code` text,
	`last_error_summary` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CHECK (`auth_mode` IN ('api_key')),
	CHECK (`status` IN ('active', 'disabled')),
	CHECK (`health` IN ('unknown', 'healthy', 'auth_failed', 'unreachable', 'misconfigured'))
);
--> statement-breakpoint
CREATE INDEX `n8n_connectors_tenant_idx`
ON `n8n_connectors` (`tenant_id`);
--> statement-breakpoint
CREATE TABLE `n8n_poll_checkpoints` (
	`tenant_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`last_seen_execution_id` text,
	`last_finished_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `workflow_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	FOREIGN KEY (`connector_id`) REFERENCES `n8n_connectors`(`id`)
);
--> statement-breakpoint
ALTER TABLE `workflows` ADD COLUMN `connector_id` text REFERENCES `n8n_connectors`(`id`);
