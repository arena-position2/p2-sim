import { createLogger } from '@sim/logger'
import type { NextRequest } from 'next/server'
import { resolveDeployedChatThreadAccess } from '@/lib/chat/deployed-chat-thread-auth'
import { listDeployedChatThreadsForUser } from '@/lib/chat/deployed-chat-threads'
import { generateRequestId } from '@/lib/core/utils/request'
import { createCodedErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'
import { addCorsHeaders } from '../../utils'

const logger = createLogger('ChatAllHistoryAPI')

// This endpoint returns all deployed chat history for a identifier
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params
  const requestId = generateRequestId()

  try {
    logger.debug(`[${requestId}] Fetching all deployed chat history for identifier: ${identifier}`)

    const access = await resolveDeployedChatThreadAccess(requestId, identifier, request)
    if (!access.ok) return access.response

    const { deployment, executingUserId } = access

    const records = await listDeployedChatThreadsForUser({
      identifier,
      deploymentWorkflowId: deployment.workflowId,
      executingUserId,
    })

    logger.debug(`[${requestId}] Found ${records.length} deployed chat records`)

    return addCorsHeaders(
      createSuccessResponse({
        records,
        total: records.length,
      }),
      request
    )
  } catch (error: unknown) {
    logger.error(`[${requestId}] Error fetching deployed chat history:`, error)
    const message = error instanceof Error ? error.message : 'Failed to fetch deployed chat history'
    return addCorsHeaders(createCodedErrorResponse(message, 500), request)
  }
}
