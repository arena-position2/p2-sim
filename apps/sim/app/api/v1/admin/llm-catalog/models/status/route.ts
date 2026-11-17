import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { adminUpdateLlmModelStatusContract } from '@/lib/api/contracts/llm-catalog'
import { parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { authenticateLlmCatalogRequest } from '@/lib/llm-catalog/auth'
import { LlmModelNotFoundError, updateLlmModelStatus } from '@/lib/llm-catalog/update-model-status'
import {
  adminInternalErrorResponse,
  adminNotFoundResponse,
  singleResponse,
} from '@/app/api/v1/admin/responses'

const logger = createLogger('AdminUpdateLlmModelStatusAPI')

/**
 * PATCH /api/v1/admin/llm-catalog/models/status
 *
 * Set one catalog model's `model_status` without re-syncing from
 * PROVIDER_DEFINITIONS. Clears the catalog cache, updates the row, then
 * reloads the full catalog into cache so GET /api/v1/admin/llm-catalog sees the change.
 *
 * Body: `{ "id": "<model id>", "modelStatus": "active" | "deactive" }`
 *
 * Auth: signed-in session cookie OR x-admin-key: $CRON_SECRET
 */
export const PATCH = withRouteHandler(async (request) => {
  const requestId = generateRequestId()

  try {
    const authResponse = await authenticateLlmCatalogRequest(request)
    if (authResponse) return authResponse

    const parsed = await parseRequest(adminUpdateLlmModelStatusContract, request, {})
    if (!parsed.success) return parsed.response

    const { id, modelStatus } = parsed.data.body
    const result = await updateLlmModelStatus(id, modelStatus)

    logger.info('Admin API: Updated LLM model status', { requestId, ...result })
    return singleResponse(result)
  } catch (error) {
    if (error instanceof LlmModelNotFoundError) {
      return adminNotFoundResponse('LLM model')
    }

    const err = toError(error)
    const cause =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined
    logger.error('Admin API: Failed to update LLM model status', {
      requestId,
      error: err,
      cause,
    })
    const detail = cause ? `${err.message}: ${cause}` : err.message
    return adminInternalErrorResponse(`Failed to update LLM model status: ${detail}`)
  }
})
