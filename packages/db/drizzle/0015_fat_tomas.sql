CREATE TYPE "public"."admin_actor_type" AS ENUM('admin_session', 'bootstrap_cli', 'system');--> statement-breakpoint
CREATE TYPE "public"."admin_audit_result" AS ENUM('succeeded', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."agent_confirmation_status" AS ENUM('pending', 'answered', 'expired', 'superseded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_confirmation_type" AS ENUM('clarification', 'product_facts', 'cost', 'risk');--> statement-breakpoint
CREATE TYPE "public"."skill_catalog_release_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."skill_kind" AS ENUM('primary', 'auxiliary');--> statement-breakpoint
CREATE TYPE "public"."skill_package_risk_status" AS ENUM('clear', 'needs_review', 'critical');--> statement-breakpoint
CREATE TYPE "public"."skill_package_status" AS ENUM('quarantined', 'uploaded', 'validating', 'validation_failed', 'ready_for_review', 'approved', 'disabled', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."skill_package_validation_status" AS ENUM('queued', 'running', 'passed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."skill_visibility" AS ENUM('public', 'internal');--> statement-breakpoint
ALTER TYPE "public"."agent_trace_status" ADD VALUE 'cancelled' BEFORE 'superseded';--> statement-breakpoint
ALTER TYPE "public"."skill_resource_type" ADD VALUE 'preset' BEFORE 'reference';--> statement-breakpoint
CREATE TABLE "agent_turn_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"confirmation_no" integer NOT NULL,
	"type" "agent_confirmation_type" NOT NULL,
	"status" "agent_confirmation_status" DEFAULT 'pending' NOT NULL,
	"answer_schema_version" integer NOT NULL,
	"public_payload_json" jsonb NOT NULL,
	"payload_digest" text NOT NULL,
	"answer_json" jsonb,
	"idempotency_key" text,
	"request_hash" text,
	"response_json" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_turn_confirmations_no_positive" CHECK ("agent_turn_confirmations"."confirmation_no" > 0),
	CONSTRAINT "agent_turn_confirmations_schema_positive" CHECK ("agent_turn_confirmations"."answer_schema_version" > 0),
	CONSTRAINT "agent_turn_confirmations_answered_fields" CHECK (("agent_turn_confirmations"."status" = 'answered' and "agent_turn_confirmations"."answer_json" is not null and "agent_turn_confirmations"."idempotency_key" is not null and "agent_turn_confirmations"."request_hash" is not null and "agent_turn_confirmations"."response_json" is not null and "agent_turn_confirmations"."answered_at" is not null) or ("agent_turn_confirmations"."status" <> 'answered' and "agent_turn_confirmations"."answer_json" is null and "agent_turn_confirmations"."idempotency_key" is null and "agent_turn_confirmations"."request_hash" is null and "agent_turn_confirmations"."response_json" is null and "agent_turn_confirmations"."answered_at" is null))
);
--> statement-breakpoint
CREATE TABLE "skill_catalog_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_no" integer NOT NULL,
	"status" "skill_catalog_release_status" DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"base_release_id" uuid,
	"rollback_of_release_id" uuid,
	"release_digest" text NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"approved_by" text,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_catalog_releases_no_positive" CHECK ("skill_catalog_releases"."release_no" > 0),
	CONSTRAINT "skill_catalog_releases_revision_positive" CHECK ("skill_catalog_releases"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "skill_catalog_state" (
	"id" text PRIMARY KEY NOT NULL,
	"active_release_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_package_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_record_id" uuid NOT NULL,
	"resource_path" text NOT NULL,
	"resource_type" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"skill_id" text,
	"rights_metadata_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_package_resources_size_positive" CHECK ("skill_package_resources"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "skill_package_validation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_record_id" uuid NOT NULL,
	"package_revision" integer NOT NULL,
	"package_digest" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" "skill_package_validation_status" DEFAULT 'queued' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"validator_contract_version" text NOT NULL,
	"platform_eval_suite_digest" text NOT NULL,
	"report_json" jsonb,
	"report_digest" text,
	"queue_intent_id" uuid,
	"processing_owner" text,
	"processing_lease_expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_package_validation_attempt_positive" CHECK ("skill_package_validation_reports"."attempt_no" > 0),
	CONSTRAINT "skill_package_validation_revision_positive" CHECK ("skill_package_validation_reports"."revision" > 0),
	CONSTRAINT "skill_package_validation_package_revision_positive" CHECK ("skill_package_validation_reports"."package_revision" > 0),
	CONSTRAINT "skill_package_validation_owner_lease_pair" CHECK (("skill_package_validation_reports"."processing_owner" is null) = ("skill_package_validation_reports"."processing_lease_expires_at" is null)),
	CONSTRAINT "skill_package_validation_running_owner" CHECK (("skill_package_validation_reports"."status" = 'running' and "skill_package_validation_reports"."processing_owner" is not null) or ("skill_package_validation_reports"."status" <> 'running' and "skill_package_validation_reports"."processing_owner" is null)),
	CONSTRAINT "skill_package_validation_terminal_report" CHECK (("skill_package_validation_reports"."status" in ('passed','failed','cancelled') and "skill_package_validation_reports"."report_json" is not null and "skill_package_validation_reports"."report_digest" is not null and "skill_package_validation_reports"."completed_at" is not null) or ("skill_package_validation_reports"."status" in ('queued','running') and "skill_package_validation_reports"."report_json" is null and "skill_package_validation_reports"."report_digest" is null and "skill_package_validation_reports"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "skill_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" text,
	"package_version" text,
	"package_digest" text,
	"archive_sha256" text,
	"manifest_json" jsonb,
	"status" "skill_package_status" DEFAULT 'quarantined' NOT NULL,
	"risk_status" "skill_package_risk_status" DEFAULT 'clear' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_locator_digest" text,
	"source_commit" text,
	"license_summary_json" jsonb,
	"quarantine_storage_key" text NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"uploaded_by" text,
	"latest_validation_report_id" uuid,
	"approved_validation_report_id" uuid,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"risk_review_due_at" timestamp with time zone,
	"risk_blocked_at" timestamp with time zone,
	"disabled_by" text,
	"disabled_reason" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_packages_revision_positive" CHECK ("skill_packages"."revision" > 0),
	CONSTRAINT "skill_packages_identity_pair" CHECK (("skill_packages"."package_id" is null) = ("skill_packages"."package_version" is null))
);
--> statement-breakpoint
ALTER TABLE "agent_traces" DROP CONSTRAINT "agent_traces_usage_nonnegative";--> statement-breakpoint
DROP INDEX "agent_traces_turn_idx";--> statement-breakpoint
DROP INDEX "skill_resource_snapshots_version_unique";--> statement-breakpoint
DROP INDEX "agent_trace_steps_tool_args_created_idx";--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "actor_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "actor_type" "admin_actor_type";--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "admin_session_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "permission_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "source_ip_hash" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "user_agent_hash" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "mfa_level" text;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "step_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "result" "admin_audit_result";--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "agent_trace_steps" ADD COLUMN "call_position_key" text;--> statement-breakpoint
ALTER TABLE "agent_trace_steps" ADD COLUMN "tool_fingerprint" text;--> statement-breakpoint
ALTER TABLE "agent_trace_steps" ADD COLUMN "operation_key" text;--> statement-breakpoint
ALTER TABLE "agent_trace_steps" ADD COLUMN "model_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_trace_steps" ADD COLUMN "model_snapshot_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "brain_model_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "brain_model_snapshot_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD COLUMN "reserved_cost" numeric(18, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "continuation_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "primary_skill_id" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "skill_selection_snapshot_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "skill_selection_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "create_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "create_request_hash" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "create_response_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "interrupt_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "interrupt_request_hash" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "interrupt_response_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "context_snapshot_json" jsonb;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "context_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "processing_owner" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "summary_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "summary_through_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_resource_snapshots" ADD COLUMN "package_resource_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_resource_snapshots" ADD COLUMN "content_text" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "kind" "skill_kind";--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "visibility" "skill_visibility";--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "package_record_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "skill_digest" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "definition_hash" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_turn_confirmations" ADD CONSTRAINT "agent_turn_confirmations_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn_confirmations" ADD CONSTRAINT "agent_turn_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_catalog_releases" ADD CONSTRAINT "skill_catalog_releases_base_release_id_skill_catalog_releases_id_fk" FOREIGN KEY ("base_release_id") REFERENCES "public"."skill_catalog_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_catalog_releases" ADD CONSTRAINT "skill_catalog_releases_rollback_of_release_id_skill_catalog_releases_id_fk" FOREIGN KEY ("rollback_of_release_id") REFERENCES "public"."skill_catalog_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_catalog_state" ADD CONSTRAINT "skill_catalog_state_active_release_id_skill_catalog_releases_id_fk" FOREIGN KEY ("active_release_id") REFERENCES "public"."skill_catalog_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_package_resources" ADD CONSTRAINT "skill_package_resources_package_record_id_skill_packages_id_fk" FOREIGN KEY ("package_record_id") REFERENCES "public"."skill_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_package_validation_reports" ADD CONSTRAINT "skill_package_validation_reports_package_record_id_skill_packages_id_fk" FOREIGN KEY ("package_record_id") REFERENCES "public"."skill_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_package_validation_reports" ADD CONSTRAINT "skill_package_validation_reports_queue_intent_id_queue_dispatch_intents_id_fk" FOREIGN KEY ("queue_intent_id") REFERENCES "public"."queue_dispatch_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_latest_validation_report_id_skill_package_validation_reports_id_fk" FOREIGN KEY ("latest_validation_report_id") REFERENCES "public"."skill_package_validation_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_packages" ADD CONSTRAINT "skill_packages_approved_validation_report_id_skill_package_validation_reports_id_fk" FOREIGN KEY ("approved_validation_report_id") REFERENCES "public"."skill_package_validation_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turn_confirmations_turn_no_unique" ON "agent_turn_confirmations" USING btree ("turn_id","confirmation_no");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turn_confirmations_user_key_unique" ON "agent_turn_confirmations" USING btree ("user_id","idempotency_key") WHERE "agent_turn_confirmations"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "agent_turn_confirmations_status_expires_idx" ON "agent_turn_confirmations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "agent_turn_confirmations_turn_created_idx" ON "agent_turn_confirmations" USING btree ("turn_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_catalog_releases_no_unique" ON "skill_catalog_releases" USING btree ("release_no");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_catalog_releases_digest_unique" ON "skill_catalog_releases" USING btree ("release_digest");--> statement-breakpoint
CREATE INDEX "skill_catalog_releases_status_created_idx" ON "skill_catalog_releases" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_package_resources_path_unique" ON "skill_package_resources" USING btree ("package_record_id","resource_path");--> statement-breakpoint
CREATE INDEX "skill_package_resources_hash_idx" ON "skill_package_resources" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_package_validation_attempt_unique" ON "skill_package_validation_reports" USING btree ("package_record_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_package_validation_digest_unique" ON "skill_package_validation_reports" USING btree ("package_record_id","report_digest") WHERE "skill_package_validation_reports"."report_digest" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_package_validation_intent_unique" ON "skill_package_validation_reports" USING btree ("queue_intent_id");--> statement-breakpoint
CREATE INDEX "skill_package_validation_status_lease_idx" ON "skill_package_validation_reports" USING btree ("status","processing_lease_expires_at");--> statement-breakpoint
CREATE INDEX "skill_package_validation_package_created_idx" ON "skill_package_validation_reports" USING btree ("package_record_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_packages_identity_unique" ON "skill_packages" USING btree ("package_id","package_version") WHERE "skill_packages"."package_id" is not null and "skill_packages"."package_version" is not null;--> statement-breakpoint
CREATE INDEX "skill_packages_status_created_idx" ON "skill_packages" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "skill_packages_risk_due_idx" ON "skill_packages" USING btree ("risk_status","risk_review_due_at");--> statement-breakpoint
ALTER TABLE "agent_trace_steps" ADD CONSTRAINT "agent_trace_steps_model_snapshot_id_models_id_fk" FOREIGN KEY ("model_snapshot_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_brain_model_snapshot_id_models_id_fk" FOREIGN KEY ("brain_model_snapshot_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_primary_skill_id_skills_id_fk" FOREIGN KEY ("primary_skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_summary_through_turn_id_agent_turns_id_fk" FOREIGN KEY ("summary_through_turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_resource_snapshots" ADD CONSTRAINT "skill_resource_snapshots_package_resource_id_skill_package_resources_id_fk" FOREIGN KEY ("package_resource_id") REFERENCES "public"."skill_package_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_package_record_id_skill_packages_id_fk" FOREIGN KEY ("package_record_id") REFERENCES "public"."skill_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_logs_admin_actor_created_idx" ON "admin_audit_logs" USING btree ("actor_admin_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_trace_steps_trace_position_unique" ON "agent_trace_steps" USING btree ("trace_id","call_position_key") WHERE "agent_trace_steps"."call_position_key" is not null;--> statement-breakpoint
CREATE INDEX "agent_trace_steps_operation_key_idx" ON "agent_trace_steps" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_traces_turn_unique" ON "agent_traces" USING btree ("turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turns_user_create_key_unique" ON "agent_turns" USING btree ("user_id","create_idempotency_key") WHERE "agent_turns"."create_idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turns_user_interrupt_key_unique" ON "agent_turns" USING btree ("user_id","interrupt_idempotency_key") WHERE "agent_turns"."interrupt_idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turns_session_active_unique" ON "agent_turns" USING btree ("session_id") WHERE "agent_turns"."workflow_run_id" is null and "agent_turns"."status" not in ('done','blocked','failed','cancelled','superseded');--> statement-breakpoint
CREATE UNIQUE INDEX "skill_resource_snapshots_skill_path_unique" ON "skill_resource_snapshots" USING btree ("skill_id","resource_path");--> statement-breakpoint
CREATE INDEX "agent_trace_steps_tool_args_created_idx" ON "agent_trace_steps" USING btree ("tool_name","tool_fingerprint","created_at");--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_usage_nonnegative" CHECK ("agent_traces"."input_token_total" >= 0 and "agent_traces"."output_token_total" >= 0 and "agent_traces"."estimated_cost" >= 0 and "agent_traces"."reserved_cost" >= 0);--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_revision_positive" CHECK ("agent_turns"."revision" > 0);--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_continuation_positive" CHECK ("agent_turns"."continuation_no" > 0);--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_processing_lease_pair" CHECK (("agent_turns"."processing_owner" is null) = ("agent_turns"."processing_lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_skill_selection_triplet" CHECK (("agent_turns"."primary_skill_id" is null) = ("agent_turns"."skill_selection_snapshot_json" is null) and ("agent_turns"."primary_skill_id" is null) = ("agent_turns"."skill_selection_snapshot_hash" is null));--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_create_idempotency_triplet" CHECK (("agent_turns"."create_idempotency_key" is null) = ("agent_turns"."create_request_hash" is null) and ("agent_turns"."create_idempotency_key" is null) = ("agent_turns"."create_response_json" is null));--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_interrupt_idempotency_triplet" CHECK (("agent_turns"."interrupt_idempotency_key" is null) = ("agent_turns"."interrupt_request_hash" is null) and ("agent_turns"."interrupt_idempotency_key" is null) = ("agent_turns"."interrupt_response_json" is null));--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_context_pair" CHECK (("agent_turns"."context_snapshot_json" is null) = ("agent_turns"."context_snapshot_hash" is null));