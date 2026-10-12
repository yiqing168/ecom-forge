CREATE TABLE "resource_write_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"response_status" integer,
	"response_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "resource_write_requests_status_allowed" CHECK ("resource_write_requests"."status" in ('completed')),
	CONSTRAINT "resource_write_requests_completed_fields" CHECK ("resource_write_requests"."status" <> 'completed' or ("resource_write_requests"."response_status" is not null and "resource_write_requests"."response_json" is not null and "resource_write_requests"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "resource_write_requests" ADD CONSTRAINT "resource_write_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_write_requests_user_operation_key_unique" ON "resource_write_requests" USING btree ("user_id","operation","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "resource_write_requests_user_created_idx" ON "resource_write_requests" USING btree ("user_id","created_at");