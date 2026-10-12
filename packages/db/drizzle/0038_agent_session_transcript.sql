CREATE TABLE "agent_transcript_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" uuid,
	"continuation_no" integer,
	"sequence_no" bigint NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"item_type" text NOT NULL,
	"source_key" text NOT NULL,
	"source_message_id" uuid,
	"source_trace_step_id" uuid,
	"import_attempt_id" uuid,
	"reply_to_item_id" uuid,
	"call_ordinal" integer,
	"payload_json" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"resource_dependencies_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_transcript_items_sequence_positive" CHECK ("agent_transcript_items"."sequence_no" > 0),
	CONSTRAINT "agent_transcript_items_schema_version_valid" CHECK ("agent_transcript_items"."schema_version" = 1),
	CONSTRAINT "agent_transcript_items_type_valid" CHECK ("agent_transcript_items"."item_type" in ('user_message','assistant_output','tool_result','host_context','legacy_message')),
	CONSTRAINT "agent_transcript_items_turn_scope_valid" CHECK ((("agent_transcript_items"."item_type" = 'legacy_message' and
            ("agent_transcript_items"."continuation_no" is null or ("agent_transcript_items"."turn_id" is not null and "agent_transcript_items"."continuation_no" > 0)))
          or ("agent_transcript_items"."turn_id" is not null and "agent_transcript_items"."continuation_no" is not null and "agent_transcript_items"."continuation_no" > 0))
        and (("agent_transcript_items"."item_type" = 'legacy_message') = ("agent_transcript_items"."import_attempt_id" is not null))),
	CONSTRAINT "agent_transcript_items_reply_pair_valid" CHECK (("agent_transcript_items"."item_type" = 'tool_result' and "agent_transcript_items"."reply_to_item_id" is not null
          and "agent_transcript_items"."call_ordinal" is not null and "agent_transcript_items"."call_ordinal" between 0 and 3)
        or ("agent_transcript_items"."item_type" <> 'tool_result' and "agent_transcript_items"."reply_to_item_id" is null and "agent_transcript_items"."call_ordinal" is null)),
	CONSTRAINT "agent_transcript_items_payload_valid" CHECK (jsonb_typeof("agent_transcript_items"."payload_json") = 'object'
        and jsonb_typeof("agent_transcript_items"."resource_dependencies_json") = 'array'
        and "agent_transcript_items"."payload_digest" ~ '^[a-f0-9]{64}$' and length("agent_transcript_items"."source_key") > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_transcript_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" uuid,
	"import_attempt_id" uuid,
	"kind" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"content_json" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_transcript_payloads_schema_version_valid" CHECK ("agent_transcript_payloads"."schema_version" = 1),
	CONSTRAINT "agent_transcript_payloads_kind_valid" CHECK ("agent_transcript_payloads"."kind" in ('planning','authoring','tool','legacy_message')),
	CONSTRAINT "agent_transcript_payloads_import_scope_valid" CHECK (("agent_transcript_payloads"."kind" = 'legacy_message') = ("agent_transcript_payloads"."import_attempt_id" is not null)
        and ("agent_transcript_payloads"."turn_id" is not null or "agent_transcript_payloads"."kind" = 'legacy_message')),
	CONSTRAINT "agent_transcript_payloads_content_valid" CHECK (jsonb_typeof("agent_transcript_payloads"."content_json") = 'object'
        and "agent_transcript_payloads"."content_digest" ~ '^[a-f0-9]{64}$'
        and "agent_transcript_payloads"."byte_size" between 1 and 8388608)
);
--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "execution_format" text DEFAULT 'legacy_v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "transcript_capture_version" integer;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "message_history_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "transcript_next_sequence" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "transcript_generation" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "transcript_state_json" jsonb DEFAULT '{"schema_version":1,"mode":"off"}'::jsonb NOT NULL;--> statement-breakpoint
-- Composite owner indexes must exist before their foreign keys are installed.
CREATE UNIQUE INDEX "chat_sessions_id_user_unique" ON "chat_sessions" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turns_id_user_session_unique" ON "agent_turns" USING btree ("id","user_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_items_id_owner_unique" ON "agent_transcript_items" USING btree ("id","user_id","session_id","turn_id");--> statement-breakpoint
ALTER TABLE "agent_transcript_items" ADD CONSTRAINT "agent_transcript_items_session_owner_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."chat_sessions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transcript_items" ADD CONSTRAINT "agent_transcript_items_turn_owner_fk" FOREIGN KEY ("turn_id","user_id","session_id") REFERENCES "public"."agent_turns"("id","user_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transcript_items" ADD CONSTRAINT "agent_transcript_items_reply_owner_fk" FOREIGN KEY ("reply_to_item_id","user_id","session_id","turn_id") REFERENCES "public"."agent_transcript_items"("id","user_id","session_id","turn_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transcript_payloads" ADD CONSTRAINT "agent_transcript_payloads_session_owner_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."chat_sessions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transcript_payloads" ADD CONSTRAINT "agent_transcript_payloads_turn_owner_fk" FOREIGN KEY ("turn_id","user_id","session_id") REFERENCES "public"."agent_turns"("id","user_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_items_session_sequence_unique" ON "agent_transcript_items" USING btree ("session_id","sequence_no");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_items_session_source_unique" ON "agent_transcript_items" USING btree ("session_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_items_reply_ordinal_unique" ON "agent_transcript_items" USING btree ("reply_to_item_id","call_ordinal") WHERE "agent_transcript_items"."item_type" = 'tool_result';--> statement-breakpoint
CREATE INDEX "agent_transcript_items_session_import_idx" ON "agent_transcript_items" USING btree ("session_id","import_attempt_id");--> statement-breakpoint
CREATE INDEX "agent_transcript_items_resource_dependencies_idx" ON "agent_transcript_items" USING gin ("resource_dependencies_json" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_payloads_native_digest_unique" ON "agent_transcript_payloads" USING btree ("turn_id","kind","content_digest") WHERE "agent_transcript_payloads"."import_attempt_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transcript_payloads_import_digest_unique" ON "agent_transcript_payloads" USING btree ("session_id","import_attempt_id","content_digest") WHERE "agent_transcript_payloads"."import_attempt_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_transcript_payloads_session_import_idx" ON "agent_transcript_payloads" USING btree ("session_id","import_attempt_id");--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_execution_format_valid" CHECK ("agent_turns"."execution_format" in ('legacy_v1','transcript_v1')
        and ("agent_turns"."transcript_capture_version" is null or "agent_turns"."transcript_capture_version" = 1)
        and ("agent_turns"."execution_format" = 'legacy_v1' or "agent_turns"."transcript_capture_version" is not distinct from 1));--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_transcript_counters_valid" CHECK ("chat_sessions"."message_history_revision" >= 0 and "chat_sessions"."transcript_next_sequence" > 0 and "chat_sessions"."transcript_generation" > 0);--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_transcript_state_valid" CHECK ((jsonb_typeof("chat_sessions"."transcript_state_json") = 'object'
        and "chat_sessions"."transcript_state_json"->'schema_version' = '1'::jsonb
        and "chat_sessions"."transcript_state_json"->>'mode' in ('off','backfill','shadow','active','invalid')) is true);
