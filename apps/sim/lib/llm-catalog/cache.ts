import { createLogger } from '@sim/logger'
import { LRUCache } from 'lru-cache'
import { getRedisClient } from '@/lib/core/config/redis'
import type { LlmCatalogDefinitions, LlmCatalogModel } from '@/lib/llm-catalog/get-active'

const logger = createLogger('LlmCatalogCache')

/** Redis + local key for the full catalog snapshot (active + deactive models). */
export const LLM_CATALOG_CACHE_KEY = 'llm-catalog:v1'

/** Safety TTL — sync deletes and rewrites; this only bounds orphaned entries. */
const LLM_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const LLM_CATALOG_CACHE_TTL_SECONDS = Math.floor(LLM_CATALOG_CACHE_TTL_MS / 1000)

export type CachedLlmCatalogModel = LlmCatalogModel & {
  modelStatus: 'active' | 'deactive'
}

export type CachedLlmCatalogDefinitions = Record<
  string,
  Omit<LlmCatalogDefinitions[string], 'models'> & {
    models: CachedLlmCatalogModel[]
  }
>

const localCache = new LRUCache<string, CachedLlmCatalogDefinitions>({
  max: 1,
  ttl: LLM_CATALOG_CACHE_TTL_MS,
})

function isCachedCatalog(value: unknown): value is CachedLlmCatalogDefinitions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every((provider) => {
    if (!provider || typeof provider !== 'object') return false
    const models = (provider as { models?: unknown }).models
    return Array.isArray(models)
  })
}

/** Drop the catalog from process memory and Redis (no-op when Redis is down). */
export async function clearLlmCatalogCache(): Promise<void> {
  localCache.delete(LLM_CATALOG_CACHE_KEY)

  const redis = getRedisClient()
  if (!redis) return

  try {
    await redis.del(LLM_CATALOG_CACHE_KEY)
    logger.info('Cleared LLM catalog cache')
  } catch (error) {
    logger.warn('Failed to clear LLM catalog Redis cache', { error })
  }
}

/** Store the full catalog (all model statuses) after sync or a cold DB read. */
export async function setLlmCatalogCache(catalog: CachedLlmCatalogDefinitions): Promise<void> {
  localCache.set(LLM_CATALOG_CACHE_KEY, catalog)

  const redis = getRedisClient()
  if (!redis) return

  try {
    await redis.set(
      LLM_CATALOG_CACHE_KEY,
      JSON.stringify(catalog),
      'EX',
      LLM_CATALOG_CACHE_TTL_SECONDS
    )
    logger.info('Wrote LLM catalog cache', {
      providers: Object.keys(catalog).length,
      models: Object.values(catalog).reduce((sum, provider) => sum + provider.models.length, 0),
    })
  } catch (error) {
    logger.warn('Failed to write LLM catalog Redis cache', { error })
  }
}

/**
 * Read the full catalog snapshot. Local first, then Redis (hydrates local on hit).
 * Returns `undefined` when both are empty/unavailable — caller should load DB.
 */
export async function getLlmCatalogCache(): Promise<CachedLlmCatalogDefinitions | undefined> {
  const local = localCache.get(LLM_CATALOG_CACHE_KEY)
  if (local !== undefined) return local

  const redis = getRedisClient()
  if (!redis) return undefined

  try {
    const raw = await redis.get(LLM_CATALOG_CACHE_KEY)
    if (raw === null) return undefined

    const parsed: unknown = JSON.parse(raw)
    if (!isCachedCatalog(parsed)) {
      logger.warn('Discarded invalid LLM catalog cache payload')
      return undefined
    }

    localCache.set(LLM_CATALOG_CACHE_KEY, parsed)
    return parsed
  } catch (error) {
    logger.warn('Failed to read LLM catalog Redis cache', { error })
    return undefined
  }
}

/** Keep only `model_status = 'active'` models for the public GET response. */
export function filterActiveLlmCatalog(
  catalog: CachedLlmCatalogDefinitions
): LlmCatalogDefinitions {
  const active: LlmCatalogDefinitions = {}

  for (const [providerId, provider] of Object.entries(catalog)) {
    const models: LlmCatalogModel[] = []
    for (const model of provider.models) {
      const { modelStatus, ...rest } = model
      if (modelStatus !== 'active') continue
      models.push(rest)
    }

    active[providerId] = {
      ...provider,
      models,
    }
  }

  return active
}
