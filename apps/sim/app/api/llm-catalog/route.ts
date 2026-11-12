import { getLlmCatalogContract } from '@/lib/api/contracts/llm-catalog'
import {
  defineInternalJsonRoute,
  internalOrchestrationErrorPolicy,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { getActiveLlmCatalogUseCase } from '@/lib/llm-catalog/application/get-active-catalog'

/**
 * GET /api/llm-catalog
 *
 * Session-authenticated read of active DB catalog rows.
 * Used by ProviderModelsLoader to hydrate PROVIDER_DEFINITIONS on the client so
 * agent/router model pickers keep calling PROVIDER_DEFINITIONS but only see
 * models with model_status = 'active'.
 *
 * Auth: signed-in user session (cookie).
 */
export const GET = defineInternalJsonRoute({
  contract: getLlmCatalogContract,
  operation: getActiveLlmCatalogUseCase.operation,
  useCase: getActiveLlmCatalogUseCase,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.user({ bucketName: 'llm-catalog.get' }),
  errorPolicy: internalOrchestrationErrorPolicy,
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  mapInput: () => ({}),
  present: (catalog) => ({ data: catalog }),
})
