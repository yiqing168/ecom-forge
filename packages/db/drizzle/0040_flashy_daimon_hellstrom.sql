ALTER TABLE "models" DROP CONSTRAINT "models_protocol_variant_valid";--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_protocol_variant_valid" CHECK ((
        ("models"."protocol_family" is null and "models"."api_variant" is null)
        or (
          "models"."protocol_family" in ('openai', 'anthropic', 'google')
          and "models"."api_variant" in ('openai_chat_completions', 'openai_responses', 'anthropic_messages', 'google_generate_content', 'openai_images')
          and (
            ("models"."protocol_family" = 'openai' and "models"."api_variant" in ('openai_chat_completions', 'openai_responses', 'openai_images'))
            or ("models"."protocol_family" = 'anthropic' and "models"."api_variant" = 'anthropic_messages')
            or ("models"."protocol_family" = 'google' and "models"."api_variant" = 'google_generate_content' and "models"."capability_contract_json"->>'contract_kind' = 'agent_brain')
          )
          and ("models"."api_variant" <> 'openai_images' or "models"."capability_contract_json"->>'media_kind' = 'image')
        )
      ));