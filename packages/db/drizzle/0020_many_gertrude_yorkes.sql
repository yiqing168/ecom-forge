CREATE TYPE "public"."admin_auth_challenge_purpose" AS ENUM('enrollment_mfa', 'login_mfa', 'recovery_mfa', 'step_up', 'mfa_rotation');--> statement-breakpoint
CREATE TYPE "public"."admin_auth_challenge_status" AS ENUM('pending', 'consumed', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."admin_credential_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."admin_credential_type" AS ENUM('password', 'totp');--> statement-breakpoint
CREATE TYPE "public"."admin_enrollment_token_status" AS ENUM('issued', 'claimed', 'used', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."admin_principal_status" AS ENUM('pending_enrollment', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."admin_session_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."billable_sku_status" AS ENUM('draft', 'approved', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."invite_campaign_status" AS ENUM('draft', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."model_catalog_category" AS ENUM('brain', 'image', 'video');--> statement-breakpoint
CREATE TYPE "public"."model_catalog_entry_status" AS ENUM('draft', 'approved', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."pricing_catalog_release_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."reward_campaign_kind" AS ENUM('registration', 'invitation');--> statement-breakpoint
CREATE TYPE "public"."reward_campaign_status" AS ENUM('draft', 'active', 'disabled');--> statement-breakpoint
CREATE TABLE "admin_auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_principal_id" uuid NOT NULL,
	"purpose" "admin_auth_challenge_purpose" NOT NULL,
	"challenge_token_hash" text NOT NULL,
	"challenge_key_id" text NOT NULL,
	"identifier_rekey_hash" text,
	"identifier_rekey_key_id" text,
	"status" "admin_auth_challenge_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_auth_challenges_attempt_bounds" CHECK ("admin_auth_challenges"."attempt_count" >= 0 and "admin_auth_challenges"."max_attempts" > 0 and "admin_auth_challenges"."attempt_count" <= "admin_auth_challenges"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "admin_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_principal_id" uuid NOT NULL,
	"credential_type" "admin_credential_type" NOT NULL,
	"credential_public_id" text,
	"password_hash" text,
	"password_hash_metadata" jsonb,
	"secret_ciphertext" text,
	"secret_nonce" text,
	"secret_auth_tag" text,
	"secret_key_id" text,
	"totp_last_used_step" integer,
	"status" "admin_credential_status" DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "admin_credentials_revision_positive" CHECK ("admin_credentials"."revision" > 0),
	CONSTRAINT "admin_credentials_shape" CHECK (("admin_credentials"."credential_type" = 'password' and "admin_credentials"."password_hash" is not null and "admin_credentials"."secret_ciphertext" is null and "admin_credentials"."totp_last_used_step" is null) or ("admin_credentials"."credential_type" = 'totp' and "admin_credentials"."password_hash" is null and "admin_credentials"."secret_ciphertext" is not null and "admin_credentials"."secret_nonce" is not null and "admin_credentials"."secret_auth_tag" is not null and "admin_credentials"."secret_key_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "admin_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_principal_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"status" "admin_enrollment_token_status" DEFAULT 'issued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_admin_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_enrollment_tokens_attempt_bounds" CHECK ("admin_enrollment_tokens"."attempt_count" >= 0 and "admin_enrollment_tokens"."max_attempts" > 0 and "admin_enrollment_tokens"."attempt_count" <= "admin_enrollment_tokens"."max_attempts"),
	CONSTRAINT "admin_enrollment_tokens_revision_positive" CHECK ("admin_enrollment_tokens"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "admin_idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_admin_id" uuid NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"response_status" integer,
	"response_json" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_idempotency_records_status_valid" CHECK ("admin_idempotency_records"."status" in ('pending','completed')),
	CONSTRAINT "admin_idempotency_records_completion_shape" CHECK ("admin_idempotency_records"."status" <> 'completed' or ("admin_idempotency_records"."response_status" is not null and "admin_idempotency_records"."response_json" is not null and "admin_idempotency_records"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "admin_mfa_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_principal_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"key_id" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_hash" text NOT NULL,
	"identifier_key_id" text NOT NULL,
	"identifier_hint" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "admin_principal_status" DEFAULT 'pending_enrollment' NOT NULL,
	"authz_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_principals_authz_version_positive" CHECK ("admin_principals"."authz_version" > 0),
	CONSTRAINT "admin_principals_revision_positive" CHECK ("admin_principals"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "admin_role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_principal_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"scope_type" text DEFAULT 'global' NOT NULL,
	"scope_key" text DEFAULT 'global' NOT NULL,
	"permission_snapshot_hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_principal_id" uuid NOT NULL,
	"session_token_hash" text NOT NULL,
	"session_key_id" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"csrf_key_id" text NOT NULL,
	"status" "admin_session_status" DEFAULT 'active' NOT NULL,
	"authz_version_snapshot" integer NOT NULL,
	"mfa_level" text DEFAULT 'totp' NOT NULL,
	"mfa_verified_at" timestamp with time zone NOT NULL,
	"step_up_at" timestamp with time zone,
	"recovery_restricted" boolean DEFAULT false NOT NULL,
	"source_ip_hash" text,
	"user_agent_hash" text,
	"session_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billable_skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_sku_key" text NOT NULL,
	"version_no" integer NOT NULL,
	"model_catalog_entry_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"matcher_json" jsonb NOT NULL,
	"matcher_hash" text NOT NULL,
	"unit_kind" text NOT NULL,
	"unit_rule_json" jsonb NOT NULL,
	"provider_rate_card_key" text NOT NULL,
	"provider_cost_per_unit_cny" numeric(18, 2) NOT NULL,
	"credits_per_unit" numeric(18, 2) NOT NULL,
	"status" "billable_sku_status" DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billable_skus_version_positive" CHECK ("billable_skus"."version_no" > 0),
	CONSTRAINT "billable_skus_revision_positive" CHECK ("billable_skus"."revision" > 0),
	CONSTRAINT "billable_skus_cost_nonnegative" CHECK ("billable_skus"."provider_cost_per_unit_cny" >= 0),
	CONSTRAINT "billable_skus_credits_nonnegative" CHECK ("billable_skus"."credits_per_unit" >= 0),
	CONSTRAINT "billable_skus_unit_kind_valid" CHECK ("billable_skus"."unit_kind" in ('image','second','segment','megapixel','request','token','included'))
);
--> statement-breakpoint
CREATE TABLE "invite_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_key" text NOT NULL,
	"name" text NOT NULL,
	"status" "invite_campaign_status" DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"issuance_limit" integer NOT NULL,
	"issued_count" integer DEFAULT 0 NOT NULL,
	"default_max_uses" integer NOT NULL,
	"default_validity_seconds" integer,
	"email_constraint_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reward_campaign_id" uuid,
	"internal_note" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "invite_campaigns_issuance_limit_positive" CHECK ("invite_campaigns"."issuance_limit" > 0),
	CONSTRAINT "invite_campaigns_issued_count_bounds" CHECK ("invite_campaigns"."issued_count" >= 0 and "invite_campaigns"."issued_count" <= "invite_campaigns"."issuance_limit"),
	CONSTRAINT "invite_campaigns_default_max_uses_positive" CHECK ("invite_campaigns"."default_max_uses" > 0),
	CONSTRAINT "invite_campaigns_revision_positive" CHECK ("invite_campaigns"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "invite_code_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"settings_snapshot_json" jsonb NOT NULL,
	"settings_digest" text NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_code_batches_count_positive" CHECK ("invite_code_batches"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_snapshot_id" uuid NOT NULL,
	"public_slug" text NOT NULL,
	"version_no" integer NOT NULL,
	"category" "model_catalog_category" NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"public_capabilities_json" jsonb NOT NULL,
	"rollout_json" jsonb DEFAULT '{"stage":"local","percentage":0}'::jsonb NOT NULL,
	"user_selectable" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" "model_catalog_entry_status" DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_entries_version_positive" CHECK ("model_catalog_entries"."version_no" > 0),
	CONSTRAINT "model_catalog_entries_revision_positive" CHECK ("model_catalog_entries"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_poc_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_snapshot_id" uuid NOT NULL,
	"provider_channel_id" uuid NOT NULL,
	"credential_version_id" uuid NOT NULL,
	"probe_suite_version" text NOT NULL,
	"requested_spec_keys_json" jsonb NOT NULL,
	"requested_spec_keys_digest" text NOT NULL,
	"queue_dispatch_intent_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"processing_owner" text,
	"processing_lease_expires_at" timestamp with time zone,
	"evidence_digest" text,
	"result_summary_json" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"requested_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "model_poc_runs_attempt_positive" CHECK ("model_poc_runs"."attempt_no" > 0),
	CONSTRAINT "model_poc_runs_status_valid" CHECK ("model_poc_runs"."status" in ('queued','running','passed','failed','outcome_unknown','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "pricing_catalog_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_no" integer NOT NULL,
	"status" "pricing_catalog_release_status" DEFAULT 'draft' NOT NULL,
	"base_release_id" uuid,
	"manifest_json" jsonb NOT NULL,
	"release_digest" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "pricing_catalog_releases_no_positive" CHECK ("pricing_catalog_releases"."release_no" > 0),
	CONSTRAINT "pricing_catalog_releases_revision_positive" CHECK ("pricing_catalog_releases"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "pricing_catalog_state" (
	"id" text PRIMARY KEY NOT NULL,
	"active_release_id" uuid,
	"catalog_revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"adapter_key" text NOT NULL,
	"display_name" text NOT NULL,
	"endpoint_profile_key" text NOT NULL,
	"region" text,
	"region_key" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"active_credential_version_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "provider_channels_status_valid" CHECK ("provider_channels"."status" in ('draft','active','disabled')),
	CONSTRAINT "provider_channels_region_key_normalized" CHECK ("provider_channels"."region_key" = coalesce("provider_channels"."region", '')),
	CONSTRAINT "provider_channels_revision_positive" CHECK ("provider_channels"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_credential_validation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_channel_id" uuid NOT NULL,
	"credential_version_id" uuid NOT NULL,
	"probe_contract_version" text NOT NULL,
	"queue_dispatch_intent_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"processing_owner" text,
	"processing_lease_expires_at" timestamp with time zone,
	"evidence_digest" text,
	"result_summary_json" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"requested_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "provider_credential_validation_runs_attempt_positive" CHECK ("provider_credential_validation_runs"."attempt_no" > 0),
	CONSTRAINT "provider_credential_validation_runs_status_valid" CHECK ("provider_credential_validation_runs"."status" in ('queued','running','passed','failed','outcome_unknown','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "provider_credential_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_channel_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_nonce" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"secret_key_id" text NOT NULL,
	"key_hint" text NOT NULL,
	"status" text DEFAULT 'pending_validation' NOT NULL,
	"validation_evidence_digest" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "provider_credential_versions_version_positive" CHECK ("provider_credential_versions"."version_no" > 0),
	CONSTRAINT "provider_credential_versions_status_valid" CHECK ("provider_credential_versions"."status" in ('pending_validation','valid','validation_unknown','active','invalid','revoked'))
);
--> statement-breakpoint
CREATE TABLE "reward_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_key" text NOT NULL,
	"version_no" integer NOT NULL,
	"kind" "reward_campaign_kind" NOT NULL,
	"status" "reward_campaign_status" DEFAULT 'draft' NOT NULL,
	"grant_credits" numeric(18, 2) NOT NULL,
	"max_grants" integer NOT NULL,
	"budget_credits" numeric(18, 2) NOT NULL,
	"granted_count" integer DEFAULT 0 NOT NULL,
	"granted_credits" numeric(18, 2) DEFAULT '0.00' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"eligibility_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "reward_campaigns_version_positive" CHECK ("reward_campaigns"."version_no" > 0),
	CONSTRAINT "reward_campaigns_grant_positive" CHECK ("reward_campaigns"."grant_credits" > 0),
	CONSTRAINT "reward_campaigns_max_grants_positive" CHECK ("reward_campaigns"."max_grants" > 0),
	CONSTRAINT "reward_campaigns_budget_nonnegative" CHECK ("reward_campaigns"."budget_credits" >= 0),
	CONSTRAINT "reward_campaigns_projection_bounds" CHECK ("reward_campaigns"."granted_count" >= 0 and "reward_campaigns"."granted_count" <= "reward_campaigns"."max_grants" and "reward_campaigns"."granted_credits" >= 0 and "reward_campaigns"."granted_credits" <= "reward_campaigns"."budget_credits")
);
--> statement-breakpoint
CREATE TABLE "storage_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"adapter_key" text NOT NULL,
	"endpoint_profile_key" text NOT NULL,
	"region" text,
	"region_key" text DEFAULT '' NOT NULL,
	"bucket" text NOT NULL,
	"root_prefix" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"active_credential_version_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "storage_channels_status_valid" CHECK ("storage_channels"."status" in ('draft','active','disabled')),
	CONSTRAINT "storage_channels_region_key_normalized" CHECK ("storage_channels"."region_key" = coalesce("storage_channels"."region", ''))
);
--> statement-breakpoint
CREATE TABLE "storage_credential_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_channel_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"secret_bundle_ciphertext" text NOT NULL,
	"secret_nonce" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"secret_key_id" text NOT NULL,
	"key_hint" text NOT NULL,
	"status" text DEFAULT 'pending_validation' NOT NULL,
	"validation_evidence_digest" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "storage_credential_versions_version_positive" CHECK ("storage_credential_versions"."version_no" > 0),
	CONSTRAINT "storage_credential_versions_status_valid" CHECK ("storage_credential_versions"."status" in ('pending_validation','valid','validation_unknown','active','invalid','revoked'))
);
--> statement-breakpoint
CREATE TABLE "storage_runtime_state" (
	"purpose" text PRIMARY KEY NOT NULL,
	"active_channel_id" uuid,
	"runtime_revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_validation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_channel_id" uuid NOT NULL,
	"credential_version_id" uuid NOT NULL,
	"probe_contract_version" text NOT NULL,
	"queue_dispatch_intent_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"processing_owner" text,
	"processing_lease_expires_at" timestamp with time zone,
	"evidence_digest" text,
	"result_summary_json" jsonb,
	"probe_prefix_digest" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"requested_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "storage_validation_runs_attempt_positive" CHECK ("storage_validation_runs"."attempt_no" > 0),
	CONSTRAINT "storage_validation_runs_status_valid" CHECK ("storage_validation_runs"."status" in ('queued','running','passed','failed','outcome_unknown','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "reviewer_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "decision_reason" text;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "decision_ledger_id" uuid;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN "decision_idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "storage_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_upload_intents" ADD COLUMN "storage_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "storage_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "issued_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "provider_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "registration_reward_claims" ADD COLUMN "reward_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_auth_challenges" ADD CONSTRAINT "admin_auth_challenges_admin_principal_id_admin_principals_id_fk" FOREIGN KEY ("admin_principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD CONSTRAINT "admin_credentials_admin_principal_id_admin_principals_id_fk" FOREIGN KEY ("admin_principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_enrollment_tokens" ADD CONSTRAINT "admin_enrollment_tokens_admin_principal_id_admin_principals_id_fk" FOREIGN KEY ("admin_principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_enrollment_tokens" ADD CONSTRAINT "admin_enrollment_tokens_created_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_idempotency_records" ADD CONSTRAINT "admin_idempotency_records_actor_admin_id_admin_principals_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_mfa_recovery_codes" ADD CONSTRAINT "admin_mfa_recovery_codes_admin_principal_id_admin_principals_id_fk" FOREIGN KEY ("admin_principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_bindings" ADD CONSTRAINT "admin_role_bindings_admin_principal_id_admin_principals_id_fk" FOREIGN KEY ("admin_principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_principal_id_admin_principals_id_fk" FOREIGN KEY ("admin_principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billable_skus" ADD CONSTRAINT "billable_skus_model_catalog_entry_id_model_catalog_entries_id_fk" FOREIGN KEY ("model_catalog_entry_id") REFERENCES "public"."model_catalog_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_campaigns" ADD CONSTRAINT "invite_campaigns_reward_campaign_id_reward_campaigns_id_fk" FOREIGN KEY ("reward_campaign_id") REFERENCES "public"."reward_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_campaigns" ADD CONSTRAINT "invite_campaigns_created_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_batches" ADD CONSTRAINT "invite_code_batches_campaign_id_invite_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."invite_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code_batches" ADD CONSTRAINT "invite_code_batches_created_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_catalog_entries" ADD CONSTRAINT "model_catalog_entries_model_snapshot_id_models_id_fk" FOREIGN KEY ("model_snapshot_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_poc_runs" ADD CONSTRAINT "model_poc_runs_model_snapshot_id_models_id_fk" FOREIGN KEY ("model_snapshot_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_poc_runs" ADD CONSTRAINT "model_poc_runs_provider_channel_id_provider_channels_id_fk" FOREIGN KEY ("provider_channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_poc_runs" ADD CONSTRAINT "model_poc_runs_credential_version_id_provider_credential_versions_id_fk" FOREIGN KEY ("credential_version_id") REFERENCES "public"."provider_credential_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_poc_runs" ADD CONSTRAINT "model_poc_runs_queue_dispatch_intent_id_queue_dispatch_intents_id_fk" FOREIGN KEY ("queue_dispatch_intent_id") REFERENCES "public"."queue_dispatch_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_poc_runs" ADD CONSTRAINT "model_poc_runs_requested_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("requested_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_catalog_releases" ADD CONSTRAINT "pricing_catalog_releases_base_release_id_pricing_catalog_releases_id_fk" FOREIGN KEY ("base_release_id") REFERENCES "public"."pricing_catalog_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_catalog_releases" ADD CONSTRAINT "pricing_catalog_releases_created_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_catalog_state" ADD CONSTRAINT "pricing_catalog_state_active_release_id_pricing_catalog_releases_id_fk" FOREIGN KEY ("active_release_id") REFERENCES "public"."pricing_catalog_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_channels" ADD CONSTRAINT "provider_channels_active_credential_version_id_provider_credential_versions_id_fk" FOREIGN KEY ("active_credential_version_id") REFERENCES "public"."provider_credential_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_channels" ADD CONSTRAINT "provider_channels_created_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credential_validation_runs" ADD CONSTRAINT "provider_credential_validation_runs_provider_channel_id_provider_channels_id_fk" FOREIGN KEY ("provider_channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credential_validation_runs" ADD CONSTRAINT "provider_credential_validation_runs_credential_version_id_provider_credential_versions_id_fk" FOREIGN KEY ("credential_version_id") REFERENCES "public"."provider_credential_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credential_validation_runs" ADD CONSTRAINT "provider_credential_validation_runs_queue_dispatch_intent_id_queue_dispatch_intents_id_fk" FOREIGN KEY ("queue_dispatch_intent_id") REFERENCES "public"."queue_dispatch_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credential_validation_runs" ADD CONSTRAINT "provider_credential_validation_runs_requested_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("requested_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credential_versions" ADD CONSTRAINT "provider_credential_versions_provider_channel_id_provider_channels_id_fk" FOREIGN KEY ("provider_channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_campaigns" ADD CONSTRAINT "reward_campaigns_created_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_channels" ADD CONSTRAINT "storage_channels_active_credential_version_id_storage_credential_versions_id_fk" FOREIGN KEY ("active_credential_version_id") REFERENCES "public"."storage_credential_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_channels" ADD CONSTRAINT "storage_channels_created_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_credential_versions" ADD CONSTRAINT "storage_credential_versions_storage_channel_id_storage_channels_id_fk" FOREIGN KEY ("storage_channel_id") REFERENCES "public"."storage_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_runtime_state" ADD CONSTRAINT "storage_runtime_state_active_channel_id_storage_channels_id_fk" FOREIGN KEY ("active_channel_id") REFERENCES "public"."storage_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_validation_runs" ADD CONSTRAINT "storage_validation_runs_storage_channel_id_storage_channels_id_fk" FOREIGN KEY ("storage_channel_id") REFERENCES "public"."storage_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_validation_runs" ADD CONSTRAINT "storage_validation_runs_credential_version_id_storage_credential_versions_id_fk" FOREIGN KEY ("credential_version_id") REFERENCES "public"."storage_credential_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_validation_runs" ADD CONSTRAINT "storage_validation_runs_queue_dispatch_intent_id_queue_dispatch_intents_id_fk" FOREIGN KEY ("queue_dispatch_intent_id") REFERENCES "public"."queue_dispatch_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_validation_runs" ADD CONSTRAINT "storage_validation_runs_requested_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("requested_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_auth_challenges_token_unique" ON "admin_auth_challenges" USING btree ("challenge_token_hash");--> statement-breakpoint
CREATE INDEX "admin_auth_challenges_status_expires_idx" ON "admin_auth_challenges" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_credentials_active_type_unique" ON "admin_credentials" USING btree ("admin_principal_id","credential_type") WHERE "admin_credentials"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "admin_credentials_pending_type_unique" ON "admin_credentials" USING btree ("admin_principal_id","credential_type") WHERE "admin_credentials"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "admin_credentials_public_id_unique" ON "admin_credentials" USING btree ("credential_public_id") WHERE "admin_credentials"."credential_public_id" is not null;--> statement-breakpoint
CREATE INDEX "admin_credentials_principal_status_idx" ON "admin_credentials" USING btree ("admin_principal_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_enrollment_tokens_hash_unique" ON "admin_enrollment_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_enrollment_tokens_live_principal_unique" ON "admin_enrollment_tokens" USING btree ("admin_principal_id") WHERE "admin_enrollment_tokens"."status" in ('issued', 'claimed');--> statement-breakpoint
CREATE INDEX "admin_enrollment_tokens_status_expires_idx" ON "admin_enrollment_tokens" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_idempotency_records_principal_key_unique" ON "admin_idempotency_records" USING btree ("actor_admin_id","operation","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "admin_idempotency_records_expires_idx" ON "admin_idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_mfa_recovery_codes_hash_unique" ON "admin_mfa_recovery_codes" USING btree ("key_id","code_hash");--> statement-breakpoint
CREATE INDEX "admin_mfa_recovery_codes_principal_idx" ON "admin_mfa_recovery_codes" USING btree ("admin_principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_principals_identifier_unique" ON "admin_principals" USING btree ("identifier_key_id","identifier_hash");--> statement-breakpoint
CREATE INDEX "admin_principals_status_idx" ON "admin_principals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_bindings_scope_unique" ON "admin_role_bindings" USING btree ("admin_principal_id","role_key","scope_type","scope_key");--> statement-breakpoint
CREATE INDEX "admin_role_bindings_principal_idx" ON "admin_role_bindings" USING btree ("admin_principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_unique" ON "admin_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_principal_status_expires_idx" ON "admin_sessions" USING btree ("admin_principal_id","status","session_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billable_skus_key_version_unique" ON "billable_skus" USING btree ("logical_sku_key","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "billable_skus_entry_matcher_version_unique" ON "billable_skus" USING btree ("model_catalog_entry_id","operation","matcher_hash","version_no");--> statement-breakpoint
CREATE INDEX "billable_skus_entry_status_idx" ON "billable_skus" USING btree ("model_catalog_entry_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_campaigns_key_unique" ON "invite_campaigns" USING btree ("campaign_key");--> statement-breakpoint
CREATE INDEX "invite_campaigns_status_window_idx" ON "invite_campaigns" USING btree ("status","starts_at","expires_at");--> statement-breakpoint
CREATE INDEX "invite_code_batches_campaign_created_idx" ON "invite_code_batches" USING btree ("campaign_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_catalog_entries_slug_version_unique" ON "model_catalog_entries" USING btree ("public_slug","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "model_catalog_entries_snapshot_category_unique" ON "model_catalog_entries" USING btree ("model_snapshot_id","category");--> statement-breakpoint
CREATE INDEX "model_catalog_entries_category_status_sort_idx" ON "model_catalog_entries" USING btree ("category","status","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "model_poc_runs_attempt_unique" ON "model_poc_runs" USING btree ("model_snapshot_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "model_poc_runs_intent_unique" ON "model_poc_runs" USING btree ("queue_dispatch_intent_id") WHERE "model_poc_runs"."queue_dispatch_intent_id" is not null;--> statement-breakpoint
CREATE INDEX "model_poc_runs_status_lease_idx" ON "model_poc_runs" USING btree ("status","processing_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_catalog_releases_no_unique" ON "pricing_catalog_releases" USING btree ("release_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_catalog_releases_digest_unique" ON "pricing_catalog_releases" USING btree ("release_digest");--> statement-breakpoint
CREATE INDEX "pricing_catalog_releases_status_created_idx" ON "pricing_catalog_releases" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_channels_identity_unique" ON "provider_channels" USING btree ("provider","adapter_key","endpoint_profile_key","region_key");--> statement-breakpoint
CREATE INDEX "provider_channels_status_idx" ON "provider_channels" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credential_validation_runs_attempt_unique" ON "provider_credential_validation_runs" USING btree ("credential_version_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credential_validation_runs_intent_unique" ON "provider_credential_validation_runs" USING btree ("queue_dispatch_intent_id") WHERE "provider_credential_validation_runs"."queue_dispatch_intent_id" is not null;--> statement-breakpoint
CREATE INDEX "provider_credential_validation_runs_status_lease_idx" ON "provider_credential_validation_runs" USING btree ("status","processing_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credential_versions_channel_version_unique" ON "provider_credential_versions" USING btree ("provider_channel_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credential_versions_active_channel_unique" ON "provider_credential_versions" USING btree ("provider_channel_id") WHERE "provider_credential_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "provider_credential_versions_channel_status_idx" ON "provider_credential_versions" USING btree ("provider_channel_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_campaigns_key_version_unique" ON "reward_campaigns" USING btree ("campaign_key","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "reward_campaigns_active_key_unique" ON "reward_campaigns" USING btree ("campaign_key") WHERE "reward_campaigns"."status" = 'active';--> statement-breakpoint
CREATE INDEX "reward_campaigns_status_window_idx" ON "reward_campaigns" USING btree ("status","starts_at","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_channels_identity_unique" ON "storage_channels" USING btree ("purpose","adapter_key","endpoint_profile_key","region_key","bucket","root_prefix");--> statement-breakpoint
CREATE INDEX "storage_channels_status_idx" ON "storage_channels" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_credential_versions_channel_version_unique" ON "storage_credential_versions" USING btree ("storage_channel_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_credential_versions_active_channel_unique" ON "storage_credential_versions" USING btree ("storage_channel_id") WHERE "storage_credential_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "storage_credential_versions_channel_status_idx" ON "storage_credential_versions" USING btree ("storage_channel_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_validation_runs_attempt_unique" ON "storage_validation_runs" USING btree ("credential_version_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_validation_runs_intent_unique" ON "storage_validation_runs" USING btree ("queue_dispatch_intent_id") WHERE "storage_validation_runs"."queue_dispatch_intent_id" is not null;--> statement-breakpoint
CREATE INDEX "storage_validation_runs_status_lease_idx" ON "storage_validation_runs" USING btree ("status","processing_lease_expires_at");--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_admin_id_admin_principals_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_session_id_admin_sessions_id_fk" FOREIGN KEY ("admin_session_id") REFERENCES "public"."admin_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_reviewer_admin_id_admin_principals_id_fk" FOREIGN KEY ("reviewer_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_decision_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("decision_ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_storage_channel_id_storage_channels_id_fk" FOREIGN KEY ("storage_channel_id") REFERENCES "public"."storage_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_upload_intents" ADD CONSTRAINT "asset_upload_intents_storage_channel_id_storage_channels_id_fk" FOREIGN KEY ("storage_channel_id") REFERENCES "public"."storage_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_storage_channel_id_storage_channels_id_fk" FOREIGN KEY ("storage_channel_id") REFERENCES "public"."storage_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_campaign_id_invite_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."invite_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_batch_id_invite_code_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."invite_code_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_issued_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("issued_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_provider_channel_id_provider_channels_id_fk" FOREIGN KEY ("provider_channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_reward_claims" ADD CONSTRAINT "registration_reward_claims_reward_campaign_id_reward_campaigns_id_fk" FOREIGN KEY ("reward_campaign_id") REFERENCES "public"."reward_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_active_ledger_unique" ON "appeals" USING btree ("ledger_id") WHERE "appeals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "appeals_decision_idempotency_unique" ON "appeals" USING btree ("decision_idempotency_key_hash") WHERE "appeals"."decision_idempotency_key_hash" is not null;--> statement-breakpoint
CREATE INDEX "invite_codes_campaign_created_idx" ON "invite_codes" USING btree ("campaign_id","created_at");--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_revision_positive" CHECK ("appeals"."revision" > 0);--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_revision_positive" CHECK ("invite_codes"."revision" > 0);