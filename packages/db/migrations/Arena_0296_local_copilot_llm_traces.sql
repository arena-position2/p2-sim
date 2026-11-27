-- migration-safe: additive table for Local Copilot per-LLM-round prompt traces (expand-only, no drops)
CREATE TABLE IF NOT EXISTS "local_copilot_llm_traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" text,
  "chat_id" text,
  "conversation_id" uuid,
  "user_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "round" integer NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "system_prompt" text,
  "messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "response_text" text,
  "thinking" text,
  "tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "injected_nudges" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "local_copilot_llm_traces" ADD CONSTRAINT "local_copilot_llm_traces_conversation_id_local_copilot_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."local_copilot_conversations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "local_copilot_llm_traces" ADD CONSTRAINT "local_copilot_llm_traces_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "local_copilot_llm_traces" ADD CONSTRAINT "local_copilot_llm_traces_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_copilot_llm_traces_user_id_idx" ON "local_copilot_llm_traces" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_copilot_llm_traces_workspace_id_idx" ON "local_copilot_llm_traces" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_copilot_llm_traces_chat_id_idx" ON "local_copilot_llm_traces" USING btree ("chat_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_copilot_llm_traces_run_id_idx" ON "local_copilot_llm_traces" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_copilot_llm_traces_created_at_idx" ON "local_copilot_llm_traces" USING btree ("created_at");
