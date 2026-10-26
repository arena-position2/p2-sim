import type { LocalCopilotProviderId } from '@/local-copilot/lib/types'

/** Default catalog selection for new local chats and new user-access rows. */
export const DEFAULT_LOCAL_COPILOT_CATALOG_ID = 'gemini-3.8-flash' as const

/** Top-level picker groups shown when Local is selected. */
export type LocalCopilotProviderGroup = 'claude' | 'gemini' | 'vertex' | 'bedrock'

/**
 * Allowlisted Local Copilot models selectable in chat.
 * Clients store/send these ids; the server maps them to provider + model.
 */
export const LOCAL_COPILOT_CATALOG = [
  {
    id: 'claude',
    providerGroup: 'claude',
    label: 'Claude',
    provider: 'anthropic' as LocalCopilotProviderId,
    model: null as string | null,
  },
  {
    id: 'gemini-3.8-flash',
    providerGroup: 'gemini',
    label: 'Gemini 3.8 Flash',
    provider: 'gemini' as LocalCopilotProviderId,
    model: 'gemini-3.8-flash',
  },
  {
    id: 'gemini-2.5-pro',
    providerGroup: 'gemini',
    label: 'Gemini 2.5 Pro',
    provider: 'gemini' as LocalCopilotProviderId,
    model: 'gemini-2.5-pro',
  },
  {
    id: 'gemini-3.1-pro',
    providerGroup: 'gemini',
    label: 'Gemini 3.1 Pro',
    provider: 'gemini' as LocalCopilotProviderId,
    model: 'gemini-3.1-pro-preview',
  },
  {
    id: 'vertex-gemini-3.8-flash',
    providerGroup: 'vertex',
    label: 'Gemini 3.8 Flash',
    provider: 'vertex' as LocalCopilotProviderId,
    model: 'gemini-3.8-flash',
  },
  {
    id: 'bedrock-claude-fable-5-1',
    providerGroup: 'bedrock',
    label: 'Claude Fable 5.1',
    provider: 'bedrock',
    model: 'anthropic.claude-fable-5-1',
  },
  {
    id: 'bedrock-gpt-6-astra',
    providerGroup: 'bedrock',
    label: 'GPT-6 Astra',
    provider: 'bedrock',
    model: 'openai.gpt-6-astra',
  },
  {
    id: 'bedrock-gpt-5.5',
    providerGroup: 'bedrock',
    label: 'GPT-5.5',
    provider: 'bedrock',
    model: 'openai.gpt-5.5',
  },
  {
    id: 'bedrock-claude-opus-5',
    providerGroup: 'bedrock',
    label: 'Claude Opus 5',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'anthropic.claude-opus-5',
  },
  {
    id: 'bedrock-claude-sonnet-5',
    providerGroup: 'bedrock',
    label: 'Claude Sonnet 5',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'anthropic.claude-sonnet-5',
  },
  {
    id: 'bedrock-claude-opus-4-8',
    providerGroup: 'bedrock',
    label: 'Claude Opus 4.8',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'anthropic.claude-opus-4-8',
  },
  {
    id: 'bedrock-claude-opus-4-6',
    providerGroup: 'bedrock',
    label: 'Claude Opus 4.6',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'anthropic.claude-opus-4-6-v1',
  },
  {
    id: 'bedrock-claude-sonnet-4-6',
    providerGroup: 'bedrock',
    label: 'Claude Sonnet 4.6',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'anthropic.claude-sonnet-4-6',
  },
  {
    id: 'bedrock-zai-glm-5',
    providerGroup: 'bedrock',
    label: 'GLM 5',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'zai.glm-5',
  },
  {
    id: 'bedrock-deepseek-v3.2',
    providerGroup: 'bedrock',
    label: 'DeepSeek V3.2',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'deepseek.v3.2',
  },
  {
    id: 'bedrock-nemotron-super-3-120b',
    providerGroup: 'bedrock',
    label: 'Nemotron Super 3',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'nvidia.nemotron-super-3-120b',
  },
  {
    id: 'bedrock-mistral-large-3',
    providerGroup: 'bedrock',
    label: 'Mistral Large 3',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'mistral.mistral-large-3-675b-instruct',
  },
  {
    id: 'bedrock-llama-3.3-70b',
    providerGroup: 'bedrock',
    label: 'Llama 3.3 70B',
    provider: 'bedrock' as LocalCopilotProviderId,
    model: 'meta.llama3-3-70b-instruct-v1:0',
  },
] as const

export type LocalCopilotCatalogId = (typeof LOCAL_COPILOT_CATALOG)[number]['id']

export interface LocalCopilotCatalogEntry {
  id: LocalCopilotCatalogId
  providerGroup: LocalCopilotProviderGroup
  label: string
  provider: LocalCopilotProviderId
  /**
   * Concrete provider model id. `null` for Claude — resolved from `COPILOT_MODEL`
   * at config-build time.
   */
  model: string | null
}

const CATALOG_BY_ID = new Map<string, (typeof LOCAL_COPILOT_CATALOG)[number]>(
  LOCAL_COPILOT_CATALOG.map((entry) => [entry.id, entry])
)

/**
 * Leftover Cloud / Anthropic ids stored on chats created before the Local
 * picker. `claude-opus-4-8` was the previous hosted default; map it onto the
 * generic Claude leaf rather than falling through to Gemini.
 */
const LEGACY_LOCAL_COPILOT_CATALOG_IDS: Record<string, LocalCopilotCatalogId> = {
  'claude-opus-4-8': 'claude',
  // Earlier Vertex picker SKUs → sole Studio-aligned Vertex leaf.
  'vertex-gemini-3.5-flash': 'vertex-gemini-3.8-flash',
  'vertex-gemini-2.5-flash': 'vertex-gemini-3.8-flash',
  'vertex-gemini-2.5-pro': 'vertex-gemini-3.8-flash',
  'vertex-gemini-3.1-pro': 'vertex-gemini-3.8-flash',
}

/** Type guard for allowlisted catalog ids. */
export function isLocalCopilotCatalogId(value: string): value is LocalCopilotCatalogId {
  return CATALOG_BY_ID.has(value)
}

/**
 * Maps a leftover stored/request model onto a Local picker id, or `undefined`
 * when the value is not a known legacy alias.
 */
export function remapLegacyLocalCopilotCatalogId(
  value: string | undefined | null
): LocalCopilotCatalogId | undefined {
  if (!value) return undefined
  return LEGACY_LOCAL_COPILOT_CATALOG_IDS[value]
}

/**
 * Returns an allowlisted catalog id, falling back to the Gemini default.
 */
export function resolveLocalCopilotCatalogId(
  value: string | undefined | null
): LocalCopilotCatalogId {
  if (value && isLocalCopilotCatalogId(value)) return value
  const remapped = remapLegacyLocalCopilotCatalogId(value)
  if (remapped) return remapped
  return DEFAULT_LOCAL_COPILOT_CATALOG_ID
}

/**
 * Local request model: leftover stored `claude-opus-4-8` switches onto
 * `claude`; otherwise honor a valid picker id, otherwise a leftover request
 * id, otherwise the per-user `default_model` enum (Gemini when that is
 * missing or a Cloud model string).
 */
export function resolveLocalCopilotRequestCatalogId(
  requested: string | undefined | null,
  defaultFromAccess: string | undefined | null,
  storedChatModel?: string | null
): LocalCopilotCatalogId {
  const remappedStored = remapLegacyLocalCopilotCatalogId(storedChatModel)
  if (remappedStored) return remappedStored
  if (requested && isLocalCopilotCatalogId(requested)) return requested
  const remappedRequested = remapLegacyLocalCopilotCatalogId(requested)
  if (remappedRequested) return remappedRequested
  return resolveLocalCopilotCatalogId(defaultFromAccess)
}

/**
 * Returns the catalog entry for a known id, or `null` when the value is not
 * an allowlisted local picker id (e.g. a legacy cloud model string).
 */
export function getLocalCopilotCatalogEntry(
  catalogId: string
): (typeof LOCAL_COPILOT_CATALOG)[number] | null {
  return CATALOG_BY_ID.get(catalogId) ?? null
}

/**
 * Resolves a catalog id to its provider + concrete model.
 * Throws when the id is not allowlisted (request validation should reject first).
 */
export function resolveLocalCopilotCatalogEntry(catalogId: string): {
  id: LocalCopilotCatalogId
  provider: LocalCopilotProviderId
  model: string | null
  label: string
  providerGroup: LocalCopilotProviderGroup
} {
  const entry = CATALOG_BY_ID.get(catalogId)
  if (!entry) {
    throw new Error(`Unknown local copilot model: ${catalogId}`)
  }
  return {
    id: entry.id,
    provider: entry.provider,
    model: entry.model,
    label: entry.label,
    providerGroup: entry.providerGroup,
  }
}

/** Provider-group chip labels for the chat toolbar. */
export const LOCAL_COPILOT_PROVIDER_GROUPS: Array<{
  id: LocalCopilotProviderGroup
  label: string
}> = [
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'vertex', label: 'Vertex' },
  { id: 'bedrock', label: 'Bedrock' },
]

/** Leaf models for a provider group (Claude has a single leaf). */
export function getLocalCopilotCatalogEntriesForGroup(
  group: LocalCopilotProviderGroup
): readonly (typeof LOCAL_COPILOT_CATALOG)[number][] {
  return LOCAL_COPILOT_CATALOG.filter((entry) => entry.providerGroup === group)
}
