CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`edition` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CHECK (`edition` IN ('self_hosted', 'saas'))
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`status` text NOT NULL,
	`protection_started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CHECK (`status` IN ('onboarding', 'protected', 'paused', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_tenant_slug_uidx` ON `clients` (`tenant_id`, `slug`);
