/**
 * Arena Auto model router — Agent block only.
 *
 * Why this file exists (do not merge back into `resolve.ts`):
 * - Upstream Sim Auto (`@/lib/model-router/resolve`) calls mothership
 *   `/api/model-router` and bills Copilot credits.
 * - Arena Auto keeps routing local: gpt-5.4-nano classifier + Postgres tables
 *   `auto_route_tier` / `auto_routing_pool` (seed:
 *   `packages/db/migrations/auto-routing-pool-schema.sql`).
 *
 * Wire Agent through this module; leave Evaluator/Router on `resolve.ts`.
 */
import { createHash } from 'crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { autoRouteTier, autoRoutingPool, db } from '@sim/db'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { validateModelProvider } from '@/ee/access-control/utils/permission-check'
import type { ExecutionContext } from '@/executor/types'
import type { ModelCost } from '@/providers/cost-policy'
import { executeProviderRequest } from '@/providers'
import { getProviderFromModel } from '@/providers/utils'

const logger = createLogger('ArenaModelRouter')

/** Attachment kind from the Agent block (pre-DB mapping). */
export type AutoMediaKind = 'none' | 'image' | 'file'

/** Media kinds stored in `auto_routing_pool.media_kind`. */
export type DbAutoMediaKind = 'text' | 'image' | 'file' | 'live_data'

/**
 * Which product may use a pool row. Agent Auto queries `agent` + `both`.
 * `arena_copilot` is reserved for a future Arena Copilot surface.
 */
export type AutoProductSurface = 'agent' | 'arena_copilot'

/** Local classifier model — keep cheap; failures fall through to heuristics. */
const CLASSIFIER_MODEL = 'gpt-5.4-nano'
const MAX_SIGNAL_CHARS = 2000
/** Cap for prior-turn snippet sent to the classifier (keeps routing cheap). */
const MAX_RECENT_HISTORY_CHARS = 1200
const MAX_RECENT_HISTORY_TURNS = 6
const MAX_RECENT_HISTORY_TURN_CHARS = 280
const DECISION_CACHE_TTL_MS = 5 * 60 * 1000
const DECISION_CACHE_MAX_ENTRIES = 500
/** Heuristic upgrade from `text` → `live_data` when the prompt smells like realtime. */
const LIVE_DATA_HINT =
  /\b(current|live|today|price|weather|news|latest|realtime|real-time|stock|exchange rate)\b/i

/**
 * Hidden identity preamble prepended to the system prompt of every Arena Auto
 * execution (including fallback runs). Keeps pool models off the topic of
 * which underlying catalog model they are.
 */
export const ARENA_AUTO_SYSTEM_PREAMBLE = `You are the Arena Auto model. Respond in English unless the user writes in another language or explicitly asks for one. Do not volunteer information about which underlying model powers you; if asked directly, say you are the Arena Auto model.`

/**
 * Compatibility alias for Agent handler call sites that historically imported
 * `SIM_AUTO_SYSTEM_PREAMBLE` from `resolve.ts`. Prefer `ARENA_AUTO_SYSTEM_PREAMBLE`
 * in new Arena code.
 */
export const SIM_AUTO_SYSTEM_PREAMBLE = ARENA_AUTO_SYSTEM_PREAMBLE

/** Compact facts about the pending LLM-backed block task; never the full payload. */
export interface AutoRoutingSignals {
  systemPrompt?: string
  lastMessage?: string
  /**
   * Truncated prior turns (`role: content` lines) so follow-ups like
   * "add a for loop" still route with the earlier scenario in mind.
   * Built by `formatAutoRoutingRecentHistory` — not a separate summary LLM.
   */
  recentHistory?: string
  messageCount: number
  toolNames: string[]
  mediaKind: AutoMediaKind
  hasResponseFormat: boolean
  approxInputTokens: number
}

/** Minimal message shape used when building the routing history snippet. */
export interface AutoRoutingHistoryMessage {
  role?: string
  content?: unknown
}

/**
 * Builds a capped prior-turn snippet for Auto routing.
 * Keeps the most recent turns; drops the trailing message when it matches
 * `excludeTrailingContent` (usually the current `lastMessage`) so we do not
 * double-send the active prompt.
 */
export function formatAutoRoutingRecentHistory(
  messages: AutoRoutingHistoryMessage[] | undefined,
  options?: {
    maxTurns?: number
    maxChars?: number
    maxTurnChars?: number
    excludeTrailingContent?: string
  }
): string | undefined {
  if (!messages || messages.length === 0) return undefined

  const maxTurns = options?.maxTurns ?? MAX_RECENT_HISTORY_TURNS
  const maxChars = options?.maxChars ?? MAX_RECENT_HISTORY_CHARS
  const maxTurnChars = options?.maxTurnChars ?? MAX_RECENT_HISTORY_TURN_CHARS
  const excludeTrailing = options?.excludeTrailingContent?.trim()

  const lines: string[] = []
  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'user'
    if (role === 'system' || role === 'tool') continue

    const raw =
      typeof message.content === 'string'
        ? message.content
        : message.content != null
          ? JSON.stringify(message.content)
          : ''
    const content = raw.trim()
    if (!content) continue
    lines.push(`${role}: ${content.slice(0, maxTurnChars)}`)
  }

  if (lines.length === 0) return undefined

  if (excludeTrailing) {
    const last = lines[lines.length - 1] ?? ''
    const lastContent = last.replace(/^(user|assistant|model):\s*/i, '').trim()
    if (lastContent === excludeTrailing.slice(0, maxTurnChars).trim()) {
      lines.pop()
    }
  }

  if (lines.length === 0) return undefined

  const window = lines.slice(-maxTurns)
  let snippet = window.join('\n')
  if (snippet.length > maxChars) {
    snippet = snippet.slice(snippet.length - maxChars)
    const firstNewline = snippet.indexOf('\n')
    if (firstNewline > 0 && firstNewline < 80) {
      snippet = snippet.slice(firstNewline + 1)
    }
  }
  return snippet || undefined
}

export interface AutoRoutingResult {
  model: string
  /** Semantic tier code from `auto_route_tier` (e.g. coding), or null on fallback. */
  tier: string | null
  decidedBy: 'llm' | 'cache' | 'fallback' | 'heuristic'
  billableRoutingCost: number
  usage?: {
    model: string
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    cost: number
  }
  /** Classifier complexity_score (1–5). */
  complexityScore?: number
  /** `auto_routing_pool.selection_rank` of the chosen model (1 = primary). */
  selectionRank?: number
  /** Pool row complexity_score that matched (may differ from classifier when nearest). */
  poolComplexityScore?: number
}

export type AutoRoutedModelCost = ModelCost & { routing?: number }

/** Adds a successful Auto classifier call to a settled provider cost. */
export function addAutoRoutingCost(cost: ModelCost, routingCost: number): AutoRoutedModelCost {
  if (routingCost <= 0) return cost

  return {
    ...cost,
    routing: routingCost,
    total: cost.total + routingCost,
  }
}

interface TierCandidate {
  id: string
  hint: string
}

interface ClassifierDecision {
  tier: string
  complexityScore: number
  requiresTools: boolean
  decidedBy: 'llm' | 'heuristic'
  billableRoutingCost: number
  usage?: AutoRoutingResult['usage']
}

interface CacheEntry {
  tier: string
  complexityScore: number
  requiresTools: boolean
  mediaKind: DbAutoMediaKind
  expires: number
}

const decisionCache = new Map<string, CacheEntry>()

function cacheKey(
  signals: AutoRoutingSignals,
  productSurface: AutoProductSurface,
  mediaKind: DbAutoMediaKind
): string {
  const tokenBucket = Math.round(signals.approxInputTokens / 500)
  return createHash('sha256')
    .update(
      JSON.stringify([
        signals.systemPrompt ?? '',
        (signals.lastMessage ?? '').slice(0, 500),
        (signals.recentHistory ?? '').slice(0, 500),
        [...signals.toolNames].sort(),
        signals.hasResponseFormat,
        mediaKind,
        productSurface,
        tokenBucket,
      ])
    )
    .digest('hex')
}

function readDecisionCache(key: string): CacheEntry | null {
  const entry = decisionCache.get(key)
  if (!entry) return null
  if (entry.expires < Date.now()) {
    decisionCache.delete(key)
    return null
  }
  return entry
}

function writeDecisionCache(key: string, entry: Omit<CacheEntry, 'expires'>): void {
  if (decisionCache.size >= DECISION_CACHE_MAX_ENTRIES) {
    const oldest = decisionCache.keys().next().value
    if (oldest !== undefined) decisionCache.delete(oldest)
  }
  decisionCache.set(key, { ...entry, expires: Date.now() + DECISION_CACHE_TTL_MS })
}

/**
 * Maps Agent attachment kind (+ live-data heuristics) onto `auto_routing_pool.media_kind`.
 * `none` becomes `text`, unless the prompt/tools imply live/web → `live_data`.
 */
export function resolveDbMediaKind(signals: AutoRoutingSignals): DbAutoMediaKind {
  if (signals.mediaKind === 'image') return 'image'
  if (signals.mediaKind === 'file') return 'file'

  const haystack = `${signals.recentHistory ?? ''} ${signals.lastMessage ?? ''} ${signals.toolNames.join(' ')}`
  const wantsLive =
    LIVE_DATA_HINT.test(haystack) ||
    signals.toolNames.some((name) => /search|web|browser|exa/i.test(name))

  return wantsLive ? 'live_data' : 'text'
}

/** Active rows from `auto_route_tier` — classifier may only pick these codes. */
async function loadActiveTiers(): Promise<TierCandidate[]> {
  const rows = await db
    .select({
      id: autoRouteTier.tierCode,
      hint: autoRouteTier.description,
    })
    .from(autoRouteTier)
    .where(eq(autoRouteTier.isActive, true))
    .orderBy(asc(autoRouteTier.sortOrder))
    .limit(100)

  return rows
}

/**
 * Offline / no-key fallback when the classifier LLM fails.
 * Keyword heuristics only — must stay aligned with seeded tier codes.
 */
function classifyTierHeuristic(
  signals: AutoRoutingSignals,
  tiers: TierCandidate[]
): ClassifierDecision {
  // Include prior turns so follow-ups inherit scenario keywords (e.g. coding).
  const text =
    `${signals.systemPrompt ?? ''}\n${signals.recentHistory ?? ''}\n${signals.lastMessage ?? ''}`.toLowerCase()
  const tierIds = new Set(tiers.map((t) => t.id))
  const pick = (id: string, score: number, requiresTools: boolean): ClassifierDecision => ({
    tier: tierIds.has(id) ? id : (tiers[0]?.id ?? 'workhorse'),
    complexityScore: score,
    requiresTools,
    decidedBy: 'heuristic',
    billableRoutingCost: 0,
  })

  if (/\b(search|current|live|today|price|news)\b/.test(text) || signals.toolNames.length > 0) {
    if (/\b(search|current|live|price|news)\b/.test(text) && tierIds.has('search')) {
      return pick('search', 2, signals.toolNames.length > 0)
    }
  }
  if (
    /\b(code|refactor|debug|typescript|javascript|python|repo|compile|test|bug|for loop)\b/.test(
      text
    )
  ) {
    return pick('coding', 4, true)
  }
  if (/\b(prove|theorem|architect|constraint|formal|reason deeply|optimize algorithm)\b/.test(text)) {
    return pick('reasoning', 5, false)
  }
  if (/\b(story|poem|tone|copywriting|worldbuild|narrative|creative)\b/.test(text)) {
    return pick('creative', 3, false)
  }
  if (/\b(research|literature|synthesize|exhaustive|multi-agent)\b/.test(text)) {
    return pick('research', 5, true)
  }
  if (
    signals.approxInputTokens < 400 &&
    signals.toolNames.length === 0 &&
    !signals.hasResponseFormat
  ) {
    return pick('fast', 1, false)
  }
  return pick('workhorse', 3, signals.toolNames.length > 0)
}

/**
 * Asks CLASSIFIER_MODEL for `{ tier, complexity_score, requires_tools }`.
 * Returns null on any failure so the caller can use `classifyTierHeuristic`.
 */
async function classifyTierWithLlm(
  signals: AutoRoutingSignals,
  tiers: TierCandidate[],
  ctx: ExecutionContext,
  blockId: string
): Promise<ClassifierDecision | null> {
  if (tiers.length === 0) return null

  const systemPrompt = `You are a model router. Choose exactly one tier for the task.
Use recentHistory (prior turns) plus lastMessage (current user turn). Follow-ups
like "add a for loop" should keep the prior scenario's tier when clear.
Reply ONLY with JSON:
{"tier":"<tier_code>","complexity_score":1,"requires_tools":false,"rationale":"short"}

Valid tiers:
${tiers.map((t) => `- ${t.id}: ${t.hint}`).join('\n')}

complexity_score is 1 (trivial) to 5 (hardest).`

  const userPrompt = JSON.stringify({
    systemPrompt: (signals.systemPrompt ?? '').slice(0, MAX_SIGNAL_CHARS),
    recentHistory: (signals.recentHistory ?? '').slice(0, MAX_RECENT_HISTORY_CHARS),
    lastMessage: (signals.lastMessage ?? '').slice(0, MAX_SIGNAL_CHARS),
    messageCount: signals.messageCount,
    toolNames: signals.toolNames,
    hasResponseFormat: signals.hasResponseFormat,
    approxInputTokens: signals.approxInputTokens,
    mediaKind: signals.mediaKind,
  })

  try {
    getProviderFromModel(CLASSIFIER_MODEL)
    await validateModelProvider(ctx.userId, ctx.workspaceId ?? undefined, CLASSIFIER_MODEL, ctx)

    const response = await executeProviderRequest(getProviderFromModel(CLASSIFIER_MODEL), {
      model: CLASSIFIER_MODEL,
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      workflowId: ctx.workflowId,
      executionId: ctx.executionId,
      blockId,
      responseFormat: {
        name: 'auto_route_decision',
        schema: {
          type: 'object',
          properties: {
            tier: { type: 'string' },
            complexity_score: { type: 'number' },
            requires_tools: { type: 'boolean' },
            rationale: { type: 'string' },
          },
          required: ['tier', 'complexity_score', 'requires_tools'],
          additionalProperties: false,
        },
        strict: true,
      },
    })

    if (!('content' in response) || typeof response.content !== 'string') {
      return null
    }

    const parsed = JSON.parse(response.content) as {
      tier?: string
      complexity_score?: number
      requires_tools?: boolean
    }

    const tier = tiers.find((t) => t.id === parsed.tier)?.id
    if (!tier) return null

    const complexityScore = Math.min(
      5,
      Math.max(1, Math.round(Number(parsed.complexity_score) || 3))
    )

    return {
      tier,
      complexityScore,
      requiresTools: Boolean(parsed.requires_tools),
      decidedBy: 'llm',
      billableRoutingCost: response.cost?.total ?? 0,
      usage: {
        model: CLASSIFIER_MODEL,
        inputTokens: response.tokens?.input ?? 0,
        cachedInputTokens: 0,
        outputTokens: response.tokens?.output ?? 0,
        cost: response.cost?.total ?? 0,
      },
    }
  } catch (error) {
    logger.warn('Auto classifier LLM failed; will use heuristic', {
      blockId,
      error: getErrorMessage(error, 'classifier error'),
    })
    return null
  }
}

interface PoolPick {
  modelId: string
  selectionRank: number
  poolComplexityScore: number
}

/**
 * Loads active `auto_routing_pool` rows for media+tier+product, then ranks in JS:
 * exact complexity → product match → nearest complexity → selection_rank.
 * Skips models the workspace cannot use (provider / permission check).
 */
async function pickModelFromPool(args: {
  mediaKind: DbAutoMediaKind
  tier: string
  complexityScore: number
  requiresTools: boolean
  productSurface: AutoProductSurface
  ctx: ExecutionContext
}): Promise<PoolPick | null> {
  const { mediaKind, tier, complexityScore, requiresTools, productSurface, ctx } = args

  const rows = await db
    .select({
      modelId: autoRoutingPool.modelId,
      selectionRank: autoRoutingPool.selectionRank,
      complexityScore: autoRoutingPool.complexityScore,
      productSurface: autoRoutingPool.productSurface,
      requiresTools: autoRoutingPool.requiresTools,
    })
    .from(autoRoutingPool)
    .innerJoin(autoRouteTier, eq(autoRoutingPool.routeTier, autoRouteTier.tierCode))
    .where(
      and(
        eq(autoRoutingPool.mediaKind, mediaKind),
        eq(autoRoutingPool.routeTier, tier),
        eq(autoRoutingPool.isActive, true),
        eq(autoRouteTier.isActive, true),
        inArray(autoRoutingPool.productSurface, [productSurface, 'both'])
      )
    )
    .orderBy(asc(autoRoutingPool.selectionRank))
    .limit(100)

  const filtered = rows.filter((row) => {
    if (row.requiresTools == null) return true
    return row.requiresTools === requiresTools
  })
  const poolRows = filtered.length > 0 ? filtered : rows
  const candidates = [...poolRows].sort((left, right) => {
    const leftExact = left.complexityScore === complexityScore ? 0 : 1
    const rightExact = right.complexityScore === complexityScore ? 0 : 1
    if (leftExact !== rightExact) return leftExact - rightExact

    const leftProduct = left.productSurface === productSurface ? 0 : 1
    const rightProduct = right.productSurface === productSurface ? 0 : 1
    if (leftProduct !== rightProduct) return leftProduct - rightProduct

    const leftDistance = Math.abs(left.complexityScore - complexityScore)
    const rightDistance = Math.abs(right.complexityScore - complexityScore)
    if (leftDistance !== rightDistance) return leftDistance - rightDistance

    return left.selectionRank - right.selectionRank
  })

  const tried = new Set<string>()
  for (const row of candidates) {
    if (tried.has(row.modelId)) continue
    tried.add(row.modelId)
    try {
      getProviderFromModel(row.modelId)
      await validateModelProvider(ctx.userId, ctx.workspaceId ?? undefined, row.modelId, ctx)
      return {
        modelId: row.modelId,
        selectionRank: row.selectionRank,
        poolComplexityScore: row.complexityScore,
      }
    } catch {
      logger.info('Auto pool candidate unavailable, trying next', {
        model: row.modelId,
        selectionRank: row.selectionRank,
        poolComplexityScore: row.complexityScore,
        requestedComplexityScore: complexityScore,
      })
    }
  }
  return null
}

/**
 * Resolves Agent `sim-auto` → concrete catalog model via Arena DB pool.
 *
 * Flow: media kind → load tiers → (cache | LLM | heuristic) → pool pick.
 * Never throws: empty tiers, empty pool, or classifier failure → `fallbackModel`.
 *
 * Call only from Agent (`productSurface: 'agent'`). Evaluator/Router stay on
 * `@/lib/model-router/resolve` (Sim mothership).
 */
export async function resolveAutoModel(args: {
  ctx: ExecutionContext
  blockId: string
  signals: AutoRoutingSignals
  fallbackModel: string
  productSurface?: AutoProductSurface
}): Promise<AutoRoutingResult> {
  const { ctx, blockId, signals, fallbackModel } = args
  const productSurface = args.productSurface ?? 'agent'
  const fallback: AutoRoutingResult = {
    model: fallbackModel,
    tier: null,
    decidedBy: 'fallback',
    billableRoutingCost: 0,
  }

  try {
    const mediaKind = resolveDbMediaKind(signals)
    const tiers = await loadActiveTiers()
    if (tiers.length === 0) {
      logger.warn('arena-auto: no active tiers in auto_route_tier, using fallback', { blockId })
      return fallback
    }

    const key = cacheKey(signals, productSurface, mediaKind)
    const cached = readDecisionCache(key)
    if (cached) {
      const pick = await pickModelFromPool({
        mediaKind: cached.mediaKind,
        tier: cached.tier,
        complexityScore: cached.complexityScore,
        requiresTools: cached.requiresTools,
        productSurface,
        ctx,
      })
      if (!pick) return fallback
      logger.info('arena-auto: resolved from cache', {
        blockId,
        model: pick.modelId,
        tier: cached.tier,
        mediaKind: cached.mediaKind,
        complexityScore: cached.complexityScore,
        poolComplexityScore: pick.poolComplexityScore,
        selectionRank: pick.selectionRank,
        decidedBy: 'cache',
        productSurface,
      })
      return {
        model: pick.modelId,
        tier: cached.tier,
        decidedBy: 'cache',
        billableRoutingCost: 0,
        complexityScore: cached.complexityScore,
        selectionRank: pick.selectionRank,
        poolComplexityScore: pick.poolComplexityScore,
      }
    }

    const llmDecision = await classifyTierWithLlm(signals, tiers, ctx, blockId)
    const decision = llmDecision ?? classifyTierHeuristic(signals, tiers)

    logger.info('arena-auto: classifier decision', {
      blockId,
      tier: decision.tier,
      complexityScore: decision.complexityScore,
      requiresTools: decision.requiresTools,
      decidedBy: decision.decidedBy,
      mediaKind,
    })

    writeDecisionCache(key, {
      tier: decision.tier,
      complexityScore: decision.complexityScore,
      requiresTools: decision.requiresTools,
      mediaKind,
    })

    const pick = await pickModelFromPool({
      mediaKind,
      tier: decision.tier,
      complexityScore: decision.complexityScore,
      requiresTools: decision.requiresTools,
      productSurface,
      ctx,
    })
    if (!pick) {
      logger.warn('arena-auto: no usable pool model, using fallback', {
        blockId,
        tier: decision.tier,
        mediaKind,
        complexityScore: decision.complexityScore,
      })
      return fallback
    }

    logger.info('arena-auto: resolved model from DB pool', {
      blockId,
      model: pick.modelId,
      tier: decision.tier,
      mediaKind,
      complexityScore: decision.complexityScore,
      poolComplexityScore: pick.poolComplexityScore,
      selectionRank: pick.selectionRank,
      decidedBy: decision.decidedBy,
      productSurface,
    })

    return {
      model: pick.modelId,
      tier: decision.tier,
      decidedBy: decision.decidedBy,
      billableRoutingCost: decision.billableRoutingCost,
      usage: decision.usage,
      complexityScore: decision.complexityScore,
      selectionRank: pick.selectionRank,
      poolComplexityScore: pick.poolComplexityScore,
    }
  } catch (error) {
    logger.warn('arena-auto: routing failed, using fallback model', {
      blockId,
      error: getErrorMessage(error, 'unknown routing error'),
    })
    return fallback
  }
}
