import { db } from '@sim/db'
import { createLogger } from '@sim/logger'
import { sql } from 'drizzle-orm'
import {
  compareLlmCatalogReleaseDates,
  llmCatalogProviderRank,
} from '@/lib/llm-catalog/display-order'

const logger = createLogger('LlmCatalogGetActive')

export interface LlmCatalogModel {
  id: string
  pricing: Record<string, unknown>
  capabilities: Record<string, unknown>
  contextWindow?: number
  releaseDate?: string
  featured?: boolean
  recommended?: boolean
  speedOptimized?: boolean
  sunset?: Record<string, unknown>
}

export interface LlmCatalogProvider {
  id: string
  name: string
  description: string
  defaultModel: string
  color?: string
  isReseller?: boolean
  contextInformationAvailable?: boolean
  icon?: string
  modelPatterns?: string[]
  fileAttachment?: Record<string, unknown>
  capabilities?: Record<string, unknown>
  models: LlmCatalogModel[]
}

/** Same top-level shape as PROVIDER_DEFINITIONS: keyed by provider id. */
export type LlmCatalogDefinitions = Record<string, LlmCatalogProvider>

type CatalogJoinRow = {
  provider_id: string
  name: string
  description: string
  default_model: string
  color: string | null
  is_reseller: boolean | null
  context_information_available: boolean | null
  icon: string | null
  model_patterns: string[] | null
  file_attachment: Record<string, unknown> | null
  provider_capabilities: Record<string, unknown> | null
  model_id: string | null
  pricing: Record<string, unknown> | null
  model_capabilities: Record<string, unknown> | null
  context_window: number | null
  release_date: string | null
  featured: boolean | null
  recommended: boolean | null
  speed_optimized: boolean | null
  sunset: Record<string, unknown> | null
  provider_sort: number
  model_sort: number | null
} & Record<string, unknown>

function omitNullish<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && entry !== undefined) out[key] = entry
  }
  return out as T
}

/**
 * Rebuilds the catalog object so JSON key order is:
 * openai → google (Gemini) → anthropic → …, with models newest-first inside each.
 */
function orderCatalogForDisplay(catalog: LlmCatalogDefinitions): LlmCatalogDefinitions {
  const ordered: LlmCatalogDefinitions = {}
  const providerIds = Object.keys(catalog).sort((a, b) => {
    const rank = llmCatalogProviderRank(a) - llmCatalogProviderRank(b)
    if (rank !== 0) return rank
    return a.localeCompare(b)
  })

  for (const providerId of providerIds) {
    const provider = catalog[providerId]
    provider.models.sort((a, b) => {
      const byDate = compareLlmCatalogReleaseDates(a.releaseDate, b.releaseDate)
      if (byDate !== 0) return byDate
      return a.id.localeCompare(b.id)
    })
    ordered[providerId] = provider
  }

  return ordered
}

/**
 * DB → API: loads providers with only `model_status = 'active'` models.
 *
 * Shape mirrors PROVIDER_DEFINITIONS (camelCase, keyed by provider id) so the
 * browser can write the payload back onto PROVIDER_DEFINITIONS. Wire differences:
 * - `icon` is the component name string (not a React component)
 * - `modelPatterns` are regex source strings (not RegExp instances)
 *
 * Response key order is openai → google → anthropic → … so clients that flatten
 * `Object.values` get the previous picker provider order without extra sorting.
 */
export async function getActiveLlmCatalog(): Promise<LlmCatalogDefinitions> {
  const rows = await db.execute<CatalogJoinRow>(sql`
    SELECT
      p.id AS provider_id,
      p.name,
      p.description,
      p.default_model,
      p.color,
      p.is_reseller,
      p.context_information_available,
      p.icon,
      to_jsonb(p.model_patterns) AS model_patterns,
      p.file_attachment,
      p.capabilities AS provider_capabilities,
      p.sort_order AS provider_sort,
      m.id AS model_id,
      m.pricing,
      m.capabilities AS model_capabilities,
      m.context_window,
      m.release_date::text AS release_date,
      m.featured,
      m.recommended,
      m.speed_optimized,
      m.sunset,
      m.sort_order AS model_sort
    FROM llm_provider p
    LEFT JOIN llm_model m
      ON m.provider_id = p.id
      AND m.model_status = 'active'
    ORDER BY p.sort_order ASC, m.sort_order ASC NULLS LAST
  `)

  const catalog: LlmCatalogDefinitions = {}

  for (const row of rows) {
    let provider = catalog[row.provider_id]
    if (!provider) {
      provider = omitNullish({
        id: row.provider_id,
        name: row.name,
        description: row.description,
        defaultModel: row.default_model,
        color: row.color ?? undefined,
        isReseller: row.is_reseller ?? undefined,
        contextInformationAvailable: row.context_information_available ?? undefined,
        icon: row.icon ?? undefined,
        modelPatterns: row.model_patterns ?? undefined,
        fileAttachment: row.file_attachment ?? undefined,
        capabilities: row.provider_capabilities ?? undefined,
        models: [],
      })
      catalog[row.provider_id] = provider
    }

    if (!row.model_id || !row.pricing) continue

    provider.models.push(
      omitNullish({
        id: row.model_id,
        pricing: row.pricing,
        capabilities: row.model_capabilities ?? {},
        contextWindow: row.context_window ?? undefined,
        releaseDate: row.release_date ?? undefined,
        featured: row.featured ?? undefined,
        recommended: row.recommended ?? undefined,
        speedOptimized: row.speed_optimized ?? undefined,
        sunset: row.sunset ?? undefined,
      })
    )
  }

  const ordered = orderCatalogForDisplay(catalog)

  logger.info('Loaded active LLM catalog', {
    providers: Object.keys(ordered).length,
    models: Object.values(ordered).reduce((sum, provider) => sum + provider.models.length, 0),
  })

  return ordered
}
