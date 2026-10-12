CREATE TYPE "public"."asset_status" AS ENUM('uploading', 'processing', 'ready', 'processing_failed', 'rejected', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."asset_upload_status" AS ENUM('pending', 'completed', 'expired', 'rejected');--> statement-breakpoint
CREATE TABLE "asset_upload_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"status" "asset_upload_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"declared_mime_type" text NOT NULL,
	"max_size_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_upload_intents_max_size_positive" CHECK ("asset_upload_intents"."max_size_bytes" > 0),
	CONSTRAINT "asset_upload_intents_completed_pair" CHECK (("asset_upload_intents"."status" = 'completed') = ("asset_upload_intents"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "mime_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "display_name" text DEFAULT '未命名素材' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "thumbnail_key" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "meta_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "status" "asset_status" DEFAULT 'uploading' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "processing_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "processing_error_code" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "product_fact_sets" ADD COLUMN "version_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_upload_intents" ADD CONSTRAINT "asset_upload_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_upload_intents" ADD CONSTRAINT "asset_upload_intents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_upload_intents_user_key_unique" ON "asset_upload_intents" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_upload_intents_asset_unique" ON "asset_upload_intents" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_upload_intents_status_expires_idx" ON "asset_upload_intents" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "assets_user_status_created_idx" ON "assets" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_user_source_artifact_active_unique" ON "assets" USING btree ("user_id","source_artifact_id") WHERE "assets"."source_artifact_id" is not null and "assets"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_fact_sets_product_version_unique" ON "product_fact_sets" USING btree ("product_id","version_no");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_processing_revision_positive" CHECK ("assets"."processing_revision" > 0);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_deleted_pair" CHECK (("assets"."status" = 'deleted') = ("assets"."deleted_at" is not null));--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_ready_fields" CHECK ("assets"."status" <> 'ready' or ("assets"."content_hash" is not null and "assets"."mime_type" is not null and "assets"."thumbnail_key" is not null));--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_origin_shape" CHECK (("assets"."kind" = 'upload' and "assets"."origin" = 'upload' and "assets"."source_artifact_id" is null) or ("assets"."kind" = 'generated' and "assets"."origin" in ('creative_artifact','commerce_artifact') and "assets"."source_artifact_id" is not null) or "assets"."kind" = 'imported');--> statement-breakpoint
ALTER TABLE "product_fact_sets" ADD CONSTRAINT "product_fact_sets_version_positive" CHECK ("product_fact_sets"."version_no" > 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_revision_positive" CHECK ("products"."revision" > 0);