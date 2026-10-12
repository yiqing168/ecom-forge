CREATE TYPE "public"."agent_trace_actor" AS ENUM('agent', 'compiler', 'tool', 'system', 'user');--> statement-breakpoint
CREATE TYPE "public"."agent_trace_status" AS ENUM('running', 'succeeded', 'failed', 'blocked', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."agent_trace_step_status" AS ENUM('started', 'succeeded', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."agent_trace_step_type" AS ENUM('llm_call', 'tool_call', 'compiler_check', 'guardrail', 'observation', 'interrupt');--> statement-breakpoint
CREATE TYPE "public"."agent_turn_status" AS ENUM('received_user_input', 'loading_context', 'detecting_intent', 'validating_context', 'clarifying', 'planning', 'plan_ready', 'waiting_user_confirmation', 'run_quote_created', 'waiting_provider_confirmation', 'done', 'blocked', 'failed', 'cancelled', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."appeal_status" AS ENUM('pending', 'refunded', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."artifact_type" AS ENUM('image', 'video', 'text', 'package');--> statement-breakpoint
CREATE TYPE "public"."artifact_visibility" AS ENUM('private', 'shared', 'public', 'quarantined', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."asset_embedding_status" AS ENUM('draft', 'ready', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('upload', 'generated', 'imported');--> statement-breakpoint
CREATE TYPE "public"."asset_origin" AS ENUM('upload', 'creative_artifact', 'commerce_artifact');--> statement-breakpoint
CREATE TYPE "public"."chat_message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."dispatch_state" AS ENUM('not_dispatched', 'accepted', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."evaluation_status" AS ENUM('pass', 'warning', 'unknown', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."evaluator_type" AS ENUM('platform_spec', 'commerce_evidence', 'content_safety');--> statement-breakpoint
CREATE TYPE "public"."ledger_type" AS ENUM('grant', 'reservation_freeze', 'consume', 'release', 'appeal_refund', 'manual_correction', 'expiry');--> statement-breakpoint
CREATE TYPE "public"."membership_source" AS ENUM('system_grant', 'admin_grant', 'purchase');--> statement-breakpoint
CREATE TYPE "public"."membership_tier" AS ENUM('free', 'pro', 'team');--> statement-breakpoint
CREATE TYPE "public"."model_status" AS ENUM('poc_passed', 'poc_failed', 'disabled', 'free_test_only');--> statement-breakpoint
CREATE TYPE "public"."mutation_owner" AS ENUM('chat_session', 'canvas', 'suite');--> statement-breakpoint
CREATE TYPE "public"."origin_domain" AS ENUM('creative', 'commerce');--> statement-breakpoint
CREATE TYPE "public"."platform_rule_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."producer_mode" AS ENUM('chat', 'canvas', 'suite');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."referral_reward_status" AS ENUM('pending', 'granted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('created', 'frozen', 'partially_settled', 'settled', 'releasing', 'released', 'correction_required');--> statement-breakpoint
CREATE TYPE "public"."retention_tier" AS ENUM('critical', 'normal', 'debug');--> statement-breakpoint
CREATE TYPE "public"."risk_decision" AS ENUM('confirmed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_quote_status" AS ENUM('quoted', 'submitted', 'superseded', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."share_report_reason" AS ENUM('infringement', 'illegal', 'sexual', 'fraud', 'privacy', 'other');--> statement-breakpoint
CREATE TYPE "public"."share_report_status" AS ENUM('open', 'reviewing', 'dismissed', 'actioned');--> statement-breakpoint
CREATE TYPE "public"."skill_resource_type" AS ENUM('catalog', 'planning_view', 'reference', 'eval_dataset');--> statement-breakpoint
CREATE TYPE "public"."skill_status" AS ENUM('draft', 'published', 'disabled', 'archived');--> statement-breakpoint
CREATE TYPE "public"."source_action" AS ENUM('generate', 'edit', 'replace');--> statement-breakpoint
CREATE TYPE "public"."task_attempt_status" AS ENUM('created', 'dispatching', 'accepted', 'polling', 'succeeded', 'failed', 'timeout', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked', 'waiting_manual_review');--> statement-breakpoint
CREATE TYPE "public"."template_type" AS ENUM('recipe', 'canvas');--> statement-breakpoint
CREATE TYPE "public"."template_unlock_type" AS ENUM('free', 'credits', 'membership');--> statement-breakpoint
CREATE TYPE "public"."trigger_mode" AS ENUM('chat', 'canvas', 'suite');--> statement-breakpoint
CREATE TYPE "public"."user_activity_type" AS ENUM('login', 'logout', 'download', 'share_view', 'fact_confirm', 'asset_upload', 'export');--> statement-breakpoint
CREATE TYPE "public"."user_risk_status" AS ENUM('normal', 'frozen', 'limited');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin', 'operator');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('healthy', 'draining', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."workflow_run_status" AS ENUM('reserved', 'queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled', 'refunding', 'refunded', 'disputed');--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"before_json" jsonb,
	"after_json" jsonb,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_trace_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"step_no" integer NOT NULL,
	"step_type" "agent_trace_step_type" NOT NULL,
	"actor" "agent_trace_actor" NOT NULL,
	"skill_id" text,
	"tool_name" text,
	"args_hash" text,
	"input_summary" jsonb NOT NULL,
	"output_summary" jsonb NOT NULL,
	"status" "agent_trace_step_status" NOT NULL,
	"error_code" text,
	"latency_ms" integer,
	"token_usage_json" jsonb,
	"estimated_cost" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_trace_steps_step_positive" CHECK ("agent_trace_steps"."step_no" > 0),
	CONSTRAINT "agent_trace_steps_latency_nonnegative" CHECK ("agent_trace_steps"."latency_ms" is null or "agent_trace_steps"."latency_ms" >= 0),
	CONSTRAINT "agent_trace_steps_cost_nonnegative" CHECK ("agent_trace_steps"."estimated_cost" is null or "agent_trace_steps"."estimated_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"brain_model_id" text NOT NULL,
	"skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "agent_trace_status" DEFAULT 'running' NOT NULL,
	"input_token_total" integer DEFAULT 0 NOT NULL,
	"output_token_total" integer DEFAULT 0 NOT NULL,
	"estimated_cost" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"loop_guardrail_hit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "agent_traces_usage_nonnegative" CHECK ("agent_traces"."input_token_total" >= 0 and "agent_traces"."output_token_total" >= 0 and "agent_traces"."estimated_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "agent_turn_status" DEFAULT 'received_user_input' NOT NULL,
	"run_quote_id" uuid,
	"workflow_run_id" uuid,
	"superseded_by_turn_id" uuid,
	"interrupted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"screenshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "appeal_status" DEFAULT 'pending' NOT NULL,
	"refund_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"reviewer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "appeals_refund_nonnegative" CHECK ("appeals"."refund_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "artifact_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"evaluator_type" "evaluator_type" NOT NULL,
	"evaluator_version" text NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"findings_json" jsonb NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"status" "evaluation_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_evaluations_confidence_range" CHECK ("artifact_evaluations"."confidence" >= 0 and "artifact_evaluations"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid,
	"type" "artifact_type" NOT NULL,
	"storage_key" text NOT NULL,
	"thumbnail_key" text,
	"meta_json" jsonb NOT NULL,
	"params_snapshot" jsonb NOT NULL,
	"source_artifact_id" uuid,
	"source_action" "source_action" NOT NULL,
	"canvas_node_id" uuid,
	"origin_domain" "origin_domain" NOT NULL,
	"producer_mode" "producer_mode" NOT NULL,
	"producer_session_id" uuid,
	"mutation_owner" "mutation_owner" NOT NULL,
	"visibility" "artifact_visibility" DEFAULT 'quarantined' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"embedding_model" text NOT NULL,
	"vector" jsonb NOT NULL,
	"status" "asset_embedding_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_folder_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid,
	"folder_id" uuid,
	"storage_key" text NOT NULL,
	"file_size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"origin" "asset_origin" NOT NULL,
	"source_artifact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "assets_file_size_nonnegative" CHECK ("assets"."file_size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"graph_json" jsonb NOT NULL,
	"thumbnail_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "chat_message_role" NOT NULL,
	"content" text NOT NULL,
	"turn_id" uuid,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skill_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_approval" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"todo_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_preview" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"frozen" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_accounts_nonnegative" CHECK ("credit_accounts"."balance" >= 0 and "credit_accounts"."frozen" >= 0),
	CONSTRAINT "credit_accounts_version_nonnegative" CHECK ("credit_accounts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "ledger_type" NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"reservation_id" uuid,
	"workflow_run_id" uuid,
	"task_id" uuid,
	"appeal_id" uuid,
	"idempotency_key" text NOT NULL,
	"balance_after" numeric(18, 2) NOT NULL,
	"frozen_after" numeric(18, 2) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_snapshots_nonnegative" CHECK ("credit_ledger"."balance_after" >= 0 and "credit_ledger"."frozen_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workflow_run_id" uuid,
	"estimated_amount" numeric(18, 2) NOT NULL,
	"settled_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"released_amount" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"status" "reservation_status" DEFAULT 'created' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_reservations_amounts_nonnegative" CHECK ("credit_reservations"."estimated_amount" >= 0 and "credit_reservations"."settled_amount" >= 0 and "credit_reservations"."released_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"event_seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"retention_tier" "retention_tier" DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_outbox_sequence_nonnegative" CHECK ("event_outbox"."event_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invite_code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone NOT NULL,
	"ledger_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"email_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_uses" integer NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"issued_by" uuid,
	"expires_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_usage_bounds" CHECK ("invite_codes"."max_uses" > 0 and "invite_codes"."used_count" >= 0 and "invite_codes"."used_count" <= "invite_codes"."max_uses")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tier" "membership_tier" DEFAULT 'free' NOT NULL,
	"expires_at" timestamp with time zone,
	"monthly_credit_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "membership_source" DEFAULT 'system_grant' NOT NULL,
	"granted_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"version" text NOT NULL,
	"capability_contract_json" jsonb NOT NULL,
	"pricing_json" jsonb NOT NULL,
	"quota_json" jsonb NOT NULL,
	"status" "model_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canvas_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"artifact_id" uuid,
	"params_snapshot" jsonb NOT NULL,
	"source_action" "source_action" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_versions_version_positive" CHECK ("node_versions"."version_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_spec_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"country" text NOT NULL,
	"image_type" text NOT NULL,
	"rules_json" jsonb NOT NULL,
	"source" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"version" text NOT NULL,
	"status" "platform_rule_status" DEFAULT 'draft' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_fact_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid,
	"source_asset_id" uuid NOT NULL,
	"facts_json" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid NOT NULL,
	"source_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sku_code" text,
	"name" text NOT NULL,
	"primary_asset_id" uuid,
	"latest_fact_set_id" uuid,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_id" uuid NOT NULL,
	"invitee_id" uuid NOT NULL,
	"invite_code_id" uuid,
	"reward_status" "referral_reward_status" DEFAULT 'pending' NOT NULL,
	"fraud_flag" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" "risk_decision" NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" "trigger_mode" NOT NULL,
	"product_id" uuid,
	"workflow_run_id" uuid,
	"status" "run_quote_status" DEFAULT 'quoted' NOT NULL,
	"prompt_preview" jsonb NOT NULL,
	"estimated_call_count" integer NOT NULL,
	"estimated_total_credits" numeric(18, 2) NOT NULL,
	"has_unknown_price" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_signature" text NOT NULL,
	"confirmation_snapshot" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_quotes_call_count_nonnegative" CHECK ("run_quotes"."estimated_call_count" >= 0),
	CONSTRAINT "run_quotes_estimated_credits_nonnegative" CHECK ("run_quotes"."estimated_total_credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "share_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_id" uuid NOT NULL,
	"reporter_user_id" uuid,
	"reason" "share_report_reason" NOT NULL,
	"description" text,
	"status" "share_report_status" DEFAULT 'open' NOT NULL,
	"ip_hash" text NOT NULL,
	"decided_by" uuid,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"allow_remix" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"convert_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_counts_nonnegative" CHECK ("shares"."view_count" >= 0 and "shares"."convert_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_resource_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" text NOT NULL,
	"resource_path" text NOT NULL,
	"resource_type" "skill_resource_type" NOT NULL,
	"content_hash" text NOT NULL,
	"kv_key" text NOT NULL,
	"summary_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"domain" "origin_domain" NOT NULL,
	"stage" text NOT NULL,
	"version" text NOT NULL,
	"definition_json" jsonb NOT NULL,
	"price" jsonb NOT NULL,
	"status" "skill_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" "task_attempt_status" DEFAULT 'created' NOT NULL,
	"dispatch_state" "dispatch_state" DEFAULT 'not_dispatched' NOT NULL,
	"provider" text NOT NULL,
	"provider_request_id" text,
	"provider_receipt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_reported_cost" numeric(18, 2),
	"raw_error_summary" jsonb,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "task_attempts_attempt_positive" CHECK ("task_attempts"."attempt_no" > 0),
	CONSTRAINT "task_attempts_provider_cost_nonnegative" CHECK ("task_attempts"."provider_reported_cost" is null or "task_attempts"."provider_reported_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"type" text NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"model_id" uuid,
	"model_version" text,
	"cost_estimate" numeric(18, 2) NOT NULL,
	"cost_actual" numeric(18, 2),
	"idempotency_key" text NOT NULL,
	"dag_node_id" text NOT NULL,
	"dag_json" jsonb NOT NULL,
	"params_snapshot" jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "tasks_cost_estimate_nonnegative" CHECK ("tasks"."cost_estimate" >= 0),
	CONSTRAINT "tasks_cost_actual_nonnegative" CHECK ("tasks"."cost_actual" is null or "tasks"."cost_actual" >= 0)
);
--> statement-breakpoint
CREATE TABLE "template_unlocks" (
	"user_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"unlocked_at" timestamp with time zone NOT NULL,
	"ledger_id" uuid,
	CONSTRAINT "template_unlocks_user_id_template_id_pk" PRIMARY KEY("user_id","template_id")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "template_type" NOT NULL,
	"version" text NOT NULL,
	"definition_snapshot" jsonb NOT NULL,
	"cover" text,
	"category" text NOT NULL,
	"unlock_type" "template_unlock_type" DEFAULT 'free' NOT NULL,
	"price" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_price_nonnegative" CHECK ("templates"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"activity_type" "user_activity_type" NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"preference_key" text NOT NULL,
	"preference_value" jsonb NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"display_name" varchar(120) NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"risk_status" "user_risk_status" DEFAULT 'normal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_type" text NOT NULL,
	"status" "worker_status" DEFAULT 'healthy' NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid,
	"trigger_mode" "trigger_mode" NOT NULL,
	"run_quote_id" uuid,
	"reservation_id" uuid,
	"status" "workflow_run_status" DEFAULT 'reserved' NOT NULL,
	"plan_snapshot" jsonb NOT NULL,
	"skill_snapshot" jsonb NOT NULL,
	"pricing_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "workflow_runs_quote_reservation_pair" CHECK (("workflow_runs"."run_quote_id" is null) = ("workflow_runs"."reservation_id" is null))
);
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trace_steps" ADD CONSTRAINT "agent_trace_steps_trace_id_agent_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."agent_traces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trace_steps" ADD CONSTRAINT "agent_trace_steps_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_run_quote_id_run_quotes_id_fk" FOREIGN KEY ("run_quote_id") REFERENCES "public"."run_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_superseded_by_turn_id_agent_turns_id_fk" FOREIGN KEY ("superseded_by_turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_producer_session_id_chat_sessions_id_fk" FOREIGN KEY ("producer_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_embeddings" ADD CONSTRAINT "asset_embeddings_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_folders" ADD CONSTRAINT "asset_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_folders" ADD CONSTRAINT "asset_folders_parent_folder_id_asset_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "public"."asset_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_folder_id_asset_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."asset_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_appeal_id_appeals_id_fk" FOREIGN KEY ("appeal_id") REFERENCES "public"."appeals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_invite_code_id_invite_codes_id_fk" FOREIGN KEY ("invite_code_id") REFERENCES "public"."invite_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_redemptions" ADD CONSTRAINT "invite_code_redemptions_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_fact_sets" ADD CONSTRAINT "product_fact_sets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_fact_sets" ADD CONSTRAINT "product_fact_sets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_fact_sets" ADD CONSTRAINT "product_fact_sets_source_asset_id_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_fact_sets" ADD CONSTRAINT "product_fact_sets_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_primary_asset_id_assets_id_fk" FOREIGN KEY ("primary_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_latest_fact_set_id_product_fact_sets_id_fk" FOREIGN KEY ("latest_fact_set_id") REFERENCES "public"."product_fact_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invitee_id_users_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invite_code_id_invite_codes_id_fk" FOREIGN KEY ("invite_code_id") REFERENCES "public"."invite_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_confirmations" ADD CONSTRAINT "risk_confirmations_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_confirmations" ADD CONSTRAINT "risk_confirmations_evaluation_id_artifact_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."artifact_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_confirmations" ADD CONSTRAINT "risk_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_quotes" ADD CONSTRAINT "run_quotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_quotes" ADD CONSTRAINT "run_quotes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_quotes" ADD CONSTRAINT "run_quotes_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_reports" ADD CONSTRAINT "share_reports_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_reports" ADD CONSTRAINT "share_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_reports" ADD CONSTRAINT "share_reports_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_resource_snapshots" ADD CONSTRAINT "skill_resource_snapshots_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_unlocks" ADD CONSTRAINT "template_unlocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_unlocks" ADD CONSTRAINT "template_unlocks_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_unlocks" ADD CONSTRAINT "template_unlocks_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_logs" ADD CONSTRAINT "user_activity_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_run_quote_id_run_quotes_id_fk" FOREIGN KEY ("run_quote_id") REFERENCES "public"."run_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_reservation_id_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."credit_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_logs_actor_created_idx" ON "admin_audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_trace_steps_trace_step_unique" ON "agent_trace_steps" USING btree ("trace_id","step_no");--> statement-breakpoint
CREATE INDEX "agent_trace_steps_tool_args_created_idx" ON "agent_trace_steps" USING btree ("tool_name","args_hash","created_at");--> statement-breakpoint
CREATE INDEX "agent_traces_turn_idx" ON "agent_traces" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "agent_traces_user_created_idx" ON "agent_traces" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_turns_session_created_idx" ON "agent_turns" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_turns_user_status_created_idx" ON "agent_turns" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turns_run_quote_unique" ON "agent_turns" USING btree ("run_quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turns_workflow_run_unique" ON "agent_turns" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "appeals_user_created_idx" ON "appeals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "artifact_evaluations_artifact_created_idx" ON "artifact_evaluations" USING btree ("artifact_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_user_product_created_idx" ON "artifacts" USING btree ("user_id","product_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_user_created_idx" ON "artifacts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_storage_key_idx" ON "artifacts" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_embeddings_asset_model_unique" ON "asset_embeddings" USING btree ("asset_id","embedding_model");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_folders_user_parent_name_unique" ON "asset_folders" USING btree ("user_id","parent_folder_id","name");--> statement-breakpoint
CREATE INDEX "assets_storage_key_idx" ON "assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "assets_user_product_created_idx" ON "assets" USING btree ("user_id","product_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_user_folder_created_idx" ON "assets" USING btree ("user_id","folder_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_unique" ON "auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_unique" ON "auth_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "canvases_user_updated_idx" ON "canvases" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_messages_session_created_idx" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_user_updated_idx" ON "chat_sessions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_unique" ON "credit_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_created_idx" ON "credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_workflow_run_idx" ON "credit_ledger" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_workflow_run_unique" ON "credit_reservations" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_idempotency_key_unique" ON "credit_reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "event_outbox_scope_sequence_unique" ON "event_outbox" USING btree ("scope_type","scope_id","event_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_code_redemptions_code_user_unique" ON "invite_code_redemptions" USING btree ("invite_code_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_codes_code_unique" ON "invite_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "models_provider_model_version_unique" ON "models" USING btree ("provider","model_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "node_versions_canvas_node_version_unique" ON "node_versions" USING btree ("canvas_id","node_id","version_no");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_spec_rules_version_unique" ON "platform_spec_rules" USING btree ("platform","country","image_type","version");--> statement-breakpoint
CREATE INDEX "product_fact_sets_product_created_idx" ON "product_fact_sets" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "products_user_updated_idx" ON "products" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "products_user_sku_idx" ON "products" USING btree ("user_id","sku_code");--> statement-breakpoint
CREATE UNIQUE INDEX "products_user_sku_unique" ON "products" USING btree ("user_id","sku_code") WHERE "products"."sku_code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_invitee_unique" ON "referrals" USING btree ("invitee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_quotes_workflow_run_unique" ON "run_quotes" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_quotes_idempotency_key_unique" ON "run_quotes" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "run_quotes_active_input_unique" ON "run_quotes" USING btree ("user_id","source","input_signature") WHERE "run_quotes"."status" in ('quoted', 'submitted');--> statement-breakpoint
CREATE INDEX "share_reports_status_created_idx" ON "share_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "share_reports_share_created_idx" ON "share_reports" USING btree ("share_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_slug_unique" ON "shares" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_resource_snapshots_version_unique" ON "skill_resource_snapshots" USING btree ("skill_id","resource_path","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_slug_version_unique" ON "skills" USING btree ("slug","version");--> statement-breakpoint
CREATE UNIQUE INDEX "task_attempts_task_attempt_unique" ON "task_attempts" USING btree ("task_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "task_attempts_provider_request_unique" ON "task_attempts" USING btree ("provider","provider_request_id") WHERE "task_attempts"."provider_request_id" is not null;--> statement-breakpoint
CREATE INDEX "task_attempts_task_status_idx" ON "task_attempts" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "task_attempts_dispatch_started_idx" ON "task_attempts" USING btree ("dispatch_state","started_at");--> statement-breakpoint
CREATE INDEX "task_attempts_status_ended_idx" ON "task_attempts" USING btree ("status","ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency_key_unique" ON "tasks" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "tasks_workflow_status_idx" ON "tasks" USING btree ("workflow_run_id","status");--> statement-breakpoint
CREATE INDEX "tasks_workflow_dag_node_idx" ON "tasks" USING btree ("workflow_run_id","dag_node_id");--> statement-breakpoint
CREATE INDEX "user_activity_logs_user_type_created_idx" ON "user_activity_logs" USING btree ("user_id","activity_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_user_key_unique" ON "user_preferences" USING btree ("user_id","preference_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_risk_status_idx" ON "users" USING btree ("risk_status");--> statement-breakpoint
CREATE INDEX "worker_heartbeats_type_seen_idx" ON "worker_heartbeats" USING btree ("worker_type","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_run_quote_unique" ON "workflow_runs" USING btree ("run_quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_reservation_unique" ON "workflow_runs" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_user_status_created_idx" ON "workflow_runs" USING btree ("user_id","status","created_at");