CREATE TABLE "model_configurations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"model_snapshot_id" uuid NOT NULL,
	"provider_channel_id" uuid NOT NULL,
	"credential_version_id" uuid NOT NULL,
	"credits_json" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "model_configurations_purpose_valid" CHECK ("model_configurations"."purpose" in ('brain','image','video')),
	CONSTRAINT "model_configurations_status_valid" CHECK ("model_configurations"."status" in ('active','deleted')),
	CONSTRAINT "model_configurations_revision_positive" CHECK ("model_configurations"."revision" > 0)
);
--> statement-breakpoint
DROP INDEX "provider_channels_identity_unique";--> statement-breakpoint
ALTER TABLE "model_configurations" ADD CONSTRAINT "model_configurations_model_snapshot_id_models_id_fk" FOREIGN KEY ("model_snapshot_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configurations" ADD CONSTRAINT "model_configurations_provider_channel_id_provider_channels_id_fk" FOREIGN KEY ("provider_channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configurations" ADD CONSTRAINT "model_configurations_credential_version_id_provider_credential_versions_id_fk" FOREIGN KEY ("credential_version_id") REFERENCES "public"."provider_credential_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configurations" ADD CONSTRAINT "model_configurations_created_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_configurations_snapshot_unique" ON "model_configurations" USING btree ("model_snapshot_id");--> statement-breakpoint
CREATE INDEX "model_configurations_status_updated_idx" ON "model_configurations" USING btree ("status","updated_at");