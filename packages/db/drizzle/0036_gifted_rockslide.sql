ALTER TABLE "chat_sessions" ADD COLUMN "primary_skill_slug" text;--> statement-breakpoint
UPDATE "chat_sessions" AS "session"
SET "primary_skill_slug" = "first_turn"."primary_skill_slug"
FROM (
	SELECT DISTINCT ON ("session_id")
		"session_id",
		split_part("primary_skill_id", '@', 1) AS "primary_skill_slug"
	FROM "agent_turns"
	WHERE "primary_skill_id" IS NOT NULL
	ORDER BY "session_id", "created_at", "id"
) AS "first_turn"
WHERE "session"."id" = "first_turn"."session_id"
	AND "session"."primary_skill_slug" IS NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_primary_skill_slug_valid" CHECK ("chat_sessions"."primary_skill_slug" is null or "chat_sessions"."primary_skill_slug" ~ '^[a-z0-9][a-z0-9-]*$');
