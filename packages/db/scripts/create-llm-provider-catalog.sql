-- LLM provider + model catalog schema
-- Nested objects (pricing, capabilities, sunset, file_attachment) are jsonb —
-- same shape as apps/sim/providers/models.ts PROVIDER_DEFINITIONS.
--
-- Lifecycle:
--   1. Apply this script once (empty tables).
--   2. POST /api/v1/admin/llm-catalog/sync  (x-admin-key: $CRON_SECRET)
--      → upserts every provider/model from PROVIDER_DEFINITIONS into these tables.
--      → deprecated / removed-from-code models become model_status = 'deactive'.
--   3. GET /api/llm-catalog (session) returns only model_status = 'active'.
--   4. The browser hydrates PROVIDER_DEFINITIONS from that response so pickers
--      keep using PROVIDER_DEFINITIONS but only see active models.
--
-- Apply once:
--   psql "$DATABASE_URL" -f packages/db/scripts/create-llm-provider-catalog.sql
--
-- After adding/changing models in models.ts, re-run sync on that environment.

CREATE TABLE IF NOT EXISTS llm_provider (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  default_model text NOT NULL DEFAULT '',
  color text,
  is_reseller boolean,
  context_information_available boolean,
  icon text,
  model_patterns text[],
  file_attachment jsonb,
  capabilities jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_model (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES llm_provider(id) ON DELETE CASCADE,
  pricing jsonb NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_window integer,
  release_date date,
  featured boolean,
  recommended boolean,
  speed_optimized boolean,
  sunset jsonb,
  model_status text NOT NULL DEFAULT 'active'
    CHECK (model_status IN ('active', 'deactive')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_model_provider_id_sort_idx
  ON llm_model (provider_id, sort_order);
