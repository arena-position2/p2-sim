import { db } from '@sim/db'
import { deployedChat } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  deleteDeployedChatThreadContract,
  updateDeployedChatThreadContract,
} from '@/lib/api/contracts/deployed-chat-threads'
import { parseRequest } from '@/lib/api/server'
import { resolveDeployedChatThreadAccess } from '@/lib/chat/deployed-chat-thread-auth'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { addCorsHeaders } from '@/app/api/chat/utils'
import { createCodedErrorResponse } from '@/app/api/workflows/utils'

const logger = createLogger('DeployedChatThreadAPI')

export const PATCH = withRouteHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ identifier: string; chatId: string }> }
  ) => {
    const requestId = generateRequestId()
    const parsed = await parseRequest(updateDeployedChatThreadContract, request, context)
    if (!parsed.success) {
      return addCorsHeaders(parsed.response, request)
    }

    const { identifier, chatId } = parsed.data.params
    const { title, pinned } = parsed.data.body

    const access = await resolveDeployedChatThreadAccess(requestId, identifier, request)
    if (!access.ok) return access.response

    const { deployment, executingUserId } = access

    const workflowScope = or(
      eq(deployedChat.workflowId, identifier),
      eq(deployedChat.workflowId, deployment.workflowId)
    )
    const userScope = or(
      eq(deployedChat.executingUserId, executingUserId),
      isNull(deployedChat.executingUserId)
    )

    const updates: {
      updatedAt: Date
      title?: string
      pinnedAt?: Date | null
    } = {
      updatedAt: new Date(),
    }

    if (title !== undefined) {
      updates.title = title
    }
    if (pinned !== undefined) {
      updates.pinnedAt = pinned ? new Date() : null
    }

    const [updated] = await db
      .update(deployedChat)
      .set(updates)
      .where(
        and(
          eq(deployedChat.chatId, chatId),
          workflowScope,
          userScope,
          isNull(deployedChat.archivedAt)
        )
      )
      .returning({ id: deployedChat.id })

    if (!updated) {
      return addCorsHeaders(createCodedErrorResponse('Thread not found', 404), request)
    }

    logger.info(`[${requestId}] Updated deployed chat thread`, {
      identifier,
      chatId,
      executingUserId,
    })
    return addCorsHeaders(NextResponse.json({ success: true as const }), request)
  }
)

export const DELETE = withRouteHandler(
  async (
    request: NextRequest,
    context: { params: Promise<{ identifier: string; chatId: string }> }
  ) => {
    const requestId = generateRequestId()
    const parsed = await parseRequest(deleteDeployedChatThreadContract, request, context)
    if (!parsed.success) {
      return addCorsHeaders(parsed.response, request)
    }

    const { identifier, chatId } = parsed.data.params

    const access = await resolveDeployedChatThreadAccess(requestId, identifier, request)
    if (!access.ok) return access.response

    const { deployment, executingUserId } = access

    const workflowScope = or(
      eq(deployedChat.workflowId, identifier),
      eq(deployedChat.workflowId, deployment.workflowId)
    )
    const userScope = or(
      eq(deployedChat.executingUserId, executingUserId),
      isNull(deployedChat.executingUserId)
    )

    const [archived] = await db
      .update(deployedChat)
      .set({
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(deployedChat.chatId, chatId),
          workflowScope,
          userScope,
          isNull(deployedChat.archivedAt)
        )
      )
      .returning({ id: deployedChat.id })

    if (!archived) {
      return addCorsHeaders(createCodedErrorResponse('Thread not found', 404), request)
    }

    logger.info(`[${requestId}] Archived deployed chat thread`, {
      identifier,
      chatId,
      executingUserId,
    })
    return addCorsHeaders(NextResponse.json({ success: true as const }), request)
  }
)
