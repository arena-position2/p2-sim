import { db } from '@sim/db'
import { createLogger } from '@sim/logger'
import { sql } from 'drizzle-orm'

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
} & Record<string, unknown>

function omitNullish<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && entry !== undefined) out[key] = entry
  }
  return out as T
}

/**
 * DB → API: loads providers with only `model_status = 'active'` models.
 *
 * Shape mirrors PROVIDER_DEFINITIONS (camelCase, keyed by provider id) so the
 * browser can write the payload back onto PROVIDER_DEFINITIONS. Wire differences:
 * - `icon` is the component name string (not a React component)
 * - `modelPatterns` are regex source strings (not RegExp instances)
 *
 * Those fields are not applied on hydrate — the static code definitions keep
 * the real icon component and RegExp patterns.
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
      m.id AS model_id,
      m.pricing,
      m.capabilities AS model_capabilities,
      m.context_window,
      m.release_date::text AS release_date,
      m.featured,
      m.recommended,
      m.speed_optimized,
      m.sunset
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

  logger.info('Loaded active LLM catalog', {
    providers: Object.keys(catalog).length,
    models: Object.values(catalog).reduce((sum, provider) => sum + provider.models.length, 0),
  })

  return catalog
}
