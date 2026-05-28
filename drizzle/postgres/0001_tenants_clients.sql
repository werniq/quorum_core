CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"edition" text NOT NULL,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "tenants_edition_check" CHECK ("edition" IN ('self_hosted', 'saas'))
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"protection_started_at" timestamptz,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id"),
	CONSTRAINT "clients_status_check" CHECK ("status" IN ('onboarding', 'protected', 'paused', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_slug_uidx" ON "clients" USING btree ("tenant_id","slug");
