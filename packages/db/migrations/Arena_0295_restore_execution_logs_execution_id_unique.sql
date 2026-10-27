-- Repair: `workflow_execution_logs_execution_id_unique` is required by
-- `startWorkflowExecution`'s ON CONFLICT (execution_id) DO NOTHING. Without it,
-- every run fails to persist a durable log, and File/Knowledge tools that bind
-- on that log answer "Authentication required".
-- Schema already declares the unique index (migration 0049); recreate if lost.
-- Run manually on Arena DBs that are missing the index. Refuse to create when
-- duplicate execution_id rows exist — clean those up first.
-- migration-safe: additive unique index; IF NOT EXISTS; CONCURRENTLY (no table lock).
COMMIT;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workflow_execution_logs
    WHERE execution_id IS NOT NULL
    GROUP BY execution_id
    HAVING COUNT(*) > 1
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'Refusing to create workflow_execution_logs_execution_id_unique: duplicate execution_id rows exist';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_execution_logs_execution_id_unique"
  ON "workflow_execution_logs" USING btree ("execution_id");--> statement-breakpoint
SET lock_timeout = '5s';
