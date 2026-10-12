ALTER TABLE "registration_claims" ADD COLUMN "pending_email" varchar(320);--> statement-breakpoint
ALTER TABLE "registration_claims" ADD COLUMN "pending_display_name" varchar(120);--> statement-breakpoint
ALTER TABLE "registration_claims" ADD COLUMN "pending_password_hash" text;--> statement-breakpoint
ALTER TABLE "registration_claims" ADD COLUMN "agreement_version" varchar(64);