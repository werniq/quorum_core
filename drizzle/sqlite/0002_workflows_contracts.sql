CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text,
	`name` text NOT NULL,
	`source_platform` text NOT NULL,
	`external_workflow_id` text NOT NULL,
	`description` text,
	`monitoring_method` text NOT NULL,
	`is_active` integer NOT NULL,
	`monitoring_started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`),
	CHECK (`source_platform` IN ('n8n')),
	CHECK (`monitoring_method` IN ('push', 'poll'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_tenant_external_uidx` ON `workflows` (`tenant_id`, `source_platform`, `external_workflow_id`);
--> statement-breakpoint
CREATE TABLE `workflow_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`name` text NOT NULL,
	`business_purpose` text NOT NULL,
	`contract_type` text NOT NULL,
	`cadence_type` text NOT NULL,
	`cadence_value` text NOT NULL,
	`interval_mode` text,
	`schedule_anchor_at` text,
	`timezone` text,
	`allowed_lateness_minutes` integer NOT NULL,
	`max_quiet_window_minutes` integer,
	`initial_grace_minutes` integer NOT NULL,
	`empty_result_policy` text NOT NULL,
	`count_less_success_allowed` integer NOT NULL,
	`notification_backoff_minutes` integer DEFAULT 240 NOT NULL,
	`evidence_level` text NOT NULL,
	`schema_version` integer NOT NULL,
	`is_active` integer NOT NULL,
	`activated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	CHECK (`contract_type` IN ('heartbeat')),
	CHECK (`cadence_type` IN ('interval', 'cron', 'event_driven')),
	CHECK (`interval_mode` IS NULL OR `interval_mode` IN ('fixed_rate', 'since_last_success')),
	CHECK (`empty_result_policy` IN ('allowed', 'warning', 'failure')),
	CHECK (`evidence_level` IN ('basic', 'medium', 'high'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_contracts_one_active_heartbeat_uidx`
ON `workflow_contracts` (`workflow_id`)
WHERE `is_active` = 1 AND `contract_type` = 'heartbeat';
