ALTER TABLE "onboarding_state" ADD COLUMN "draft_json" text;
--> statement-breakpoint
ALTER TABLE "onboarding_state" DROP CONSTRAINT "onboarding_state_step_check";
--> statement-breakpoint
ALTER TABLE "onboarding_state" ADD CONSTRAINT "onboarding_state_step_check" CHECK ("step" IN (
  'create_admin', 'choose_method', 'select_workflows', 'define_contracts',
  'review_evidence', 'configure_alerts', 'activate', 'catalog',
  'client', 'connect_n8n', 'configure_monitoring', 'alerts_activate', 'complete'
));
--> statement-breakpoint
UPDATE "onboarding_state" SET "step" = 'client' WHERE "step" IN ('create_admin', 'choose_method');
--> statement-breakpoint
UPDATE "onboarding_state" SET "step" = 'configure_monitoring' WHERE "step" IN ('define_contracts', 'review_evidence');
--> statement-breakpoint
UPDATE "onboarding_state" SET "step" = 'alerts_activate' WHERE "step" IN ('configure_alerts', 'activate');
