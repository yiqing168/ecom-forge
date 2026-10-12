ALTER TABLE "models" ADD COLUMN "status_evidence_digest" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "status_operator_id" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "status_changed_at" timestamp with time zone;