CREATE TYPE "public"."mail_delivery_status" AS ENUM('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."mail_purpose" AS ENUM('email_verification', 'password_reset');--> statement-breakpoint
CREATE TYPE "public"."queue_dispatch_status" AS ENUM('pending', 'dispatching', 'dispatched', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."registration_claim_status" AS ENUM('pending', 'verified', 'redeemed', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."registration_reward_decision" AS ENUM('pending', 'granted', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."user_activity_type" ADD VALUE 'register' BEFORE 'download';--> statement-breakpoint
ALTER TYPE "public"."user_activity_type" ADD VALUE 'email_verify' BEFORE 'download';--> statement-breakpoint
ALTER TYPE "public"."user_activity_type" ADD VALUE 'password_reset' BEFORE 'download';--> statement-breakpoint
ALTER TYPE "public"."user_activity_type" ADD VALUE 'registration_reward' BEFORE 'download';--> statement-breakpoint
ALTER TYPE "public"."user_activity_type" ADD VALUE 'risk_block' BEFORE 'download';--> statement-breakpoint
CREATE TABLE "mail_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"recipient_hash" text NOT NULL,
	"recipient_hash_key_id" text NOT NULL,
	"purpose" "mail_purpose" NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"status" "mail_delivery_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_deliveries_provider_allowed" CHECK ("mail_deliveries"."provider" in ('fake', 'console', 'smtp', 'tencent_ses')),
	CONSTRAINT "mail_deliveries_attempt_nonnegative" CHECK ("mail_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "queue_dispatch_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_name" text NOT NULL,
	"job_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "queue_dispatch_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_dispatch_intents_payload_version_positive" CHECK ("queue_dispatch_intents"."payload_version" > 0),
	CONSTRAINT "queue_dispatch_intents_attempt_nonnegative" CHECK ("queue_dispatch_intents"."attempt_count" >= 0),
	CONSTRAINT "queue_dispatch_intents_lease_pair" CHECK (("queue_dispatch_intents"."lease_owner" is null) = ("queue_dispatch_intents"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "registration_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_code_id" uuid NOT NULL,
	"user_id" uuid,
	"email_hash" text NOT NULL,
	"ticket_hash" text,
	"ticket_nonce" text,
	"ticket_version" integer DEFAULT 1 NOT NULL,
	"status" "registration_claim_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_claims_ticket_version_positive" CHECK ("registration_claims"."ticket_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "registration_reward_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"mailbox_fingerprint" text NOT NULL,
	"fingerprint_key_id" text NOT NULL,
	"fingerprint_rules_version" text NOT NULL,
	"device_hash" text,
	"ip_prefix_hash" text,
	"decision" "registration_reward_decision" DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"ledger_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_reward_claims_granted_ledger_required" CHECK ("registration_reward_claims"."decision" <> 'granted' or "registration_reward_claims"."ledger_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "invite_codes" ALTER COLUMN "code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "code_digest" text;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "key_id" text;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "code_prefix" text;--> statement-breakpoint
ALTER TABLE "mail_deliveries" ADD CONSTRAINT "mail_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_claims" ADD CONSTRAINT "registration_claims_invite_code_id_invite_codes_id_fk" FOREIGN KEY ("invite_code_id") REFERENCES "public"."invite_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_claims" ADD CONSTRAINT "registration_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_reward_claims" ADD CONSTRAINT "registration_reward_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_reward_claims" ADD CONSTRAINT "registration_reward_claims_ledger_id_credit_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."credit_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_deliveries_idempotency_key_unique" ON "mail_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "mail_deliveries_status_updated_idx" ON "mail_deliveries" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "mail_deliveries_provider_status_created_idx" ON "mail_deliveries" USING btree ("provider","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_dispatch_intents_queue_job_unique" ON "queue_dispatch_intents" USING btree ("queue_name","job_id");--> statement-breakpoint
CREATE INDEX "queue_dispatch_intents_status_next_attempt_idx" ON "queue_dispatch_intents" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "queue_dispatch_intents_aggregate_idx" ON "queue_dispatch_intents" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_claims_idempotency_key_unique" ON "registration_claims" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_claims_ticket_hash_unique" ON "registration_claims" USING btree ("ticket_hash") WHERE "registration_claims"."ticket_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_claims_active_email_unique" ON "registration_claims" USING btree ("email_hash") WHERE "registration_claims"."status" in ('pending', 'verified');--> statement-breakpoint
CREATE INDEX "registration_claims_invite_status_expires_idx" ON "registration_claims" USING btree ("invite_code_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_reward_claims_campaign_user_unique" ON "registration_reward_claims" USING btree ("campaign_key","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_reward_claims_campaign_mailbox_unique" ON "registration_reward_claims" USING btree ("campaign_key","mailbox_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_codes_key_digest_unique" ON "invite_codes" USING btree ("key_id","code_digest") WHERE "invite_codes"."key_id" is not null and "invite_codes"."code_digest" is not null;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_digest_key_together" CHECK (("invite_codes"."code_digest" is null) = ("invite_codes"."key_id" is null));--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_legacy_or_digest_required" CHECK ("invite_codes"."code" is not null or "invite_codes"."code_digest" is not null);