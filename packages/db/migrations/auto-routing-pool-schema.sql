
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

  -- Classifier complexity 1–5 this slot targets (seed one model per score per tier).
  -- Runtime: prefer exact match; else nearest score, then selection_rank.
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
  'Tie-break / error-fallback order within a media+tier+product. Prefer aligning with complexity_score (1↔1 … 5↔5).';

COMMENT ON COLUMN auto_routing_pool.product_surface IS
  'agent = Agent block Auto; arena_copilot = Arena Copilot Auto; both = shared.';

COMMENT ON COLUMN auto_routing_pool.complexity_score IS
  'Classifier complexity 1–5 this model slot targets. Same media+tier should seed distinct scores (different models). Runtime prefers exact match, then nearest score, then selection_rank.';

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
--      • Search / live pool: no Google deep-research (needs Interactions agent
--        access). Prefer grok / gpt / gemini. Arena Auto preamble supplies UTC date.
-- ---------------------------------------------------------------------------

-- Re-runnable seed: wipe pool rows then re-insert (tier defs upsert above).
-- If you emptied both tables yourself, this DELETE is a no-op.
--
-- Complexity layout (same for every media_kind × route_tier):
--   complexity_score 1..5 each maps to a *different* model.
--   selection_rank mirrors the score (1↔1 … 5↔5) so exact match is clear;
--   on provider error, Agent still walks nearest other scores by rank.
DELETE FROM auto_routing_pool;

-- ========================= TEXT =========================
INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  -- fast
  ('text', 'fast', 1, 'gpt-5.4-nano',          1, 'both', 'Trivial triage / format', false),
  ('text', 'fast', 2, 'gemini-3.5-flash-lite', 2, 'both', 'Cheap high-throughput extract', false),
  ('text', 'fast', 3, 'claude-haiku-5-5',      3, 'both', 'Fast instruction following', false),
  ('text', 'fast', 4, 'gpt-5.4-mini',          4, 'both', 'Stronger mini fast path', false),
  ('text', 'fast', 5, 'gemini-3.8-flash',      5, 'both', 'Hardest still-fast tasks', false),

  -- workhorse (score 3 defaults differ by product)
  ('text', 'workhorse', 1, 'gpt-5.4-mini',       1, 'both',          'Light everyday chat', true),
  ('text', 'workhorse', 2, 'claude-haiku-5-5',   2, 'both',          'Snappy general agent', true),
  ('text', 'workhorse', 3, 'gpt-6.1-sol',        3, 'agent',         'Default Agent everyday + tools', true),
  ('text', 'workhorse', 3, 'gemini-3.8-flash',   3, 'arena_copilot', 'Default Copilot everyday multimodal', true),
  ('text', 'workhorse', 4, 'claude-sonnet-5-5',  4, 'both',          'Stronger general agent', true),
  ('text', 'workhorse', 5, 'gpt-6-astra',        5, 'both',          'Hardest workhorse turns', true),

  -- coding
  ('text', 'coding', 1, 'gpt-5.4-mini',       1, 'both', 'Tiny code edits / snippets', true),
  ('text', 'coding', 2, 'gemini-3.8-flash',   2, 'both', 'Small coding tasks', true),
  ('text', 'coding', 3, 'claude-sonnet-5-5',  3, 'both', 'Multi-file coding agent', true),
  ('text', 'coding', 4, 'gpt-5.3-codex',      4, 'both', 'Repo edits / tool+bash loops', true),
  ('text', 'coding', 5, 'claude-opus-5-5',    5, 'both', 'Hard architectural code changes', true),

  -- reasoning
  ('text', 'reasoning', 1, 'gpt-5.4-mini',             1, 'both',          'Light reasoning', false),
  ('text', 'reasoning', 2, 'grok-4.20-0309-reasoning', 2, 'both',          'Moderate reasoning', false),
  ('text', 'reasoning', 3, 'claude-sonnet-5-5',        3, 'both',          'Solid planning / logic', false),
  ('text', 'reasoning', 4, 'gpt-5.5-pro',              4, 'both',          'Hard constraint solving', false),
  ('text', 'reasoning', 5, 'o3-pro',                   5, 'both',          'Hardest math / formal logic', false),

  -- creative
  ('text', 'creative', 1, 'claude-haiku-5-5',  1, 'both', 'Short creative rewrites', false),
  ('text', 'creative', 2, 'claude-fable-5',    2, 'both', 'Creative long-form (legacy fable)', false),
  ('text', 'creative', 3, 'claude-fable-5-1',  3, 'both', 'Primary storytelling / tone', false),
  ('text', 'creative', 4, 'claude-sonnet-5-5', 4, 'both', 'Richer creative prose', false),
  ('text', 'creative', 5, 'claude-opus-5-5',   5, 'both', 'Highest-quality creative', false),

  -- research
  ('text', 'research', 1, 'gpt-6.1-sol',                1, 'both', 'Light research synthesis', true),
  ('text', 'research', 2, 'claude-sonnet-5-5',          2, 'both', 'Standard research write-up', true),
  ('text', 'research', 3, 'gpt-6-astra',                3, 'both', 'Deeper research synthesis', true),
  ('text', 'research', 4, 'claude-opus-5-5',            4, 'both', 'Hard research reports', true),
  ('text', 'research', 5, 'grok-4.20-multi-agent-0309', 5, 'both', 'Exhaustive multi-agent research', true),

  -- search / live facts
  ('text', 'search', 1, 'gemini-3.8-flash',  1, 'both', 'Simple live lookups', true),
  ('text', 'search', 2, 'grok-4.7',          2, 'both', 'Current-events (XAI)', false),
  ('text', 'search', 3, 'gpt-6.1-sol',       3, 'both', 'Live facts + tools', true),
  ('text', 'search', 4, 'claude-sonnet-5-5', 4, 'both', 'Harder live research', true),
  ('text', 'search', 5, 'gpt-6-astra',       5, 'both', 'Hardest live / multi-source', true);

-- ========================= IMAGE =========================
INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('image', 'fast', 1, 'gemini-3.5-flash-lite', 1, 'both', 'Trivial image classify', false),
  ('image', 'fast', 2, 'gemini-3.8-flash',      2, 'both', 'Quick vision skim', false),
  ('image', 'fast', 3, 'claude-haiku-5-5',      3, 'both', 'Fast vision Q&A', false),
  ('image', 'fast', 4, 'gpt-5.4-mini',          4, 'both', 'Stronger fast vision', false),
  ('image', 'fast', 5, 'claude-sonnet-5-5',     5, 'both', 'Hardest still-fast vision', false),

  ('image', 'workhorse', 1, 'gemini-3.5-flash-lite', 1, 'both', 'Light multimodal chat', true),
  ('image', 'workhorse', 2, 'gemini-3.8-flash',      2, 'both', 'Standard vision chat', true),
  ('image', 'workhorse', 3, 'gpt-6.1-sol',           3, 'both', 'Vision + tools workhorse', true),
  ('image', 'workhorse', 4, 'claude-sonnet-5-5',     4, 'both', 'Strong vision agent', true),
  ('image', 'workhorse', 5, 'gpt-6-astra',           5, 'both', 'Hardest multimodal workhorse', true),

  ('image', 'coding', 1, 'gpt-5.4-mini',      1, 'both', 'Tiny UI/code from screenshot', true),
  ('image', 'coding', 2, 'gemini-3.8-flash',  2, 'both', 'Simple vision→code', true),
  ('image', 'coding', 3, 'claude-sonnet-5-5', 3, 'both', 'Vision + coding agent', true),
  ('image', 'coding', 4, 'gpt-5.3-codex',     4, 'both', 'Repo edits from screenshots', true),
  ('image', 'coding', 5, 'claude-opus-5-5',   5, 'both', 'Hard vision+architecture code', true),

  ('image', 'reasoning', 1, 'gpt-5.4-mini',     1, 'both', 'Light visual reasoning', false),
  ('image', 'reasoning', 2, 'gemini-3.8-flash', 2, 'both', 'Moderate diagram reasoning', false),
  ('image', 'reasoning', 3, 'claude-sonnet-5-5',3, 'both', 'Solid multimodal reasoning', false),
  ('image', 'reasoning', 4, 'gpt-5.5-pro',      4, 'both', 'Hard visual reasoning', false),
  ('image', 'reasoning', 5, 'o3-pro',           5, 'both', 'Hardest formal visual reasoning', false),

  ('image', 'creative', 1, 'claude-haiku-5-5',  1, 'both', 'Short image-grounded copy', false),
  ('image', 'creative', 2, 'claude-fable-5',    2, 'both', 'Creative from images (legacy)', false),
  ('image', 'creative', 3, 'claude-fable-5-1',  3, 'both', 'Primary creative + images', false),
  ('image', 'creative', 4, 'claude-sonnet-5-5', 4, 'both', 'Richer multimodal creative', false),
  ('image', 'creative', 5, 'claude-opus-5-5',   5, 'both', 'Highest-quality multimodal creative', false),

  ('image', 'research', 1, 'gpt-6.1-sol',                1, 'both', 'Light research with figures', true),
  ('image', 'research', 2, 'claude-sonnet-5-5',          2, 'both', 'Standard figure-backed research', true),
  ('image', 'research', 3, 'gpt-6-astra',                3, 'both', 'Deeper multimodal research', true),
  ('image', 'research', 4, 'claude-opus-5-5',            4, 'both', 'Hard research with screenshots', true),
  ('image', 'research', 5, 'grok-4.20-multi-agent-0309', 5, 'both', 'Exhaustive multi-agent + images', true),

  ('image', 'search', 1, 'gemini-3.8-flash',  1, 'both', 'Simple image + live lookup', true),
  ('image', 'search', 2, 'grok-4.7',          2, 'both', 'Image + current events', false),
  ('image', 'search', 3, 'gpt-6.1-sol',       3, 'both', 'Image + live tools', true),
  ('image', 'search', 4, 'claude-sonnet-5-5', 4, 'both', 'Harder live + vision', true),
  ('image', 'search', 5, 'gpt-6-astra',       5, 'both', 'Hardest live multimodal', true);

-- ========================= FILE (PDF / docs / non-image) =========================
INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('file', 'fast', 1, 'gemini-3.5-flash-lite', 1, 'both', 'Trivial PDF field extract', false),
  ('file', 'fast', 2, 'gemini-3.8-flash',      2, 'both', 'Fast document skim', false),
  ('file', 'fast', 3, 'claude-haiku-5-5',      3, 'both', 'Fast doc Q&A', false),
  ('file', 'fast', 4, 'gpt-5.4-mini',          4, 'both', 'Stronger fast doc path', false),
  ('file', 'fast', 5, 'claude-sonnet-5-5',     5, 'both', 'Hardest still-fast docs', false),

  ('file', 'workhorse', 1, 'gemini-3.5-flash-lite', 1, 'both',          'Light doc chat', true),
  ('file', 'workhorse', 2, 'gemini-3.8-flash',      2, 'both',          'Standard doc chat', true),
  ('file', 'workhorse', 3, 'claude-sonnet-5-5',     3, 'agent',         'Default Agent PDF/doc workflows', true),
  ('file', 'workhorse', 3, 'gemini-3.8-flash',      3, 'arena_copilot', 'Default Copilot attached docs', true),
  ('file', 'workhorse', 4, 'gpt-6.1-sol',           4, 'both',          'Stronger doc workhorse', true),
  ('file', 'workhorse', 5, 'gpt-6-astra',           5, 'both',          'Hardest long-doc workhorse', true),

  ('file', 'coding', 1, 'gpt-5.4-mini',      1, 'both', 'Tiny code from a short spec', true),
  ('file', 'coding', 2, 'gemini-3.8-flash',  2, 'both', 'Simple spec→code', true),
  ('file', 'coding', 3, 'claude-sonnet-5-5', 3, 'both', 'Code from attached specs', true),
  ('file', 'coding', 4, 'gpt-5.3-codex',     4, 'both', 'Codex with document context', true),
  ('file', 'coding', 5, 'claude-opus-5-5',   5, 'both', 'Hard spec→architecture code', true),

  ('file', 'reasoning', 1, 'gpt-5.4-mini',     1, 'both',  'Light doc reasoning', false),
  ('file', 'reasoning', 2, 'claude-sonnet-5-5',2, 'both',  'Moderate contract / doc analysis', false),
  ('file', 'reasoning', 3, 'gpt-5.6-sol',      3, 'agent', 'Long-context file reasoning', false),
  ('file', 'reasoning', 3, 'gpt-5.5-pro',      3, 'both',  'Solid document analysis', false),
  ('file', 'reasoning', 4, 'claude-opus-5-5',  4, 'both',  'Deep legal / long-doc reasoning', false),
  ('file', 'reasoning', 5, 'o3-pro',           5, 'both',  'Hardest formal doc reasoning', false),

  ('file', 'creative', 1, 'claude-haiku-5-5',  1, 'both', 'Short rewrite from docs', false),
  ('file', 'creative', 2, 'claude-fable-5',    2, 'both', 'Creative rewrite (legacy fable)', false),
  ('file', 'creative', 3, 'claude-fable-5-1',  3, 'both', 'Primary tone rewrite from docs', false),
  ('file', 'creative', 4, 'claude-sonnet-5-5', 4, 'both', 'Richer long-form from docs', false),
  ('file', 'creative', 5, 'claude-opus-5-5',   5, 'both', 'Highest-quality doc creative', false),

  ('file', 'research', 1, 'gpt-6.1-sol',                1, 'both', 'Light doc research', true),
  ('file', 'research', 2, 'claude-sonnet-5-5',          2, 'both', 'Standard corpus research', true),
  ('file', 'research', 3, 'gpt-6-astra',                3, 'both', 'Deeper uploaded-corpus research', true),
  ('file', 'research', 4, 'claude-opus-5-5',            4, 'both', 'Hard research over docs', true),
  ('file', 'research', 5, 'grok-4.20-multi-agent-0309', 5, 'both', 'Exhaustive multi-agent doc research', true),

  ('file', 'search', 1, 'gemini-3.8-flash',  1, 'both', 'Simple doc + live lookup', true),
  ('file', 'search', 2, 'grok-4.7',          2, 'both', 'Doc + current events', false),
  ('file', 'search', 3, 'gpt-6.1-sol',       3, 'both', 'Doc + live tools', true),
  ('file', 'search', 4, 'claude-sonnet-5-5', 4, 'both', 'Harder doc + live', true),
  ('file', 'search', 5, 'gpt-6-astra',       5, 'both', 'Hardest doc + live', true);

-- ========================= LIVE DATA =========================
INSERT INTO auto_routing_pool
  (media_kind, route_tier, complexity_score, model_id, selection_rank, product_surface, best_for, requires_tools) VALUES
  ('live_data', 'fast', 1, 'grok-4.7',          1, 'both', 'Trivial live fact', false),
  ('live_data', 'fast', 2, 'gemini-3.8-flash',  2, 'both', 'Quick live check', false),
  ('live_data', 'fast', 3, 'gpt-6.1-sol',       3, 'both', 'Fast live + tools', true),
  ('live_data', 'fast', 4, 'claude-sonnet-5-5', 4, 'both', 'Stronger fast live', true),
  ('live_data', 'fast', 5, 'gpt-6-astra',       5, 'both', 'Hardest still-fast live', true),

  ('live_data', 'workhorse', 1, 'grok-4.7',          1, 'both', 'Light live agent turn', false),
  ('live_data', 'workhorse', 2, 'gemini-3.8-flash',  2, 'both', 'Standard live workhorse', true),
  ('live_data', 'workhorse', 3, 'gpt-6.1-sol',       3, 'both', 'Default live + tools', true),
  ('live_data', 'workhorse', 4, 'claude-sonnet-5-5', 4, 'both', 'Stronger live agent', true),
  ('live_data', 'workhorse', 5, 'gpt-6-astra',       5, 'both', 'Hardest live workhorse', true),

  ('live_data', 'coding', 1, 'gpt-5.4-mini',      1, 'both', 'Tiny code + live API status', true),
  ('live_data', 'coding', 2, 'gemini-3.8-flash',  2, 'both', 'Simple live-aware coding', true),
  ('live_data', 'coding', 3, 'claude-sonnet-5-5', 3, 'both', 'Coding with live context tools', true),
  ('live_data', 'coding', 4, 'gpt-5.3-codex',     4, 'both', 'Repo edits using live docs/status', true),
  ('live_data', 'coding', 5, 'claude-opus-5-5',   5, 'both', 'Hard live-aware architecture code', true),

  ('live_data', 'reasoning', 1, 'gpt-5.4-mini',     1, 'both', 'Light live planning', true),
  ('live_data', 'reasoning', 2, 'claude-sonnet-5-5',2, 'both', 'Moderate live reasoning', true),
  ('live_data', 'reasoning', 3, 'gpt-5.5-pro',      3, 'both', 'Solid reasoning + live facts', true),
  ('live_data', 'reasoning', 4, 'claude-opus-5-5',  4, 'both', 'Hard reasoning + live', true),
  ('live_data', 'reasoning', 5, 'o3-pro',           5, 'both', 'Hardest planning with live inputs', true),

  ('live_data', 'creative', 1, 'claude-haiku-5-5',  1, 'both', 'Short live-aware copy', false),
  ('live_data', 'creative', 2, 'grok-4.7',          2, 'both', 'Creative + live facts', false),
  ('live_data', 'creative', 3, 'claude-fable-5-1',  3, 'both', 'Primary creative + live refs', false),
  ('live_data', 'creative', 4, 'claude-sonnet-5-5', 4, 'both', 'Richer live-aware creative', false),
  ('live_data', 'creative', 5, 'claude-opus-5-5',   5, 'both', 'Highest-quality live creative', false),

  ('live_data', 'research', 1, 'gpt-6.1-sol',                1, 'both', 'Light live research', true),
  ('live_data', 'research', 2, 'claude-sonnet-5-5',          2, 'both', 'Standard live research', true),
  ('live_data', 'research', 3, 'gpt-6-astra',                3, 'both', 'Deeper live research', true),
  ('live_data', 'research', 4, 'claude-opus-5-5',            4, 'both', 'Hard live research reports', true),
  ('live_data', 'research', 5, 'grok-4.20-multi-agent-0309', 5, 'both', 'Exhaustive live multi-agent research', true),

  ('live_data', 'search', 1, 'gemini-3.8-flash',  1, 'both', 'Simple live lookup', true),
  ('live_data', 'search', 2, 'grok-4.7',          2, 'both', 'Primary current events (XAI)', false),
  ('live_data', 'search', 3, 'gpt-6.1-sol',       3, 'both', 'Live facts + tools', true),
  ('live_data', 'search', 4, 'claude-sonnet-5-5', 4, 'both', 'Harder live / multi-source', true),
  ('live_data', 'search', 5, 'gpt-6-astra',       5, 'both', 'Hardest live search', true);

COMMIT;


