import { getRotatingApiKey } from '@/lib/core/config/api-keys'
import { isHosted } from '@/lib/core/config/env-flags'
import {
  DEFAULT_LOCAL_COPILOT_CATALOG_ID,
  type LocalCopilotCatalogId,
  resolveLocalCopilotCatalogEntry,
} from '@/local-copilot/lib/model-catalog'
import { listLocalCopilotGeminiApiKeys } from '@/local-copilot/lib/providers/gemini-keys'
import {
  getLocalCopilotVertexNotConfiguredMessage,
  isLocalCopilotVertexConfigured,
} from '@/local-copilot/lib/providers/vertex-auth'
import type { LocalCopilotConfig, LocalCopilotProviderId } from '@/local-copilot/lib/types'

/** Default Local Copilot main agent model (override with `COPILOT_MODEL`). */
export const DEFAULT_LOCAL_COPILOT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MODEL = DEFAULT_LOCAL_COPILOT_MODEL
/**
 * Default specialist / parallel-subagent model when `COPILOT_PROVIDER=anthropic`
 * and `COPILOT_SPECIALIST_MODEL` is unset. Cheaper than Sonnet for leaf tool work.
 */
const DEFAULT_ANTHROPIC_SPECIALIST_MODEL = 'claude-haiku-5-5'
/**
 * Default specialist / parallel-subagent model for Gemini (GenAI) parents.
 * Flash-Lite is the speed-optimized leaf; same API key as catalog Gemini models.
 */
const DEFAULT_GEMINI_SPECIALIST_MODEL = 'gemini-3.5-flash-lite'
/**
 * Default specialist / parallel-subagent model for Vertex parents. Same Google
 * AI Studio Flash-Lite id as the GenAI Gemini path (Vertex only changes auth/backend).
 */
const DEFAULT_VERTEX_SPECIALIST_MODEL = 'gemini-3.5-flash-lite'
/**
 * Default specialist / parallel-subagent model for Bedrock parents. Haiku 4.5
 * is the fast Claude on Bedrock; Converse uses the same AWS credentials as
 * Opus/Sonnet/GLM catalog entries.
 */
const DEFAULT_BEDROCK_SPECIALIST_MODEL = 'anthropic.claude-haiku-5-5'
const DEFAULT_PROVIDER: LocalCopilotProviderId = 'anthropic'
const DEFAULT_BEDROCK_REGION = 'us-east-1'
/** Default Gemini/Vertex thinking level — `medium` balances CoT visibility vs TTFT. */
const DEFAULT_GEMINI_THINKING_LEVEL = 'medium'
/** Default Anthropic thinking effort — balances latency vs reasoning depth. */
const DEFAULT_ANTHROPIC_THINKING_LEVEL = 'medium'

const GEMINI_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'none'])
const ANTHROPIC_THINKING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'none'])

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return value === 'true' || value === '1'
}

function usesGeminiThinking(provider: LocalCopilotProviderId): boolean {
  return provider === 'gemini' || provider === 'vertex'
}

/** Claude-via-proxy, native Anthropic, and Bedrock Claude share effort levels. */
function usesClaudeStyleThinkingLevels(provider: LocalCopilotProviderId): boolean {
  return (
    provider === 'anthropic' ||
    provider === 'openai-compatible' ||
    provider === 'openai' ||
    provider === 'bedrock'
  )
}

/**
 * Resolves `COPILOT_THINKING_LEVEL` for Local Copilot providers that stream
 * thinking (Gemini/Vertex, Anthropic, and OpenAI-compatible Claude proxies).
 */
export function resolveLocalCopilotThinkingLevel(
  provider: LocalCopilotProviderId,
  override = process.env.COPILOT_THINKING_LEVEL?.trim()
): string | undefined {
  if (usesGeminiThinking(provider)) {
    if (!override) return DEFAULT_GEMINI_THINKING_LEVEL
    const normalized = override.toLowerCase()
    // Gemini 3.8 Flash rejects `minimal`; treat it as `low` for latency-sensitive configs.
    if (normalized === 'minimal') return 'low'
    return GEMINI_THINKING_LEVELS.has(normalized) ? normalized : DEFAULT_GEMINI_THINKING_LEVEL
  }

  if (usesClaudeStyleThinkingLevels(provider)) {
    if (!override) return DEFAULT_ANTHROPIC_THINKING_LEVEL
    const normalized = override.toLowerCase()
    return ANTHROPIC_THINKING_LEVELS.has(normalized) ? normalized : DEFAULT_ANTHROPIC_THINKING_LEVEL
  }

  return undefined
}

/**
 * Caps thinking for file/office generation turns. Medium/high Claude thinking
 * often burns minutes eyeballing `Unexpected token` / table syntax instead of
 * rewriting `edit_content` — keep the tip on, but prefer `low` for file work.
 */
export function resolveFileTurnThinkingLevel(configured: string | undefined): string | undefined {
  if (!configured || configured === 'none') return configured
  const normalized = configured.trim().toLowerCase()
  if (normalized === 'high' || normalized === 'medium') return 'low'
  return configured
}

/**
 * Live engagement status LLM (tool heartbeats only when enabled).
 * Model-wait copy uses provider thinking summaries instead.
 * Off by default — set `COPILOT_ENGAGEMENT_STATUS=true` to re-enable tool engagement.
 */
export function isLocalCopilotEngagementStatusEnabled(
  override = process.env.COPILOT_ENGAGEMENT_STATUS
): boolean {
  return parseBoolean(override, false)
}

function resolveProvider(value: string | undefined): LocalCopilotProviderId {
  const normalized = (value ?? DEFAULT_PROVIDER).trim().toLowerCase()
  const allowed: LocalCopilotProviderId[] = [
    'openai',
    'anthropic',
    'azure-openai',
    'bedrock',
    'gemini',
    'vertex',
    'openai-compatible',
  ]
  return allowed.includes(normalized as LocalCopilotProviderId)
    ? (normalized as LocalCopilotProviderId)
    : DEFAULT_PROVIDER
}

function isBedrockModelId(modelId: string): boolean {
  return /^(?:(?:us|eu|apac|global|us-gov)\.)?(anthropic|amazon|meta|mistral|nvidia|zai|cohere|deepseek)\./.test(
    modelId
  )
}

/**
 * Honors `COPILOT_SPECIALIST_MODEL` only when it matches the active provider
 * family, so a Haiku override cannot leak onto Gemini catalog traffic (and
 * vice versa). Other providers keep the raw override.
 */
function specialistEnvOverride(provider: LocalCopilotProviderId): string | undefined {
  const override = process.env.COPILOT_SPECIALIST_MODEL?.trim()
  if (!override) return undefined
  const isGeminiModel = override.startsWith('gemini')
  if (provider === 'gemini' || provider === 'vertex') {
    return isGeminiModel ? override : undefined
  }
  if (provider === 'anthropic') return isGeminiModel ? undefined : override
  if (provider === 'bedrock') return isBedrockModelId(override) ? override : undefined
  return override
}

/**
 * Resolves the specialist model: explicit override, else Haiku for Anthropic,
 * Flash-Lite for Gemini / Vertex, Haiku 4.5 for Bedrock, else the main agent model.
 */
export function resolveSpecialistModel(
  provider: LocalCopilotProviderId,
  mainModel: string,
  specialistOverride?: string
): string {
  const override = specialistOverride?.trim()
  if (override) return override
  if (provider === 'anthropic') return DEFAULT_ANTHROPIC_SPECIALIST_MODEL
  if (provider === 'gemini') return DEFAULT_GEMINI_SPECIALIST_MODEL
  if (provider === 'vertex') return DEFAULT_VERTEX_SPECIALIST_MODEL
  if (provider === 'bedrock') return DEFAULT_BEDROCK_SPECIALIST_MODEL
  return mainModel
}

/**
 * Reads Arena Copilot configuration from environment variables.
 * All LLM traffic goes directly to the configured provider — no Sim cloud relay.
 *
 * `COPILOT_API_KEY` authenticates requests to Sim Cloud Mothership and must not
 * be used for direct provider calls (it is typically `sk-sim-copilot-*`).
 */
function resolveApiKey(provider: LocalCopilotProviderId): string | undefined {
  if (provider === 'anthropic') {
    try {
      return getRotatingApiKey('anthropic')
    } catch {
      return undefined
    }
  }

  if (provider === 'gemini') {
    // Presence check only — the Gemini provider round-robins on each LLM call.
    return listLocalCopilotGeminiApiKeys()[0]
  }

  if (provider === 'openai' || provider === 'openai-compatible') {
    return (
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY_1?.trim() ||
      process.env.OPENAI_API_KEY_2?.trim() ||
      process.env.OPENAI_API_KEY_3?.trim() ||
      undefined
    )
  }

  return undefined
}

function resolveBedrockRegion(): string {
  return (
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    DEFAULT_BEDROCK_REGION
  )
}

function hasBedrockCredentials(): boolean {
  const accessKey = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  if (accessKey && secretKey) return true
  // Default credential chain (instance role, profile, etc.) may still work.
  return Boolean(
    process.env.AWS_PROFILE?.trim() || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  )
}

export function getLocalCopilotConfig(): LocalCopilotConfig {
  const provider = resolveProvider(process.env.COPILOT_PROVIDER)
  const model = process.env.COPILOT_MODEL?.trim() || DEFAULT_MODEL
  const specialistModel = resolveSpecialistModel(provider, model, specialistEnvOverride(provider))

  return {
    enabled: parseBoolean(process.env.COPILOT_ENABLED, true),
    provider,
    model,
    specialistModel,
    thinkingLevel: resolveLocalCopilotThinkingLevel(provider),
    apiKey: resolveApiKey(provider),
    baseUrl: process.env.COPILOT_BASE_URL?.trim() || undefined,
    region: provider === 'bedrock' ? resolveBedrockRegion() : undefined,
  }
}

/**
 * Builds a per-request Local Copilot config from an allowlisted catalog id.
 * Does not mutate process-wide env defaults.
 */
export function buildLocalCopilotConfigForCatalog(
  catalogId: LocalCopilotCatalogId = DEFAULT_LOCAL_COPILOT_CATALOG_ID
): LocalCopilotConfig {
  const base = getLocalCopilotConfig()
  const entry = resolveLocalCopilotCatalogEntry(catalogId)
  const model =
    entry.model?.trim() ||
    (entry.provider === 'anthropic' ? process.env.COPILOT_MODEL?.trim() || DEFAULT_MODEL : entry.id)
  const specialistModel = resolveSpecialistModel(
    entry.provider,
    model,
    specialistEnvOverride(entry.provider)
  )

  return {
    enabled: base.enabled,
    provider: entry.provider,
    model,
    specialistModel,
    thinkingLevel: resolveLocalCopilotThinkingLevel(entry.provider),
    apiKey: resolveApiKey(entry.provider),
    baseUrl: entry.provider === base.provider ? base.baseUrl : undefined,
    region: entry.provider === 'bedrock' ? resolveBedrockRegion() : undefined,
  }
}

export function assertLocalCopilotEnabled(
  config: LocalCopilotConfig = getLocalCopilotConfig()
): void {
  if (!config.enabled) {
    throw new Error('Arena Copilot is disabled. Set COPILOT_ENABLED=true to enable.')
  }

  if (config.provider === 'bedrock') {
    if (!hasBedrockCredentials() && !process.env.AWS_ACCESS_KEY_ID) {
      // Allow default chain; fail at request time if AWS cannot resolve credentials.
      return
    }
    return
  }

  if (config.provider === 'vertex') {
    if (!isLocalCopilotVertexConfigured()) {
      throw new Error(getLocalCopilotVertexNotConfiguredMessage())
    }
    return
  }

  if (config.provider === 'openai-compatible') {
    return
  }

  if (!config.apiKey) {
    if (config.provider === 'anthropic') {
      throw new Error(
        'Claude is not configured on this server. Set ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_1 through _3 (not COPILOT_API_KEY).'
      )
    }
    if (config.provider === 'gemini') {
      throw new Error(
        'Gemini is not configured on this server. Set GEMINI_API_KEY_1, GEMINI_API_KEY_2, and GEMINI_API_KEY_3 (or a single GEMINI_API_KEY / GOOGLE_API_KEY).'
      )
    }
    throw new Error(
      `Arena Copilot requires an API key for the configured provider (${config.provider}).`
    )
  }
}

export function isSelfHostedDeployment(): boolean {
  return !isHosted
}
