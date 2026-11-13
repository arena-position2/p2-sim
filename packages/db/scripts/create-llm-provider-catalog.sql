-- LLM provider + model catalog schema
-- Nested objects (pricing, capabilities, sunset, file_attachment) are jsonb —
-- same shape as apps/sim/providers/models.ts PROVIDER_DEFINITIONS.
--
-- Lifecycle:
--   1. Apply this script once (empty tables).
--   2. POST /api/v1/admin/llm-catalog/sync
--      → upserts every provider/model from PROVIDER_DEFINITIONS into these tables.
--      → deprecated / removed-from-code models become model_status = 'deactive'.
--   3. Sync clears the catalog cache, then reloads DB → cache after upserts.
--   4. PATCH /api/v1/admin/llm-catalog/models/status flips one model_status
--      (clear cache → update row → reload DB → cache).
--   5. GET /api/llm-catalog and GET /api/v1/admin/llm-catalog read cache
--      (or DB on miss), return only model_status = 'active'.
--   6. The browser hydrates PROVIDER_DEFINITIONS from that response so pickers
--      keep using PROVIDER_DEFINITIONS but only see active models.
--
-- Auth for catalog APIs: signed-in session cookie OR x-admin-key: $CRON_SECRET.
--
-- Apply once:
--   psql "$DATABASE_URL" -f packages/db/scripts/create-llm-provider-catalog.sql
--
-- After adding/changing models in models.ts, re-run sync on that environment.

-- Dropdown-friendly enum for model lifecycle (active | deactive).
DO $$ BEGIN
  CREATE TYPE llm_model_status AS ENUM ('active', 'deactive');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

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
  model_status llm_model_status NOT NULL DEFAULT 'active',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS llm_model_provider_id_sort_idx
  ON llm_model (provider_id, sort_order);
