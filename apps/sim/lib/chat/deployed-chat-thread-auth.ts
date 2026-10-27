import { db } from '@sim/db'
import { chat } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { addCorsHeaders } from '@/app/api/chat/utils'
import { createCodedErrorResponse } from '@/app/api/workflows/utils'

const logger = createLogger('DeployedChatThreadAuth')

export interface ActiveDeployedChatDeployment {
  id: string
  workflowId: string
  isActive: boolean
}

type DeployedChatThreadErrorResponse = NextResponse<{ error: string; code: string }>

function codedErrorResponse(
  message: string,
  status: number,
  request: NextRequest
): DeployedChatThreadErrorResponse {
  return addCorsHeaders(
    createCodedErrorResponse(message, status),
    request
  ) as DeployedChatThreadErrorResponse
}

/**
 * Resolves an active deployed chat deployment and authenticated executing user.
 */
export async function resolveDeployedChatThreadAccess(
  requestId: string,
  identifier: string,
  request: NextRequest
): Promise<
  | { ok: true; deployment: ActiveDeployedChatDeployment; executingUserId: string }
  | { ok: false; response: DeployedChatThreadErrorResponse }
> {
  const deploymentResult = await db
    .select({
      id: chat.id,
      workflowId: chat.workflowId,
      isActive: chat.isActive,
    })
    .from(chat)
    .where(
      and(
        or(eq(chat.identifier, identifier), eq(chat.workflowId, identifier)),
        isNull(chat.archivedAt)
      )
    )
    .limit(1)

  if (deploymentResult.length === 0) {
    logger.warn(`[${requestId}] Chat not found for identifier: ${identifier}`)
    return {
      ok: false,
      response: codedErrorResponse('Chat not found', 404, request),
    }
  }

  const deployment = deploymentResult[0]

  if (!deployment.isActive) {
    logger.warn(`[${requestId}] Chat is not active: ${identifier}`)
    return {
      ok: false,
      response: codedErrorResponse('This chat is currently unavailable', 403, request),
    }
  }

  const session = await getSession()
  const executingUserId = session?.user?.id
  if (!executingUserId) {
    logger.info(`[${requestId}] Unauthorized deployed chat thread request: missing session user`)
    return {
      ok: false,
      response: codedErrorResponse('Authentication required', 401, request),
    }
  }

  return { ok: true, deployment, executingUserId }
}
