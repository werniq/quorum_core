ALTER TABLE `workflow_contracts` ADD COLUMN `empty_result_breach_threshold` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `workflow_contracts` ADD COLUMN `source_watermark_required` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `workflow_states` ADD COLUMN `consecutive_empty_results` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `workflow_states` ADD COLUMN `last_source_watermark` text;
--> statement-breakpoint
ALTER TABLE `workflow_states` ADD COLUMN `consecutive_stale_watermarks` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `incidents_watchdog_new` (
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
	`notification_count` integer NOT NULL DEFAULT 0,
	`summary` text NOT NULL,
	`details_json` text,
	`volume_rule_id` text,
	`volume_window_start` text,
	`assignee_user_id` text,
	`resolution_note` text,
	`client_safe_resolution_note` text,
	`response_target_minutes` integer,
	`resolution_target_minutes` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	FOREIGN KEY (`volume_rule_id`) REFERENCES `contract_volume_rules`(`id`),
	CHECK (`contract_kind` IN ('workflow', 'outcome', 'system')),
	CHECK (`incident_type` IN (
		'hard_failure', 'silent_absence', 'empty_result', 'malformed_heartbeat',
		'volume_below_minimum', 'volume_above_maximum',
		'missing_destination_records', 'partial_delivery', 'connector_unavailable',
		'schema_drift', 'watcher_failure', 'alert_delivery_failure', 'freshness_stale'
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
INSERT INTO `incidents_watchdog_new` SELECT * FROM `incidents`;
--> statement-breakpoint
DROP TABLE `incidents`;
--> statement-breakpoint
ALTER TABLE `incidents_watchdog_new` RENAME TO `incidents`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `incidents_one_unresolved_standard_uidx`
ON `incidents` (
	`tenant_id`,
	`contract_kind`,
	COALESCE(`workflow_id`, `outcome_contract_id`, ''),
	`incident_type`
)
WHERE `status` IN ('open', 'acknowledged')
AND `incident_type` NOT IN ('volume_below_minimum', 'volume_above_maximum');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `incidents_one_unresolved_volume_uidx`
ON `incidents` (
	`tenant_id`,
	`workflow_id`,
	`volume_rule_id`,
	`volume_window_start`,
	`incident_type`
)
WHERE `status` IN ('open', 'acknowledged')
AND `incident_type` IN ('volume_below_minimum', 'volume_above_maximum');
