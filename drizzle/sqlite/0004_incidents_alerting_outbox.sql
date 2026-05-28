CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text,
	`contract_kind` text NOT NULL,
	`workflow_id` text,
	`outcome_contract_id` text,
	`incident_type` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` text NOT NULL,
	`acknowledged_at` text,
	`resolved_at` text,
	`last_observed_at` text NOT NULL,
	`last_notified_at` text,
	`notification_count` integer NOT NULL,
	`summary` text NOT NULL,
	`details_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	CHECK (`contract_kind` IN ('workflow', 'outcome', 'system')),
	CHECK (`incident_type` IN (
		'hard_failure', 'silent_absence', 'empty_result', 'malformed_heartbeat',
		'missing_destination_records', 'partial_delivery', 'connector_unavailable',
		'schema_drift', 'watcher_failure', 'alert_delivery_failure'
	)),
	CHECK (`severity` IN ('warning', 'critical')),
	CHECK (`status` IN ('open', 'acknowledged', 'resolved')),
	CHECK (`notification_count` >= 0),
	CHECK (
		(`contract_kind` = 'workflow' AND `workflow_id` IS NOT NULL AND `outcome_contract_id` IS NULL)
		OR (`contract_kind` = 'outcome' AND `outcome_contract_id` IS NOT NULL AND `workflow_id` IS NULL)
		OR (`contract_kind` = 'system' AND `workflow_id` IS NULL AND `outcome_contract_id` IS NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_one_unresolved_uidx`
ON `incidents` (
	`tenant_id`,
	`contract_kind`,
	COALESCE(`workflow_id`, `outcome_contract_id`, ''),
	`incident_type`
)
WHERE `status` IN ('open', 'acknowledged');
--> statement-breakpoint
CREATE TABLE `alert_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`encrypted_config` text NOT NULL,
	`is_active` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CHECK (`type` IN ('webhook', 'email'))
);
--> statement-breakpoint
CREATE TABLE `contract_alert_channels` (
	`tenant_id` text NOT NULL,
	`contract_kind` text NOT NULL,
	`contract_id` text NOT NULL,
	`alert_channel_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `contract_kind`, `contract_id`, `alert_channel_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`alert_channel_id`) REFERENCES `alert_channels`(`id`),
	CHECK (`contract_kind` IN ('workflow', 'outcome', 'system'))
);
--> statement-breakpoint
CREATE TABLE `alert_channel_states` (
	`tenant_id` text NOT NULL,
	`alert_channel_id` text NOT NULL,
	`current_health` text NOT NULL,
	`last_tested_at` text,
	`last_success_at` text,
	`last_failure_at` text,
	`consecutive_failures` integer NOT NULL,
	`last_error_code` text,
	`last_error_message_sanitized` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `alert_channel_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`alert_channel_id`) REFERENCES `alert_channels`(`id`),
	CHECK (`current_health` IN ('unknown', 'healthy', 'degraded', 'failing')),
	CHECK (`consecutive_failures` >= 0)
);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`incident_id` text,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`available_at` text NOT NULL,
	`claimed_at` text,
	`claim_expires_at` text,
	`processed_at` text,
	`attempt_count` integer NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`),
	CHECK (`event_type` IN ('opened', 'renotification', 'acknowledged', 'resolved', 'channel_test')),
	CHECK (`attempt_count` >= 0),
	CHECK (
		(`event_type` = 'channel_test' AND `incident_id` IS NULL)
		OR (`event_type` != 'channel_test' AND `incident_id` IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE TABLE `notification_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`incident_id` text,
	`alert_channel_id` text NOT NULL,
	`outbox_id` text NOT NULL,
	`status` text NOT NULL,
	`attempted_at` text NOT NULL,
	`delivered_at` text,
	`external_message_id` text,
	`external_thread_id` text,
	`response_status_code` integer,
	`error_code` text,
	`error_message_sanitized` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`),
	FOREIGN KEY (`alert_channel_id`) REFERENCES `alert_channels`(`id`),
	FOREIGN KEY (`outbox_id`) REFERENCES `notification_outbox`(`id`),
	CHECK (`status` IN ('pending', 'sent', 'failed'))
);
