import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { adminSyncLlmCatalogContract } from '@/lib/api/contracts/llm-catalog'
import { parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { authenticateLlmCatalogRequest } from '@/lib/llm-catalog/auth'
import { syncLlmCatalogFromDefinitions } from '@/lib/llm-catalog/sync'
import { adminInternalErrorResponse, singleResponse } from '@/app/api/v1/admin/responses'

const logger = createLogger('AdminSyncLlmCatalogAPI')

/**
 * POST /api/v1/admin/llm-catalog/sync
 *
 * Push the deployed PROVIDER_DEFINITIONS into Postgres. Run after adding /
 * updating / removing models in models.ts on this environment.
 * No request body — the server reads the in-process catalog and upserts.
 *
 * Auth: signed-in session cookie OR x-admin-key: $CRON_SECRET
 */
export const POST = withRouteHandler(async (request) => {
  const requestId = generateRequestId()

  try {
    const authResponse = await authenticateLlmCatalogRequest(request)
    if (authResponse) return authResponse

    const parsed = await parseRequest(adminSyncLlmCatalogContract, request, {})
    if (!parsed.success) return parsed.response

    const result = await syncLlmCatalogFromDefinitions()

    logger.info('Admin API: Synced LLM provider catalog', { requestId, ...result })
    return singleResponse(result)
  } catch (error) {
    const err = toError(error)
    const cause =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined
    logger.error('Admin API: Failed to sync LLM provider catalog', {
      requestId,
      error: err,
      cause,
    })
    const detail = cause ? `${err.message}: ${cause}` : err.message
    return adminInternalErrorResponse(`Failed to sync LLM provider catalog: ${detail}`)
  }
})
