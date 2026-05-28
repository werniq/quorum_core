CREATE TABLE `admin_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_username_uidx` ON `admin_users` (`username`);
--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` text NOT NULL,
	`csrf_token` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users`(`id`)
);
--> statement-breakpoint
CREATE INDEX `admin_sessions_user_idx` ON `admin_sessions` (`admin_user_id`);
--> statement-breakpoint
CREATE TABLE `setup_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbound_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`destination` text NOT NULL,
	`last_attempt_at` text,
	`last_attempt_status` text,
	`last_error_summary` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CHECK (`kind` IN ('n8n', 'webhook', 'smtp'))
);
--> statement-breakpoint
CREATE INDEX `outbound_destinations_tenant_idx` ON `outbound_destinations` (`tenant_id`);
--> statement-breakpoint
CREATE TABLE `onboarding_state` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`step` text NOT NULL,
	`monitoring_method_choice` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CHECK (`step` IN (
		'create_admin', 'choose_method', 'select_workflows', 'define_contracts',
		'review_evidence', 'configure_alerts', 'activate', 'catalog'
	)),
	CHECK (`monitoring_method_choice` IS NULL OR `monitoring_method_choice` IN ('push', 'poll'))
);
--> statement-breakpoint
CREATE TABLE `login_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_started_at` text NOT NULL,
	`attempt_count` integer NOT NULL,
	CHECK (`attempt_count` >= 0)
);
