import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { adminSyncLlmCatalogContract } from '@/lib/api/contracts/llm-catalog'
import { parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { syncLlmCatalogFromDefinitions } from '@/lib/llm-catalog/sync'
import { authenticateCronSecretRequest } from '@/app/api/v1/admin/cron-secret-auth'
import { adminInternalErrorResponse, singleResponse } from '@/app/api/v1/admin/responses'

const logger = createLogger('AdminSyncLlmCatalogAPI')

/**
 * POST /api/v1/admin/llm-catalog/sync
 *
 * Upserts PROVIDER_DEFINITIONS into llm_provider / llm_model.
 * Deprecated models get model_status=deactive; models removed from code are deactivated.
 *
 * Auth: x-admin-key: $CRON_SECRET
 */
export const POST = withRouteHandler(async (request) => {
  const requestId = generateRequestId()

  try {
    const authResponse = authenticateCronSecretRequest(request)
    if (authResponse) {
      return authResponse
    }

    const parsed = await parseRequest(adminSyncLlmCatalogContract, request, undefined)
    if (!parsed.success) return parsed.response

    const result = await syncLlmCatalogFromDefinitions()

    logger.info('Admin API: Synced LLM provider catalog', { requestId, ...result })
    return singleResponse(result)
  } catch (error) {
    const err = toError(error)
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : undefined
    logger.error('Admin API: Failed to sync LLM provider catalog', {
      requestId,
      error: err,
      cause,
    })
    const detail = cause ? `${err.message}: ${cause}` : err.message
    return adminInternalErrorResponse(`Failed to sync LLM provider catalog: ${detail}`)
  }
})
