import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { adminGetLlmCatalogContract } from '@/lib/api/contracts/llm-catalog'
import { parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { authenticateLlmCatalogRequest } from '@/lib/llm-catalog/auth'
import { getActiveLlmCatalog } from '@/lib/llm-catalog/get-active'
import { adminInternalErrorResponse, singleResponse } from '@/app/api/v1/admin/responses'

const logger = createLogger('AdminGetLlmCatalogAPI')

/**
 * GET /api/v1/admin/llm-catalog
 *
 * Admin/ops read of active catalog rows (same payload as GET /api/llm-catalog).
 *
 * Auth: signed-in session cookie OR x-admin-key: $CRON_SECRET
 */
export const GET = withRouteHandler(async (request) => {
  const requestId = generateRequestId()

  try {
    const authResponse = await authenticateLlmCatalogRequest(request)
    if (authResponse) return authResponse

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
