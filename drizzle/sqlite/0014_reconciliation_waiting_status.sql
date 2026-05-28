-- Allow domain `waiting` status alongside legacy `ignored`.
-- Historical rows with match_status='ignored' were in-delay waiting; convert them.
CREATE TABLE `reconciliation_items_new` (
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
	CHECK (`match_status` IN ('matched', 'missing', 'duplicate', 'late', 'ignored', 'waiting'))
);
--> statement-breakpoint
INSERT INTO `reconciliation_items_new` (
	`id`,
	`tenant_id`,
	`reconciliation_run_id`,
	`source_identifier_hash`,
	`destination_identifier_hash`,
	`match_status`,
	`source_observed_at`,
	`destination_observed_at`,
	`metadata_json_sanitized`
)
SELECT
	`id`,
	`tenant_id`,
	`reconciliation_run_id`,
	`source_identifier_hash`,
	`destination_identifier_hash`,
	CASE WHEN `match_status` = 'ignored' THEN 'waiting' ELSE `match_status` END,
	`source_observed_at`,
	`destination_observed_at`,
	`metadata_json_sanitized`
FROM `reconciliation_items`;
--> statement-breakpoint
DROP TABLE `reconciliation_items`;
--> statement-breakpoint
ALTER TABLE `reconciliation_items_new` RENAME TO `reconciliation_items`;
--> statement-breakpoint
CREATE INDEX `reconciliation_items_run_idx`
ON `reconciliation_items` (`tenant_id`, `reconciliation_run_id`);
--> statement-breakpoint
CREATE INDEX `reconciliation_items_hash_idx`
ON `reconciliation_items` (`tenant_id`, `source_identifier_hash`);
