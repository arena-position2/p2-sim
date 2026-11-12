'use client'

/**
 * React Query hook for GET /api/llm-catalog.
 *
 * Maps the wire JSON into {@link ActiveLlmCatalogSnapshot} so
 * ProviderModelsLoader can call applyActiveLlmCatalogToProviders and reuse
 * PROVIDER_DEFINITIONS everywhere without per-picker filtering.
 */

import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/lib/api/client/request'
import { getLlmCatalogContract } from '@/lib/api/contracts/llm-catalog'
import { llmCatalogKeys } from '@/hooks/queries/utils/llm-catalog-keys'
import type { ActiveLlmCatalogSnapshot, ModelCapabilities } from '@/providers/models'
import type { ModelPricing } from '@/providers/types'

export const LLM_CATALOG_ACTIVE_STALE_TIME = 5 * 60 * 1000

function sunsetFromWire(
  sunset: Record<string, unknown> | undefined
): { status: 'legacy' | 'deprecated' } | undefined {
  if (!sunset) return undefined
  const status = sunset.status
  if (status === 'legacy' || status === 'deprecated') return { status }
  return undefined
}

/** Fetches active catalog rows and coerces jsonb fields into ModelDefinition. */
async function fetchActiveLlmCatalog(signal?: AbortSignal): Promise<ActiveLlmCatalogSnapshot> {
  const response = await requestJson(getLlmCatalogContract, { signal })
  const catalog: ActiveLlmCatalogSnapshot = {}
  for (const [providerId, provider] of Object.entries(response.data)) {
    catalog[providerId] = {
      id: provider.id,
      defaultModel: provider.defaultModel,
      models: provider.models.map((model) => ({
        id: model.id,
        // double-cast-allowed: wire jsonb matches ModelDefinition pricing/capabilities at runtime
        pricing: model.pricing as unknown as ModelPricing,
        capabilities: model.capabilities as unknown as ModelCapabilities,
        contextWindow: model.contextWindow,
        releaseDate: model.releaseDate,
        featured: model.featured,
        recommended: model.recommended,
        speedOptimized: model.speedOptimized,
        sunset: sunsetFromWire(model.sunset),
      })),
    }
  }
  return catalog
}

/** Active LLM catalog for hydrating PROVIDER_DEFINITIONS on the client. */
export function useActiveLlmCatalog(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: llmCatalogKeys.active(),
    queryFn: ({ signal }) => fetchActiveLlmCatalog(signal),
    enabled: options?.enabled ?? true,
    staleTime: LLM_CATALOG_ACTIVE_STALE_TIME,
  })
}
