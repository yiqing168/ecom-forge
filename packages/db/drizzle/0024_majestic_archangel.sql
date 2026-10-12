ALTER TABLE "invite_codes" ADD COLUMN "code_ciphertext" text;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "code_nonce" text;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "code_auth_tag" text;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "code_encryption_key_id" text;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_encryption_fields_together" CHECK (num_nonnulls("invite_codes"."code_ciphertext", "invite_codes"."code_nonce", "invite_codes"."code_auth_tag", "invite_codes"."code_encryption_key_id") in (0, 4));