-- LLM provider + model catalog schema
-- Nested objects (pricing, capabilities, sunset, file_attachment) are jsonb —
-- same shape as apps/sim/providers/models.ts PROVIDER_DEFINITIONS.
--
-- Apply once:
--   psql "$DATABASE_URL" -f packages/db/scripts/create-llm-provider-catalog.sql
--
-- Populate / refresh from code via:
--   POST /api/v1/admin/llm-catalog/sync
--   Header: x-admin-key: $CRON_SECRET

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
