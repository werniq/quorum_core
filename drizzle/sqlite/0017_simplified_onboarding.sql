ALTER TABLE `onboarding_state` ADD COLUMN `draft_json` text;
--> statement-breakpoint
CREATE TABLE `onboarding_state_new` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`step` text NOT NULL,
	`monitoring_method_choice` text,
	`completed_at` text,
	`updated_at` text NOT NULL,
	`draft_json` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
	CHECK (`step` IN (
		'create_admin', 'choose_method', 'select_workflows', 'define_contracts',
		'review_evidence', 'configure_alerts', 'activate', 'catalog',
		'client', 'connect_n8n', 'configure_monitoring', 'alerts_activate', 'complete'
	)),
	CHECK (`monitoring_method_choice` IS NULL OR `monitoring_method_choice` IN ('push', 'poll'))
);
--> statement-breakpoint
INSERT INTO `onboarding_state_new` (
  `tenant_id`, `step`, `monitoring_method_choice`, `completed_at`, `updated_at`, `draft_json`
)
SELECT
  `tenant_id`,
  CASE
    WHEN `step` IN ('create_admin', 'choose_method') THEN 'client'
    WHEN `step` IN ('define_contracts', 'review_evidence') THEN 'configure_monitoring'
    WHEN `step` IN ('configure_alerts', 'activate') THEN 'alerts_activate'
    ELSE `step`
  END,
  `monitoring_method_choice`,
  `completed_at`,
  `updated_at`,
  `draft_json`
FROM `onboarding_state`;
--> statement-breakpoint
DROP TABLE `onboarding_state`;
--> statement-breakpoint
ALTER TABLE `onboarding_state_new` RENAME TO `onboarding_state`;
