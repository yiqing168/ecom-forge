ALTER TABLE "agent_trace_steps" DROP CONSTRAINT "agent_trace_steps_skill_id_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_turns" DROP CONSTRAINT "agent_turns_primary_skill_id_skills_id_fk";
