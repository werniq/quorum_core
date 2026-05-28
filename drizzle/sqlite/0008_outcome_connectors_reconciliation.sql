CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text,
	`provider` text NOT NULL,
	`connector_type` text NOT NULL,
	`name` text NOT NULL,
	`encrypted_credentials` text NOT NULL,
	`status` text NOT NULL,
	`last_health_check_at` text,
	`last_success_at` text,
	`last_error_code` text,
	`last_error_summary` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`),
	CHECK (`provider` IN ('hubspot', 'zoom')),
	CHECK (`connector_type` IN ('source', 'destination')),
	CHECK (`status` IN ('pending', 'active', 'invalid', 'disconnected', 'paused'))
);
--> statement-breakpoint
CREATE INDEX `connectors_tenant_idx` ON `connectors` (`tenant_id`);
--> statement-breakpoint
CREATE INDEX `connectors_tenant_provider_idx` ON `connectors` (`tenant_id`, `provider`);
--> statement-breakpoint
CREATE TABLE `outcome_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text,
	`name` text NOT NULL,
	`business_purpose` text NOT NULL,
	`contract_type` text NOT NULL,
	`source_connector_id` text NOT NULL,
	`destination_connector_id` text NOT NULL,
	`source_object_type` text NOT NULL,
	`destination_object_type` text NOT NULL,
	`match_key_definition` text NOT NULL,
	`source_time_field` text NOT NULL,
	`destination_time_field` text NOT NULL,
	`maximum_delivery_delay_minutes` integer NOT NULL,
	`acceptable_missing_count` integer NOT NULL,
	`acceptable_missing_percentage` real NOT NULL,
	`schedule_expression` text NOT NULL,
	`timezone` text NOT NULL,
	`evidence_level_target` text NOT NULL,
	`retention_days` integer NOT NULL,
	`is_active` integer NOT NULL,
	`activated_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`),
	FOREIGN KEY (`source_connector_id`) REFERENCES `connectors`(`id`),
	FOREIGN KEY (`destination_connector_id`) REFERENCES `connectors`(`id`),
	CHECK (`contract_type` IN ('reconciliation', 'aggregate_check')),
	CHECK (`evidence_level_target` IN ('medium', 'high')),
	CHECK (`maximum_delivery_delay_minutes` >= 0),
	CHECK (`acceptable_missing_count` >= 0),
	CHECK (`acceptable_missing_percentage` >= 0 AND `acceptable_missing_percentage` <= 100),
	CHECK (`retention_days` > 0),
	CHECK (`is_active` IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `outcome_contracts_tenant_idx` ON `outcome_contracts` (`tenant_id`);
--> statement-breakpoint
CREATE INDEX `outcome_contracts_tenant_active_idx` ON `outcome_contracts` (`tenant_id`, `is_active`);
--> statement-breakpoint
CREATE TABLE `reconciliation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`outcome_contract_id` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`source_count` integer NOT NULL,
	`destination_count` integer NOT NULL,
	`matched_count` integer NOT NULL,
	`missing_count` integer NOT NULL,
	`duplicate_count` integer NOT NULL,
	`late_count` integer NOT NULL,
	`status` text NOT NULL,
	`evidence_level_achieved` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`details_location_or_json` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`outcome_contract_id`) REFERENCES `outcome_contracts`(`id`),
	CHECK (`status` IN ('running', 'healthy', 'warning', 'failed', 'unknown')),
	CHECK (`evidence_level_achieved` IN ('medium', 'high')),
	CHECK (`source_count` >= 0),
	CHECK (`destination_count` >= 0),
	CHECK (`matched_count` >= 0),
	CHECK (`missing_count` >= 0),
	CHECK (`duplicate_count` >= 0),
	CHECK (`late_count` >= 0)
);
--> statement-breakpoint
CREATE INDEX `reconciliation_runs_tenant_contract_idx`
ON `reconciliation_runs` (`tenant_id`, `outcome_contract_id`, `started_at`);
--> statement-breakpoint
CREATE TABLE `reconciliation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`reconciliation_run_id` text NOT NULL,
	`source_identifier_hash` text NOT NULL,
	`destination_identifier_hash` text,
	`match_status` text NOT NULL,
	`source_observed_at` text,
	`destination_observed_at` text,
	`metadata_json_sanitized` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`reconciliation_run_id`) REFERENCES `reconciliation_runs`(`id`),
	CHECK (`match_status` IN ('matched', 'missing', 'duplicate', 'late', 'ignored'))
);
--> statement-breakpoint
CREATE INDEX `reconciliation_items_run_idx`
ON `reconciliation_items` (`tenant_id`, `reconciliation_run_id`);
--> statement-breakpoint
CREATE INDEX `reconciliation_items_hash_idx`
ON `reconciliation_items` (`tenant_id`, `source_identifier_hash`);
