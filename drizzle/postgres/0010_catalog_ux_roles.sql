ALTER TABLE "admin_users" ADD COLUMN "role" text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_role_check" CHECK ("role" IN ('admin', 'viewer'));
