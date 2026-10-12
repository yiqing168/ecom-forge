CREATE TYPE "public"."content_review_decision" AS ENUM('release', 'reject');--> statement-breakpoint
CREATE TYPE "public"."content_review_status" AS ENUM('pending', 'released', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."content_safety_preflight_status" AS ENUM('queued', 'running', 'passed', 'blocked', 'failed', 'outcome_unknown', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."moderation_capability" AS ENUM('moderation.text', 'moderation.image');--> statement-breakpoint
CREATE TABLE "artifact_input_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_asset_id" uuid,
	"source_artifact_id" uuid,
	"source_version_or_hash" text NOT NULL,
	"role" text NOT NULL,
	"transform_snapshot_json" jsonb,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_input_bindings_order_nonnegative" CHECK ("artifact_input_bindings"."sort_order" >= 0),
	CONSTRAINT "artifact_input_bindings_source_shape" CHECK (("artifact_input_bindings"."source_type" = 'asset' and "artifact_input_bindings"."source_asset_id" is not null and "artifact_input_bindings"."source_artifact_id" is null) or ("artifact_input_bindings"."source_type" = 'artifact' and "artifact_input_bindings"."source_asset_id" is null and "artifact_input_bindings"."source_artifact_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "content_review_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"status" "content_review_status" DEFAULT 'pending' NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"decision" "content_review_decision",
	"decision_summary_json" jsonb,
	"decided_by_admin_id" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_review_cases_revision_positive" CHECK ("content_review_cases"."revision" > 0),
	CONSTRAINT "content_review_cases_decision_shape" CHECK (("content_review_cases"."status" = 'pending' and "content_review_cases"."decision" is null and "content_review_cases"."decided_at" is null and "content_review_cases"."decided_by_admin_id" is null) or ("content_review_cases"."status" = 'expired' and "content_review_cases"."decision" is null and "content_review_cases"."decided_at" is not null and "content_review_cases"."decided_by_admin_id" is null) or ("content_review_cases"."status" = 'released' and "content_review_cases"."decision" = 'release' and "content_review_cases"."decided_at" is not null and "content_review_cases"."decided_by_admin_id" is not null and "content_review_cases"."decision_reason" is not null) or ("content_review_cases"."status" = 'rejected' and "content_review_cases"."decision" = 'reject' and "content_review_cases"."decided_at" is not null and "content_review_cases"."decided_by_admin_id" is not null and "content_review_cases"."decision_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "content_safety_preflights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"turn_id" uuid NOT NULL,
	"continuation_no" integer NOT NULL,
	"capability" "moderation_capability" NOT NULL,
	"check_no" integer NOT NULL,
	"input_digest" text NOT NULL,
	"model_snapshot_id" uuid NOT NULL,
	"credential_version_id" uuid NOT NULL,
	"runtime_revision" integer NOT NULL,
	"policy_version" text NOT NULL,
	"operation_key" text NOT NULL,
	"status" "content_safety_preflight_status" DEFAULT 'queued' NOT NULL,
	"dispatch_state" "dispatch_state" DEFAULT 'not_dispatched' NOT NULL,
	"reserved_cost_cny" numeric(18, 2) NOT NULL,
	"actual_cost_cny" numeric(18, 2),
	"evidence_summary_json" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"processing_owner" text,
	"processing_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "content_safety_preflights_continuation_positive" CHECK ("content_safety_preflights"."continuation_no" > 0),
	CONSTRAINT "content_safety_preflights_check_nonnegative" CHECK ("content_safety_preflights"."check_no" >= 0),
	CONSTRAINT "content_safety_preflights_runtime_revision_positive" CHECK ("content_safety_preflights"."runtime_revision" > 0),
	CONSTRAINT "content_safety_preflights_revision_positive" CHECK ("content_safety_preflights"."revision" > 0),
	CONSTRAINT "content_safety_preflights_reserved_cost_nonnegative" CHECK ("content_safety_preflights"."reserved_cost_cny" >= 0),
	CONSTRAINT "content_safety_preflights_actual_cost_nonnegative" CHECK ("content_safety_preflights"."actual_cost_cny" is null or "content_safety_preflights"."actual_cost_cny" >= 0),
	CONSTRAINT "content_safety_preflights_owner_lease_pair" CHECK (("content_safety_preflights"."processing_owner" is null) = ("content_safety_preflights"."processing_lease_expires_at" is null)),
	CONSTRAINT "content_safety_preflights_running_owner" CHECK (("content_safety_preflights"."status" = 'running' and "content_safety_preflights"."processing_owner" is not null) or ("content_safety_preflights"."status" <> 'running' and "content_safety_preflights"."processing_owner" is null))
);
--> statement-breakpoint
CREATE TABLE "moderation_runtime_states" (
	"capability" "moderation_capability" PRIMARY KEY NOT NULL,
	"active_model_snapshot_id" uuid,
	"runtime_revision" integer DEFAULT 1 NOT NULL,
	"updated_by_admin_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_runtime_states_revision_positive" CHECK ("moderation_runtime_states"."runtime_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "artifact_evaluations" DROP CONSTRAINT "artifact_evaluations_confidence_range";--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ALTER COLUMN "confidence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD COLUMN "task_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD COLUMN "model_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD COLUMN "operation_key" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "published_storage_key" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "published_content_hash" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "publication_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "publication_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_input_bindings" ADD CONSTRAINT "artifact_input_bindings_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_input_bindings" ADD CONSTRAINT "artifact_input_bindings_source_asset_id_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_input_bindings" ADD CONSTRAINT "artifact_input_bindings_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_cases" ADD CONSTRAINT "content_review_cases_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_cases" ADD CONSTRAINT "content_review_cases_evaluation_id_artifact_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."artifact_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_review_cases" ADD CONSTRAINT "content_review_cases_decided_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_safety_preflights" ADD CONSTRAINT "content_safety_preflights_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_safety_preflights" ADD CONSTRAINT "content_safety_preflights_model_snapshot_id_models_id_fk" FOREIGN KEY ("model_snapshot_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_safety_preflights" ADD CONSTRAINT "content_safety_preflights_credential_version_id_provider_credential_versions_id_fk" FOREIGN KEY ("credential_version_id") REFERENCES "public"."provider_credential_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_runtime_states" ADD CONSTRAINT "moderation_runtime_states_active_model_snapshot_id_models_id_fk" FOREIGN KEY ("active_model_snapshot_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_runtime_states" ADD CONSTRAINT "moderation_runtime_states_updated_by_admin_id_admin_principals_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."admin_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_input_bindings_artifact_order_unique" ON "artifact_input_bindings" USING btree ("artifact_id","sort_order");--> statement-breakpoint
CREATE INDEX "artifact_input_bindings_asset_idx" ON "artifact_input_bindings" USING btree ("source_asset_id");--> statement-breakpoint
CREATE INDEX "artifact_input_bindings_source_artifact_idx" ON "artifact_input_bindings" USING btree ("source_artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_review_cases_evaluation_unique" ON "content_review_cases" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX "content_review_cases_status_deadline_idx" ON "content_review_cases" USING btree ("status","deadline_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_safety_preflights_operation_unique" ON "content_safety_preflights" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "content_safety_preflights_check_unique" ON "content_safety_preflights" USING btree ("turn_id","continuation_no","capability","check_no");--> statement-breakpoint
CREATE INDEX "content_safety_preflights_status_lease_idx" ON "content_safety_preflights" USING btree ("status","processing_lease_expires_at");--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_task_attempt_id_task_attempts_id_fk" FOREIGN KEY ("task_attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_model_snapshot_id_models_id_fk" FOREIGN KEY ("model_snapshot_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_evaluations_operation_key_unique" ON "artifact_evaluations" USING btree ("operation_key") WHERE "artifact_evaluations"."operation_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_evaluations_attempt_unique" ON "artifact_evaluations" USING btree ("task_attempt_id") WHERE "artifact_evaluations"."task_attempt_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_evaluations_artifact_type_version_unique" ON "artifact_evaluations" USING btree ("artifact_id","evaluator_type","evaluator_version");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_published_storage_key_unique" ON "artifacts" USING btree ("published_storage_key") WHERE "artifacts"."published_storage_key" is not null;--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_content_safety_shape" CHECK ("artifact_evaluations"."evaluator_type" <> 'content_safety' or ("artifact_evaluations"."task_id" is not null and "artifact_evaluations"."task_attempt_id" is not null and "artifact_evaluations"."model_snapshot_id" is not null and "artifact_evaluations"."operation_key" is not null and (("artifact_evaluations"."status" = 'unknown' and "artifact_evaluations"."confidence" is null) or ("artifact_evaluations"."status" in ('pass','warning','blocked') and "artifact_evaluations"."confidence" is not null))));--> statement-breakpoint
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_confidence_range" CHECK ("artifact_evaluations"."confidence" is null or ("artifact_evaluations"."confidence" >= 0 and "artifact_evaluations"."confidence" <= 1));--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_publication_revision_positive" CHECK ("artifacts"."publication_revision" > 0);--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_publication_fields_complete" CHECK (("artifacts"."published_storage_key" is null and "artifacts"."published_content_hash" is null and "artifacts"."publication_snapshot" is null) or ("artifacts"."published_storage_key" is not null and "artifacts"."published_content_hash" is not null and "artifacts"."publication_snapshot" is not null));--> statement-breakpoint
INSERT INTO "moderation_runtime_states" ("capability", "runtime_revision")
VALUES ('moderation.text', 1), ('moderation.image', 1)
ON CONFLICT ("capability") DO NOTHING;--> statement-breakpoint
UPDATE "admin_role_bindings"
SET
	"permission_snapshot_hash" = CASE "role_key"
		WHEN 'operations' THEN 'ac5f2f1f05d39a5ac8f15392ecc967700b1fd0e7628189ee09dec308c4ba390c'
		WHEN 'security_admin' THEN '905ac1152ae7746fb77ceff3520d33c130056f5e7fe89e365b4a13eaf68f898d'
		WHEN 'super_admin' THEN '1bfef96aa2e6c6b2fe5958c995029688c43e5f22e42640c3962af1c58f80ebbc'
		ELSE "permission_snapshot_hash"
	END,
	"revision" = "revision" + 1,
	"updated_at" = now()
WHERE "role_key" IN ('operations', 'security_admin', 'super_admin');--> statement-breakpoint
UPDATE "admin_sessions"
SET "status" = 'revoked', "revoked_at" = now()
WHERE "status" = 'active'
	AND EXISTS (
		SELECT 1
		FROM "admin_role_bindings"
		WHERE "admin_role_bindings"."admin_principal_id" = "admin_sessions"."admin_principal_id"
			AND "admin_role_bindings"."role_key" IN ('operations', 'security_admin', 'super_admin')
	);--> statement-breakpoint
UPDATE "admin_principals"
SET "authz_version" = "authz_version" + 1, "revision" = "revision" + 1, "updated_at" = now()
WHERE EXISTS (
	SELECT 1
	FROM "admin_role_bindings"
	WHERE "admin_role_bindings"."admin_principal_id" = "admin_principals"."id"
		AND "admin_role_bindings"."role_key" IN ('operations', 'security_admin', 'super_admin')
);
