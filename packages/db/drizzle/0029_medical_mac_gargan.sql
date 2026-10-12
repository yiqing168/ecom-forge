DROP INDEX "provider_channels_identity_unique";--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "protocol_family" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "api_variant" text;--> statement-breakpoint
ALTER TABLE "provider_channels" ADD COLUMN "base_url" text;--> statement-breakpoint
UPDATE "provider_channels" SET "base_url" = CASE WHEN "provider" = 'fake' THEN 'https://local.invalid' ELSE 'https://legacy.invalid' END WHERE "base_url" IS NULL;--> statement-breakpoint
ALTER TABLE "provider_channels" ALTER COLUMN "base_url" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_channels_identity_unique" ON "provider_channels" USING btree ("provider","adapter_key","endpoint_profile_key","region_key","base_url");--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_protocol_variant_valid" CHECK ((
        ("models"."protocol_family" is null and "models"."api_variant" is null)
        or (
          "models"."protocol_family" in ('openai', 'anthropic')
          and "models"."api_variant" in ('openai_chat_completions', 'openai_responses', 'anthropic_messages', 'openai_images')
          and (
            ("models"."protocol_family" = 'openai' and "models"."api_variant" in ('openai_chat_completions', 'openai_responses', 'openai_images'))
            or ("models"."protocol_family" = 'anthropic' and "models"."api_variant" = 'anthropic_messages')
          )
          and ("models"."api_variant" <> 'openai_images' or "models"."capability_contract_json"->>'media_kind' = 'image')
        )
      ));--> statement-breakpoint
ALTER TABLE "provider_channels" ADD CONSTRAINT "provider_channels_base_url_https" CHECK ("provider_channels"."base_url" like 'https://%');
