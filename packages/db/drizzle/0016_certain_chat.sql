CREATE TYPE "public"."run_quote_submission_mode" AS ENUM('auto_submit', 'confirmation_required');--> statement-breakpoint
DROP INDEX "run_quotes_active_input_unique";--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "execution_authorization_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "execution_authorization_hash" text;--> statement-breakpoint
ALTER TABLE "run_quotes" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "run_quotes" ADD COLUMN "submission_mode" "run_quote_submission_mode";--> statement-breakpoint
ALTER TABLE "run_quotes" ADD COLUMN "plan_digest" text;--> statement-breakpoint
ALTER TABLE "run_quotes" ADD COLUMN "authorization_digest" text;--> statement-breakpoint
CREATE UNIQUE INDEX "run_quotes_active_chat_source_unique" ON "run_quotes" USING btree ("source","source_id") WHERE "run_quotes"."source" = 'chat' and "run_quotes"."source_id" is not null and "run_quotes"."status" in ('quoted','submitted');--> statement-breakpoint
CREATE INDEX "run_quotes_status_expires_idx" ON "run_quotes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_quotes_active_input_unique" ON "run_quotes" USING btree ("user_id","source","input_signature") WHERE "run_quotes"."status" in ('quoted','submitted');--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_execution_authorization_pair" CHECK (("agent_turns"."execution_authorization_json" is null) = ("agent_turns"."execution_authorization_hash" is null));--> statement-breakpoint
ALTER TABLE "run_quotes" ADD CONSTRAINT "run_quotes_s09_snapshot_fields" CHECK (("run_quotes"."submission_mode" is null and "run_quotes"."plan_digest" is null and "run_quotes"."authorization_digest" is null and "run_quotes"."source_id" is null) or ("run_quotes"."submission_mode" is not null and "run_quotes"."plan_digest" is not null and (("run_quotes"."source" = 'chat' and "run_quotes"."source_id" is not null and "run_quotes"."authorization_digest" is not null) or ("run_quotes"."source" <> 'chat' and "run_quotes"."authorization_digest" is null))));
