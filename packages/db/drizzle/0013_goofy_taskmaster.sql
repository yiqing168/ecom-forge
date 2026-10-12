CREATE TYPE "public"."provider_callback_status" AS ENUM('queued', 'processing', 'processed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."provider_circuit_scope" AS ENUM('provider', 'model');--> statement-breakpoint
CREATE TYPE "public"."provider_circuit_status" AS ENUM('closed', 'open', 'half_open');--> statement-breakpoint
CREATE TABLE "provider_callback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"dedup_key" text NOT NULL,
	"provider_event_id_hint" text,
	"provider_request_id" text,
	"task_attempt_id" uuid,
	"status" "provider_callback_status" DEFAULT 'queued' NOT NULL,
	"normalized_payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signature_key_id" text NOT NULL,
	"body_digest" text NOT NULL,
	"error_code" text,
	"processing_count" integer DEFAULT 0 NOT NULL,
	"next_process_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "provider_callback_events_processing_nonnegative" CHECK ("provider_callback_events"."processing_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_circuit_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" "provider_circuit_scope" NOT NULL,
	"scope_key" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" uuid,
	"status" "provider_circuit_status" DEFAULT 'closed' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"reason_code" text,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"unknown_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"probe_after" timestamp with time zone,
	"probe_owner" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_circuit_states_revision_nonnegative" CHECK ("provider_circuit_states"."revision" >= 0),
	CONSTRAINT "provider_circuit_states_counts_nonnegative" CHECK ("provider_circuit_states"."sample_count" >= 0 and "provider_circuit_states"."failure_count" >= 0 and "provider_circuit_states"."unknown_count" >= 0),
	CONSTRAINT "provider_circuit_states_model_scope" CHECK (("provider_circuit_states"."scope_type" = 'model' and "provider_circuit_states"."model_id" is not null) or ("provider_circuit_states"."scope_type" = 'provider' and "provider_circuit_states"."model_id" is null))
);
--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "next_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD COLUMN "poll_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_callback_events" ADD CONSTRAINT "provider_callback_events_task_attempt_id_task_attempts_id_fk" FOREIGN KEY ("task_attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_circuit_states" ADD CONSTRAINT "provider_circuit_states_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_callback_events_provider_dedup_unique" ON "provider_callback_events" USING btree ("provider","dedup_key");--> statement-breakpoint
CREATE INDEX "provider_callback_events_status_next_process_idx" ON "provider_callback_events" USING btree ("status","next_process_at");--> statement-breakpoint
CREATE INDEX "provider_callback_events_provider_request_idx" ON "provider_callback_events" USING btree ("provider","provider_request_id");--> statement-breakpoint
CREATE INDEX "provider_callback_events_attempt_received_idx" ON "provider_callback_events" USING btree ("task_attempt_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_circuit_states_scope_key_unique" ON "provider_circuit_states" USING btree ("scope_key");--> statement-breakpoint
CREATE INDEX "provider_circuit_states_status_probe_idx" ON "provider_circuit_states" USING btree ("status","probe_after");--> statement-breakpoint
CREATE INDEX "provider_circuit_states_provider_status_idx" ON "provider_circuit_states" USING btree ("provider","status");--> statement-breakpoint
CREATE INDEX "task_attempts_poll_recovery_idx" ON "task_attempts" USING btree ("status","next_poll_at") WHERE "task_attempts"."status" in ('accepted', 'polling');--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_poll_count_nonnegative" CHECK ("task_attempts"."poll_count" >= 0);