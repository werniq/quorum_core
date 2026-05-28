CREATE TABLE `contract_volume_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workflow_contract_id` text NOT NULL,
	`minimum_count` integer NOT NULL,
	`maximum_count` integer,
	`window_type` text NOT NULL,
	`timezone` text NOT NULL,
	`week_starts_on` integer,
	`evaluation_grace_minutes` integer NOT NULL,
	`violation_severity` text NOT NULL,
	`is_active` integer NOT NULL DEFAULT 1,
	`activated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_contract_id`) REFERENCES `workflow_contracts`(`id`),
	CHECK (`minimum_count` >= 0),
	CHECK (`maximum_count` IS NULL OR `maximum_count` >= `minimum_count`),
	CHECK (`window_type` IN ('daily', 'weekly', 'monthly')),
	CHECK (`evaluation_grace_minutes` >= 0 AND `evaluation_grace_minutes` <= 1440),
	CHECK (`violation_severity` IN ('warning', 'critical')),
	CHECK (`week_starts_on` IS NULL OR (`week_starts_on` >= 0 AND `week_starts_on` <= 6))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_volume_rules_active_dedupe_uidx`
ON `contract_volume_rules` (
	`tenant_id`,
	`workflow_contract_id`,
	`window_type`,
	`minimum_count`,
	COALESCE(`maximum_count`, -1),
	`timezone`,
	COALESCE(`week_starts_on`, -1)
)
WHERE `is_active` = 1;
--> statement-breakpoint
CREATE TABLE `volume_band_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`workflow_contract_id` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`evaluated_at` text,
	`total_items` integer,
	`counted_events` integer NOT NULL DEFAULT 0,
	`unknown_count_events` integer NOT NULL DEFAULT 0,
	`result` text NOT NULL,
	`minimum_count` integer NOT NULL,
	`maximum_count` integer,
	`is_finalized` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`rule_id`) REFERENCES `contract_volume_rules`(`id`),
	FOREIGN KEY (`workflow_contract_id`) REFERENCES `workflow_contracts`(`id`),
	CHECK (`minimum_count` >= 0),
	CHECK (`maximum_count` IS NULL OR `maximum_count` >= `minimum_count`),
	CHECK (`result` IN ('collecting', 'within_band', 'below_minimum', 'above_maximum', 'inconclusive')),
	CHECK (`counted_events` >= 0),
	CHECK (`unknown_count_events` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `volume_band_evaluations_rule_window_uidx`
ON `volume_band_evaluations` (`tenant_id`, `rule_id`, `window_start`);
--> statement-breakpoint
CREATE TABLE `volume_evaluation_claims` (
	`tenant_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`window_start` text NOT NULL,
	`claim_owner` text NOT NULL,
	`claim_expires_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `rule_id`, `window_start`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`rule_id`) REFERENCES `contract_volume_rules`(`id`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `incidents_new` (
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
INSERT INTO `incidents_new` (
	`id`, `tenant_id`, `client_id`, `contract_kind`, `workflow_id`, `outcome_contract_id`,
	`incident_type`, `severity`, `status`, `opened_at`, `acknowledged_at`, `resolved_at`,
	`last_observed_at`, `last_notified_at`, `notification_count`, `summary`, `details_json`,
	`volume_rule_id`, `volume_window_start`, `assignee_user_id`, `resolution_note`,
	`client_safe_resolution_note`, `response_target_minutes`, `resolution_target_minutes`,
	`created_at`, `updated_at`
)
SELECT
	`id`, `tenant_id`, `client_id`, `contract_kind`, `workflow_id`, `outcome_contract_id`,
	`incident_type`, `severity`, `status`, `opened_at`, `acknowledged_at`, `resolved_at`,
	`last_observed_at`, `last_notified_at`, `notification_count`, `summary`, `details_json`,
	NULL, NULL, NULL, NULL, NULL, NULL, NULL,
	`created_at`, `updated_at`
FROM `incidents`;
--> statement-breakpoint
DROP TABLE `incidents`;
--> statement-breakpoint
ALTER TABLE `incidents_new` RENAME TO `incidents`;
--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_one_unresolved_standard_uidx`
ON `incidents` (
	`tenant_id`,
	`contract_kind`,
	COALESCE(`workflow_id`, `outcome_contract_id`, ''),
	`incident_type`
)
WHERE `status` IN ('open', 'acknowledged')
AND `incident_type` NOT IN ('volume_below_minimum', 'volume_above_maximum');
--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_one_unresolved_volume_uidx`
ON `incidents` (
	`tenant_id`,
	`workflow_id`,
	`volume_rule_id`,
	`volume_window_start`,
	`incident_type`
)
WHERE `status` IN ('open', 'acknowledged')
AND `incident_type` IN ('volume_below_minimum', 'volume_above_maximum')
AND `volume_rule_id` IS NOT NULL
AND `volume_window_start` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `incident_audit_events_new` (
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
	CHECK (`event_type` IN (
		'acknowledged', 'resolved', 'assigned', 'severity_changed', 'resolution_note_updated'
	)),
	CHECK (`edition` IN ('self_hosted', 'saas'))
);
--> statement-breakpoint
INSERT INTO `incident_audit_events_new` (
	`id`, `tenant_id`, `incident_id`, `event_type`, `actor`, `edition`, `details_json`, `created_at`
)
SELECT
	`id`, `tenant_id`, `incident_id`, `event_type`, `actor`, `edition`, `details_json`, `created_at`
FROM `incident_audit_events`;
--> statement-breakpoint
DROP TABLE `incident_audit_events`;
--> statement-breakpoint
ALTER TABLE `incident_audit_events_new` RENAME TO `incident_audit_events`;
--> statement-breakpoint
CREATE INDEX `incident_audit_events_tenant_incident_idx`
ON `incident_audit_events` (`tenant_id`, `incident_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
