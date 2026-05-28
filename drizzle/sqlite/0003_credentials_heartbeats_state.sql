CREATE TABLE `workflow_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`key_id` text NOT NULL,
	`encrypted_secret_or_verification_material` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`rotated_from_id` text,
	`revoked_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	FOREIGN KEY (`rotated_from_id`) REFERENCES `workflow_credentials`(`id`),
	CHECK (`status` IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_credentials_tenant_key_id_uidx`
ON `workflow_credentials` (`tenant_id`, `key_id`);
--> statement-breakpoint
CREATE TABLE `ingestion_rate_limit_states` (
	`tenant_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`window_started_at` text NOT NULL,
	`accepted_count` integer NOT NULL,
	`rejected_count` integer NOT NULL,
	`last_rejected_at` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `workflow_id`, `credential_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	FOREIGN KEY (`credential_id`) REFERENCES `workflow_credentials`(`id`),
	CHECK (`accepted_count` >= 0),
	CHECK (`rejected_count` >= 0)
);
--> statement-breakpoint
CREATE TABLE `heartbeat_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`received_at` text NOT NULL,
	`executed_at` text NOT NULL,
	`status` text NOT NULL,
	`items_processed` integer,
	`external_execution_ref` text,
	`idempotency_key` text NOT NULL,
	`payload_schema_version` integer NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	CHECK (`status` IN ('success', 'failure', 'empty_result')),
	CHECK (`items_processed` IS NULL OR `items_processed` >= 0),
	CHECK (`metadata_json` IS NULL OR length(`metadata_json`) <= 8192)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `heartbeat_events_workflow_idempotency_uidx`
ON `heartbeat_events` (`workflow_id`, `idempotency_key`);
--> statement-breakpoint
CREATE TRIGGER `heartbeat_events_immutable_update`
BEFORE UPDATE ON `heartbeat_events`
BEGIN
	SELECT RAISE(ABORT, 'heartbeat_events are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `heartbeat_events_immutable_delete`
BEFORE DELETE ON `heartbeat_events`
BEGIN
	SELECT RAISE(ABORT, 'heartbeat_events are immutable');
END;
--> statement-breakpoint
CREATE TABLE `workflow_states` (
	`tenant_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`last_execution_at` text,
	`last_nonempty_success_at` text,
	`last_acceptable_success_at` text,
	`last_failure_at` text,
	`last_external_execution_ref` text,
	`last_status` text NOT NULL,
	`next_expected_at` text,
	`overdue_since` text,
	`current_health` text NOT NULL,
	`evidence_level` text NOT NULL,
	`evidence_summary_code` text,
	`unverified_dimensions_json` text,
	`consecutive_stale_checks` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY (`tenant_id`, `workflow_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`),
	CHECK (`last_status` IN ('success', 'failure', 'empty_result', 'unknown')),
	CHECK (`current_health` IN ('healthy', 'warning', 'overdue', 'unknown', 'inactive')),
	CHECK (`evidence_level` IN ('basic', 'medium', 'high')),
	CHECK (`consecutive_stale_checks` >= 0),
	CHECK (`unverified_dimensions_json` IS NULL OR length(`unverified_dimensions_json`) <= 8192)
);
