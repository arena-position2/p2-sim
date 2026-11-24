
-- =============================================================================
-- Arena Auto model routing pool — MANUAL seed script (not a Drizzle journal migration)
-- =============================================================================
-- How to apply:
--   psql "$DATABASE_URL" -f packages/db/migrations/auto-routing-pool-schema.sql
--
-- This file is intentionally NOT registered in migrations/meta/_journal.json.
-- Do not expect `bun run db:migrate` to pick it up. Run it once by hand on the
-- target DB, then maintain rows with UPDATE/INSERT as needed.
--
-- Runtime consumer (Arena only)
--   apps/sim/lib/model-router/arena-resolve.ts  ← Agent block Auto
--   Drizzle mirrors: packages/db/schema.ts (`autoRouteTier`, `autoRoutingPool`)
--   Do NOT wire Agent to apps/sim/lib/model-router/resolve.ts — that is upstream
--   Sim mothership Auto (Copilot credits / /api/model-router).
--
-- Tables
--   auto_route_tier     = definition/catalog of tier codes (fast, coding, …)
--   auto_routing_pool   = concrete model mapping (media × tier × rank → model)
--
-- is_active behavior (important)
--   Turning off a tier does NOT cascade into pool rows:
--     UPDATE auto_route_tier SET is_active = false WHERE tier_code = 'research';
--   Runtime / the wide view MUST join and filter t.is_active = true, or those
--   pool rows can still be selected. To also hide pool rows themselves:
--     UPDATE auto_routing_pool SET is_active = false WHERE route_tier = 'research';
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Lookup: semantic route tiers (definition of tier_code only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_route_tier (
  tier_code       TEXT PRIMARY KEY,          -- fast | workhorse | coding | ...
  display_name    TEXT NOT NULL,
  description     TEXT NOT NULL,
  sort_order      SMALLINT NOT NULL UNIQUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE auto_route_tier IS
  'Definition/catalog of Auto route tier codes. Not the model mapping — that lives in auto_routing_pool.';

COMMENT ON COLUMN auto_route_tier.is_active IS
  'When false, classifier candidates and runtime lookups that join this table should ignore the tier. Does NOT auto-update auto_routing_pool.is_active.';

INSERT INTO auto_route_tier (tier_code, display_name, description, sort_order) VALUES
  ('fast',      'Triage & Ultra-Fast',        'Classification, intent routing, simple Q&A, formatting, high-throughput extraction', 1),
  ('workhorse', 'Everyday Workhorse',         'General chat, summarization, standard tool-calling agents, multimodal inputs', 2),
  ('coding',    'Coding & Agentic Dev',       'Repo edits, debugging, bash/tool loops, multi-file code generation', 3),
  ('reasoning', 'Deep Reasoning & Math',      'Hard math, formal logic, architectural planning, complex constraint solving', 4),
  ('creative',  'Creative & Long-Form',       'Storytelling, nuanced tone/voice, copywriting, worldbuilding', 5),
  ('research',  'Deep Research & Multi-Agent','Open-ended multi-step synthesis, exhaustive literature/web reports', 6),
  ('search',    'Live Web Search',            'Real-time facts, current events, live pricing/status lookups', 7)
ON CONFLICT (tier_code) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      description  = EXCLUDED.description,
      sort_order   = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------------
-- 2) Main pool: one row per (media, tier, product, rank) → model
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_routing_pool (
  id               BIGSERIAL PRIMARY KEY,

  -- What the task attaches / needs
  media_kind       TEXT NOT NULL
                   CHECK (media_kind IN ('text', 'image', 'file', 'live_data')),

  -- Classifier choice (matches JSON: { "tier": "reasoning", ... })
  route_tier       TEXT NOT NULL
                   REFERENCES auto_route_tier (tier_code),

  -- Typical complexity this slot is for (classifier complexity_score 1–5).
  -- Runtime: prefer exact match; if none, fall back to same media+tier by rank.
  complexity_score SMALLINT NOT NULL DEFAULT 3
                   CHECK (complexity_score BETWEEN 1 AND 5),

  -- Catalog model id (must exist in your provider catalog / keys)
  model_id         TEXT NOT NULL,

  -- 1 = primary, 2 = first fallback, 3 = second fallback, ...
  selection_rank   SMALLINT NOT NULL CHECK (selection_rank >= 1),

  -- Which product uses this row
  product_surface  TEXT NOT NULL
                   CHECK (product_surface IN ('agent', 'arena_copilot', 'both')),

  -- Human-readable purpose
  best_for         TEXT,
  notes            TEXT,

  requires_tools   BOOLEAN,          -- NULL = either; true/false = prefer when tools match
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One model slot per media/tier/product/rank
  CONSTRAINT auto_routing_pool_unique_slot
    UNIQUE (media_kind, route_tier, product_surface, selection_rank)
);

CREATE INDEX IF NOT EXISTS idx_auto_routing_pool_lookup
  ON auto_routing_pool (media_kind, route_tier, product_surface, is_active, selection_rank);

CREATE INDEX IF NOT EXISTS idx_auto_routing_pool_model
  ON auto_routing_pool (model_id);

COMMENT ON TABLE auto_routing_pool IS
  'Auto router pool: classifier picks route_tier (+ optional complexity); this table maps to concrete models with fallback ranks.';

COMMENT ON COLUMN auto_routing_pool.media_kind IS
  'text = no attachment; image = image MIME only; file = PDF/docs/other; live_data = needs live web/search.';

COMMENT ON COLUMN auto_routing_pool.selection_rank IS
  '1 = primary pick; higher = fallback if primary unavailable (key/permission/blacklist).';

COMMENT ON COLUMN auto_routing_pool.product_surface IS
  'agent = Agent block Auto; arena_copilot = Arena Copilot Auto; both = shared.';

COMMENT ON COLUMN auto_routing_pool.complexity_score IS
  'Single complexity 1–5 this model slot targets (from classifier). Prefer exact match; else same media+tier by selection_rank.';

COMMENT ON COLUMN auto_routing_pool.is_active IS
  'Per-row on/off for a model slot. Independent of auto_route_tier.is_active.';

-- ---------------------------------------------------------------------------
-- 3) Seed data
--    Notes:
--      • Files use native multimodal providers only.
--      • Images need vision-capable models.
--      • live_data focuses on search/grounding models.
--      • arena_copilot prefers slightly cheaper/faster defaults where noted.
--      • Replacements for Sim-catalog legacy models (still callable unless noted):
--          gpt-4.1-nano → gpt-5.4-mini
--          o4-mini      → gpt-5.4-mini  (Agent reasoning cheap fallback)
--      • claude-fable-5 kept: Anthropic still serves it; catalog marks it legacy
--        only because fable-5-1 is newer (primary creative stays fable-5-1).
--      • Search / live pool: gpt-4o-search-preview + gemini-4-argon often fail
--        (deprecated / permission denied). Prefer deep-research + grok + workhorse.
-- ---------------------------------------------------------------------------

-- Re-runnable seed: wipe pool rows then re-insert (tier defs upsert above).
-- If you emptied both tables yourself, this DELETE is a no-op.
DELETE FROM auto_routing_pool;

-- ========================= TEXT =========================
INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('text', 'fast', 1, 'gpt-5.4-nano',          1, 'both',          'Ultra-fast triage / classification / formatting', false),
  ('text', 'fast', 1, 'gemini-3.5-flash-lite', 2, 'both',          'Cheap high-throughput extraction', false),
  ('text', 'fast', 1, 'claude-haiku-5-5',      3, 'both',          'Fast fallback with strong instruction following', false),
  ('text', 'fast', 1, 'gpt-5.4-mini',          4, 'both',          'Last-resort mini fallback (replaces legacy gpt-4.1-nano)', false);

INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('text', 'workhorse', 3, 'gpt-6.1-sol',        1, 'agent',         'Default Agent everyday chat + tool calling', true),
  ('text', 'workhorse', 3, 'gemini-3.8-flash',   1, 'arena_copilot', 'Default Copilot workhorse (fast multimodal)', true),
  ('text', 'workhorse', 3, 'gemini-3.8-flash',   2, 'agent',         'Agent multimodal / cost-efficient workhorse', true),
  ('text', 'workhorse', 3, 'gpt-6.1-sol',        2, 'arena_copilot', 'Copilot fallback to GPT workhorse', true),
  ('text', 'workhorse', 3, 'claude-sonnet-5-5',  3, 'both',          'Strong general agent fallback', true),
  ('text', 'workhorse', 3, 'grok-4.7',           4, 'both',          'Alternate workhorse fallback', true);

INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('text', 'coding', 4, 'gpt-5.3-codex',       1, 'both', 'Repo edits, debugging, tool/bash loops', true),
  ('text', 'coding', 4, 'claude-sonnet-5-5',   2, 'both', 'Multi-file code generation / agentic coding', true),
  ('text', 'coding', 4, 'claude-opus-5-5',     3, 'both', 'Hard coding / architectural code changes', true),
  ('text', 'coding', 4, 'gpt-6-astra',         4, 'both', 'High-capability coding fallback', true);

INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('text', 'reasoning', 5, 'o3-pro',                      1, 'both', 'Hard math / formal logic / deep planning', false),
  ('text', 'reasoning', 5, 'gpt-5.5-pro',                 2, 'both', 'Complex constraint solving', false),
  ('text', 'reasoning', 5, 'claude-opus-5-5',             3, 'both', 'Architectural reasoning fallback', false),
  ('text', 'reasoning', 5, 'gpt-5.4-mini',                4, 'agent', 'Cheaper reasoning fallback for Agent (replaces legacy o4-mini)', false),
  ('text', 'reasoning', 5, 'grok-4.20-0309-reasoning',    4, 'arena_copilot', 'Copilot reasoning fallback', false);

INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('text', 'creative', 3, 'claude-fable-5-1',  1, 'both', 'Storytelling / nuanced tone / worldbuilding', false),
  ('text', 'creative', 3, 'claude-fable-5',    2, 'both', 'Creative long-form fallback (still served by Anthropic)', false),
  ('text', 'creative', 3, 'claude-opus-5-5',   3, 'both', 'High-quality creative / copywriting fallback', false);

INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('text', 'research', 5, 'deep-research-pro-preview-12-2025', 1, 'both', 'Open-ended multi-step synthesis / reports', true),
  ('text', 'research', 5, 'grok-4.20-multi-agent-0309',       2, 'both', 'Multi-agent research fallback', true);

INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('text', 'search', 2, 'deep-research-pro-preview-12-2025', 1, 'both', 'Live web / current-events research', true),
  ('text', 'search', 2, 'grok-4.7',                          2, 'both', 'Current-events fallback', false),
  ('text', 'search', 2, 'gpt-6.1-sol',                       3, 'both', 'General fallback when research models unavailable', true);

-- ========================= IMAGE =========================
INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('image', 'fast', 1, 'gemini-3.5-flash-lite', 1, 'both', 'Quick screenshot / image classification', false),
  ('image', 'fast', 1, 'gemini-3.8-flash',      2, 'both', 'Fast vision fallback', false),
  ('image', 'fast', 1, 'claude-haiku-5-5',      3, 'both', 'Fast vision-capable fallback', false),

  ('image', 'workhorse', 3, 'gemini-3.8-flash',  1, 'both', 'Standard multimodal chat + tools with images', true),
  ('image', 'workhorse', 3, 'gpt-6.1-sol',       2, 'both', 'GPT multimodal workhorse', true),
  ('image', 'workhorse', 3, 'claude-sonnet-5-5', 3, 'both', 'Strong vision agent fallback', true),
  ('image', 'workhorse', 3, 'grok-4.7',          4, 'both', 'Alternate multimodal fallback', true),

  ('image', 'coding', 4, 'gpt-5.3-codex',     1, 'both', 'Code from screenshots / UI bugs', true),
  ('image', 'coding', 4, 'claude-sonnet-5-5', 2, 'both', 'Vision + coding agent', true),
  ('image', 'coding', 4, 'claude-opus-5-5',   3, 'both', 'Hard vision+code fallback', true),
  ('image', 'coding', 4, 'gpt-6-astra',       4, 'both', 'High-capability vision coding fallback', true),

  ('image', 'reasoning', 5, 'gpt-5.5-pro',     1, 'both', 'Hard visual reasoning / diagrams', false),
  ('image', 'reasoning', 5, 'claude-opus-5-5', 2, 'both', 'Deep multimodal reasoning', false),
  ('image', 'reasoning', 5, 'o3-pro',          3, 'both', 'Formal reasoning over visual inputs', false),

  ('image', 'creative', 3, 'claude-fable-5-1', 1, 'both', 'Creative writing grounded on images', false),
  ('image', 'creative', 3, 'claude-fable-5',   2, 'both', 'Creative vision fallback (still served by Anthropic)', false),
  ('image', 'creative', 3, 'claude-opus-5-5',  3, 'both', 'High-quality multimodal creative', false),

  ('image', 'research', 5, 'deep-research-pro-preview-12-2025', 1, 'both', 'Research that includes figures/screenshots', true),
  ('image', 'research', 5, 'grok-4.20-multi-agent-0309',       2, 'both', 'Multi-agent research with images', true),

  ('image', 'search', 2, 'deep-research-pro-preview-12-2025', 1, 'both', 'Image + live research', true),
  ('image', 'search', 2, 'gemini-3.8-flash',                   2, 'both', 'Vision + general fallback', true),
  ('image', 'search', 2, 'gpt-6.1-sol',                        3, 'both', 'GPT multimodal live fallback', true);

-- ========================= FILE (PDF / docs / non-image) =========================
INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('file', 'fast', 1, 'gemini-3.5-flash-lite', 1, 'both', 'Fast PDF field extraction', false),
  ('file', 'fast', 1, 'gemini-3.8-flash',      2, 'both', 'Fast document skim / extract', false),
  ('file', 'fast', 1, 'claude-haiku-5-5',      3, 'both', 'Fast doc Q&A fallback', false),

  ('file', 'workhorse', 3, 'gemini-3.8-flash',  1, 'arena_copilot', 'Copilot default for attached docs', true),
  ('file', 'workhorse', 3, 'claude-sonnet-5-5', 1, 'agent',         'Agent default for PDF/doc workflows', true),
  ('file', 'workhorse', 3, 'claude-sonnet-5-5', 2, 'arena_copilot', 'Copilot strong doc fallback', true),
  ('file', 'workhorse', 3, 'gemini-3.8-flash',  2, 'agent',         'Agent cheaper doc fallback', true),
  ('file', 'workhorse', 3, 'gpt-6.1-sol',       3, 'both',          'GPT document workhorse', true),
  ('file', 'workhorse', 3, 'grok-4.7',          4, 'both',          'Alternate doc workhorse', true),

  ('file', 'coding', 4, 'claude-sonnet-5-5', 1, 'both', 'Code from attached specs/PDFs', true),
  ('file', 'coding', 4, 'gpt-5.3-codex',     2, 'both', 'Codex with document context', true),
  ('file', 'coding', 4, 'claude-opus-5-5',   3, 'both', 'Hard spec→code fallback', true),
  ('file', 'coding', 4, 'gpt-6-astra',       4, 'both', 'High-capability doc+code fallback', true),

  ('file', 'reasoning', 5, 'claude-opus-5-5', 1, 'both', 'Deep contract / legal / long-doc reasoning', false),
  ('file', 'reasoning', 5, 'gpt-5.5-pro',     2, 'both', 'Hard document analysis', false),
  ('file', 'reasoning', 5, 'o3-pro',          3, 'both', 'Formal reasoning over documents', false),
  ('file', 'reasoning', 5, 'gpt-5.6-sol',     4, 'agent', 'Agent long-context file fallback (Sim Auto-like)', false),

  ('file', 'creative', 3, 'claude-fable-5-1', 1, 'both', 'Rewrite / tone from source docs', false),
  ('file', 'creative', 3, 'claude-fable-5',   2, 'both', 'Creative doc rewrite fallback (still served by Anthropic)', false),
  ('file', 'creative', 3, 'claude-opus-5-5',  3, 'both', 'High-quality long-form from docs', false),

  ('file', 'research', 5, 'deep-research-pro-preview-12-2025', 1, 'both', 'Research synthesis over uploaded corpora', true),
  ('file', 'research', 5, 'grok-4.20-multi-agent-0309',       2, 'both', 'Multi-agent doc research fallback', true),

  ('file', 'search', 2, 'deep-research-pro-preview-12-2025', 1, 'both', 'Doc + live research', true),
  ('file', 'search', 2, 'claude-sonnet-5-5',                 2, 'both', 'Doc Q&A fallback', true),
  ('file', 'search', 2, 'gpt-6.1-sol',                       3, 'both', 'GPT doc + tools fallback', true);

-- ========================= LIVE DATA =========================
INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('live_data', 'search', 2, 'deep-research-pro-preview-12-2025', 1, 'both', 'Primary live web / current events', true),
  ('live_data', 'search', 2, 'grok-4.7',                          2, 'both', 'Current-events fallback', false),
  ('live_data', 'search', 2, 'gpt-6.1-sol',                       3, 'both', 'General + tools fallback', true),

  ('live_data', 'fast', 1, 'grok-4.7',        1, 'both', 'Quick live fact check', false),
  ('live_data', 'fast', 1, 'gemini-3.8-flash', 2, 'both', 'Quick multimodal fallback', false),
  ('live_data', 'fast', 1, 'gpt-6.1-sol',     3, 'both', 'Quick GPT fallback', true),

  ('live_data', 'workhorse', 3, 'deep-research-pro-preview-12-2025', 1, 'both', 'Standard live-data agent turns', true),
  ('live_data', 'workhorse', 3, 'grok-4.7',                          2, 'both', 'Live workhorse fallback', true),
  ('live_data', 'workhorse', 3, 'gpt-6.1-sol',                       3, 'both', 'General model + tools', true),

  ('live_data', 'research', 5, 'deep-research-pro-preview-12-2025', 1, 'both', 'Exhaustive live research reports', true),
  ('live_data', 'research', 5, 'grok-4.20-multi-agent-0309',       2, 'both', 'Multi-agent live research', true),
  ('live_data', 'research', 5, 'gpt-6.1-sol',                      3, 'both', 'Research tools fallback', true),

  ('live_data', 'coding', 4, 'gpt-5.3-codex',     1, 'both', 'Code using live API/docs status', true),
  ('live_data', 'coding', 4, 'claude-sonnet-5-5', 2, 'both', 'Coding agent with live context tools', true),

  ('live_data', 'reasoning', 5, 'o3-pro',          1, 'both', 'Deep planning using live inputs', true),
  ('live_data', 'reasoning', 5, 'gpt-5.5-pro',     2, 'both', 'Hard reasoning + live facts', true),
  ('live_data', 'reasoning', 5, 'claude-opus-5-5', 3, 'both', 'Reasoning fallback with tools', true),

  ('live_data', 'creative', 3, 'claude-fable-5-1', 1, 'both', 'Creative copy using live references', false),
  ('live_data', 'creative', 3, 'grok-4.7',         2, 'both', 'Creative + live facts fallback', false);

COMMIT;


