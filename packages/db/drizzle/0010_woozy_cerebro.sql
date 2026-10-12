ALTER TABLE "run_quotes" ADD COLUMN "plan_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run_quotes" ADD COLUMN "skill_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "run_quotes" ADD COLUMN "pricing_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;