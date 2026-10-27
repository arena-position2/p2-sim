import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import {
  type ChatOutputConfigInput,
  parseChatOutputConfigInputs,
} from '@/lib/workflows/default-user-workflows/chat-deploy-import'
import { parsePostgresConnectionFromBody } from '@/lib/workflows/default-user-workflows/postgres'
import { syncDefaultWorkflowsForSource } from '@/lib/workflows/default-user-workflows/service'
import { authenticateCronSecretRequest } from '@/app/api/v1/admin/cron-secret-auth'
import {
  adminBadRequestResponse,
  adminInternalErrorResponse,
  singleResponse,
} from '@/app/api/v1/admin/responses'

const logger = createLogger('AdminSyncDefaultWorkflowsAPI')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * POST /api/v1/admin/default-workflows/sync
 *
 * Overwrites all user copies of a source default workflow from the template and redeploys.
 *
 * Request body:
 *   {
 *     sourceWorkflowId: string,
 *     deploy?: boolean,
 *     deployAsChat?: boolean,
 *     chat?: { outputConfigs: Array<{ blockName?: string, blockId?: string, path: string }> },
 *     postgres?: { host, port?, database, username, password, ssl? }
 *   }
 *
 * `deployAsChat` defaults to true. When false, do not include `chat` in the body.
 */
export const POST = withRouteHandler(async (request) => {
  const requestId = generateRequestId()

  try {
    const authResponse = authenticateCronSecretRequest(request)
    if (authResponse) {
      return authResponse
    }

    const body: unknown = await request.json()
    if (!isRecord(body)) {
      return adminBadRequestResponse('Request body must be a JSON object.')
    }

    const sourceWorkflowId =
      typeof body.sourceWorkflowId === 'string' ? body.sourceWorkflowId.trim() : ''
    if (!sourceWorkflowId) {
      return adminBadRequestResponse('sourceWorkflowId is required.')
    }

    const deploy = body.deploy !== false
    const deployAsChat = body.deployAsChat !== false

    if (body.chat !== undefined && !deployAsChat) {
      return adminBadRequestResponse('chat must not be provided when deployAsChat is false.')
    }

    let chatOutputConfigs: ChatOutputConfigInput[] | undefined
    if (deployAsChat) {
      const parsedChatOutputs = parseChatOutputConfigInputs(body)
      if (parsedChatOutputs && 'error' in parsedChatOutputs) {
        return adminBadRequestResponse(parsedChatOutputs.error)
      }
      chatOutputConfigs = parsedChatOutputs
    }

    const postgresParsed = parsePostgresConnectionFromBody(body)
    if (postgresParsed && 'error' in postgresParsed) {
      return adminBadRequestResponse(postgresParsed.error)
    }
    const postgresConnection = postgresParsed

    const result = await syncDefaultWorkflowsForSource({
      sourceWorkflowId,
      deploy,
      deployAsChat,
      chatOutputConfigs,
      requestId,
      request,
      postgresConnection,
    })

    logger.info(`[${requestId}] Admin API: Synced default workflows from source`, {
      sourceWorkflowId,
      total: result.total,
      updated: result.updated,
      deployed: result.deployed,
      failed: result.failed,
    })

    return singleResponse(result)
  } catch (error) {
    logger.error(`[${requestId}] Admin API: Failed to sync default workflows`, {
      error: toError(error),
    })
    return adminInternalErrorResponse('Failed to sync default workflows')
  }
})
