-- Arena v3 in-app route for a chat deployment, stored as a path
-- (`/keyword-research`). The listing client joins it to its own origin.
-- Nullable and additive: already-deployed app code ignores the column.
-- Run manually.
ALTER TABLE "chat" ADD COLUMN IF NOT EXISTS "arena_path" text;
