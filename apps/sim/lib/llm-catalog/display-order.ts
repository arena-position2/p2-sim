/**
 * Provider order for the active-catalog API and model pickers.
 * OpenAI → Gemini (google) → Anthropic first; everything else follows.
 */
export const LLM_CATALOG_PROVIDER_DISPLAY_ORDER = [
  'openai',
  'google',
  'anthropic',
  'azure-openai',
  'azure-anthropic',
  'vertex',
  'bedrock',
  'xai',
  'deepseek',
  'mistral',
  'groq',
  'cerebras',
  'meta',
  'nvidia',
  'kimi',
  'zai',
  'sakana',
  'kie',
  'nebius',
  'thinkingmachines',
  'typesafe',
  'sambanova',
] as const

/** Lower number = earlier in the picker / API response. Unknown providers sort last. */
export function llmCatalogProviderRank(providerId: string): number {
  const index = (LLM_CATALOG_PROVIDER_DISPLAY_ORDER as readonly string[]).indexOf(providerId)
  return index === -1 ? LLM_CATALOG_PROVIDER_DISPLAY_ORDER.length + 1 : index
}

/** Newer releaseDate first; missing dates last. */
export function compareLlmCatalogReleaseDates(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const timeA = a ? Date.parse(a) : Number.NaN
  const timeB = b ? Date.parse(b) : Number.NaN
  const validA = Number.isFinite(timeA)
  const validB = Number.isFinite(timeB)
  if (validA && validB && timeA !== timeB) return timeB - timeA
  if (validA && !validB) return -1
  if (!validA && validB) return 1
  return 0
}
