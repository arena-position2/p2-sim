import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { adminGetLlmCatalogContract } from '@/lib/api/contracts/llm-catalog'
import { parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { getActiveLlmCatalog } from '@/lib/llm-catalog/get-active'
import { authenticateCronSecretRequest } from '@/app/api/v1/admin/cron-secret-auth'
import { adminInternalErrorResponse, singleResponse } from '@/app/api/v1/admin/responses'

const logger = createLogger('AdminGetLlmCatalogAPI')

/**
 * GET /api/v1/admin/llm-catalog
 *
 * Admin read of active catalog rows (same payload as GET /api/llm-catalog).
 * Useful for ops/debugging without a user session cookie.
 *
 * Auth: x-admin-key: $CRON_SECRET
 */
export const GET = withRouteHandler(async (request) => {
  const requestId = generateRequestId()

  try {
    const authResponse = authenticateCronSecretRequest(request)
    if (authResponse) {
      return authResponse
    }

    const parsed = await parseRequest(adminGetLlmCatalogContract, request, {})
    if (!parsed.success) return parsed.response

    const catalog = await getActiveLlmCatalog()

    logger.info('Admin API: Loaded active LLM catalog', {
      requestId,
      providers: Object.keys(catalog).length,
    })
    return singleResponse(catalog)
  } catch (error) {
    const err = toError(error)
    const cause =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined
    logger.error('Admin API: Failed to load LLM catalog', {
      requestId,
      error: err,
      cause,
    })
    const detail = cause ? `${err.message}: ${cause}` : err.message
    return adminInternalErrorResponse(`Failed to load LLM catalog: ${detail}`)
  }
})
