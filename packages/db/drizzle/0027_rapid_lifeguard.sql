CREATE TABLE "agent_session_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_mutations_operation_valid" CHECK ("agent_session_mutations"."operation" in ('rename','archive'))
);
--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "model_selection_snapshot_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "model_selection_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "generation_preferences_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "generation_preferences_hash" text;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_session_mutations" ADD CONSTRAINT "agent_session_mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_mutations" ADD CONSTRAINT "agent_session_mutations_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_mutations_user_operation_key_unique" ON "agent_session_mutations" USING btree ("user_id","operation","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "agent_session_mutations_session_created_idx" ON "agent_session_mutations" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_user_archived_updated_id_idx" ON "chat_sessions" USING btree ("user_id","archived_at","updated_at","id");--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_model_selection_pair" CHECK (("agent_turns"."model_selection_snapshot_json" is null) = ("agent_turns"."model_selection_snapshot_hash" is null));--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_generation_preferences_pair" CHECK (("agent_turns"."generation_preferences_json" is null) = ("agent_turns"."generation_preferences_hash" is null));--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_revision_positive" CHECK ("chat_sessions"."revision" > 0);