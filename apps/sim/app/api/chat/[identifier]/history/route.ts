import { db } from '@sim/db'
import { chat, chatPromptFeedback, workflowExecutionLogs } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { getSession } from '@/lib/auth'
import {
  getPersistedGeneratedImages,
  getPersistedHistoryAttachments,
} from '@/lib/chat/history-persistence'
import { generateRequestId } from '@/lib/core/utils/request'
import { materializeExecutionData } from '@/lib/logs/execution/trace-store'
import { getWorkspaceIdsForUser } from '@/lib/workspaces/permissions/utils'
import { createErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'
import { addCorsHeaders } from '../../utils'

const logger = createLogger('ChatHistoryAPI')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toExecutionDataRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function readHistoryConversationId(executionData: Record<string, unknown>): string | null {
  const traceSpans = executionData.traceSpans
  const spanList = Array.isArray(traceSpans)
    ? traceSpans
    : isRecord(traceSpans) && Array.isArray(traceSpans.spans)
      ? traceSpans.spans
      : null
  if (!spanList) return null

  const workflowSpan = spanList.find((span) => isRecord(span) && span.type === 'workflow')
  if (!isRecord(workflowSpan) || !Array.isArray(workflowSpan.children)) return null

  const agentSpan = workflowSpan.children.find((child) => isRecord(child) && child.type === 'agent')
  if (!isRecord(agentSpan) || !isRecord(agentSpan.input)) return null

  return typeof agentSpan.input.conversationId === 'string' ? agentSpan.input.conversationId : null
}

/**
 * GET /api/chat/[identifier]/history
 *
 * Retrieves the execution history for external chat interactions.
 * Only returns logs where is_external_chat = true in workflow_execution_logs table.
 *
 * Query Parameters:
 * - limit: Number of records to return (max 100, default 50)
 * - offset: Number of records to skip (default 0)
 * - startDate: ISO 8601 date string to filter from
 * - endDate: ISO 8601 date string to filter to
 * - conversationId: Filter by specific conversation ID
 * - chatId: Filter by specific chat ID (chat_id column in workflow_execution_logs)
 * - level: Filter by log level ('info' or 'error')
 *
 * Authentication:
 * - Public chats: No authentication required
 * - Password/Email chats: Requires valid authentication cookie or credentials
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params
  const requestId = generateRequestId()

  try {
    logger.debug(`[${requestId}] Fetching chat history for identifier: ${identifier}`)

    // Parse query parameters for pagination and filtering
    const { searchParams } = new URL(request.url)
    const limit = Math.min(Number.parseInt(searchParams.get('limit') || '50'), 100) // Max 100 items
    const offset = Math.max(Number.parseInt(searchParams.get('offset') || '0'), 0) // Ensure non-negative
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const conversationId = searchParams.get('conversationId') || identifier
    const chatId = searchParams.get('chatId')
    const level = searchParams.get('level') // 'info' or 'error'

    logger.debug(
      `[${requestId}] Start date: ${startDate}, End date: ${endDate}, Conversation ID: ${conversationId}, Chat ID: ${chatId}, Level: ${level}`
    )

    // Validate date parameters
    if (startDate && Number.isNaN(Date.parse(startDate))) {
      return addCorsHeaders(
        createErrorResponse('Invalid startDate format. Use ISO 8601 format.', 400),
        request
      )
    }
    if (endDate && Number.isNaN(Date.parse(endDate))) {
      return addCorsHeaders(
        createErrorResponse('Invalid endDate format. Use ISO 8601 format.', 400),
        request
      )
    }

    // Validate level parameter
    if (level && !['info', 'error'].includes(level)) {
      return addCorsHeaders(
        createErrorResponse('Invalid level parameter. Must be "info" or "error".', 400),
        request
      )
    }

    // Require authenticated user and use their id to filter records
    const session = await getSession()
    const executingUserId = session?.user?.id
    if (!executingUserId) {
      logger.info(`[${requestId}] Unauthorized request for history: missing session user`)
      return addCorsHeaders(createErrorResponse('Authentication required', 401), request)
    }

    const deploymentResult = await db
      .select({ workflowId: chat.workflowId, isActive: chat.isActive })
      .from(chat)
      .where(
        and(
          or(eq(chat.identifier, identifier), eq(chat.workflowId, identifier)),
          isNull(chat.archivedAt)
        )
      )
      .limit(1)

    if (deploymentResult.length === 0) {
      return addCorsHeaders(createErrorResponse('Chat not found', 404), request)
    }

    if (!deploymentResult[0].isActive) {
      return addCorsHeaders(createErrorResponse('This chat is currently unavailable', 403), request)
    }

    const deploymentWorkflowId = deploymentResult[0].workflowId

    // Build query conditions for external chat logs
    let conditions = and(
      eq(workflowExecutionLogs.workflowId, deploymentWorkflowId),
      eq(workflowExecutionLogs.isExternalChat, true),
      or(eq(workflowExecutionLogs.userId, executingUserId), isNull(workflowExecutionLogs.userId))
    )

    // Add date range filters if provided
    if (startDate) {
      conditions = and(conditions, gte(workflowExecutionLogs.startedAt, new Date(startDate)))
    }
    if (endDate) {
      conditions = and(conditions, lte(workflowExecutionLogs.startedAt, new Date(endDate)))
    }

    // Add level filter if provided
    if (level) {
      conditions = and(conditions, eq(workflowExecutionLogs.level, level))
    }

    // Add chatId filter if provided
    if (chatId) {
      conditions = and(conditions, eq(workflowExecutionLogs.chatId, chatId))
    }

    // Add conversation ID filter if provided (search in executionData)
    // if (conversationId) {
    //   conditions = and(conditions, sql`${workflowExecutionLogs.executionData}->>'conversationId' = ${conversationId}`)
    // }

    // Log the conditions in a safe way (avoid circular references)
    const conditionsInfo = {
      workflowId: deploymentWorkflowId,
      identifier,
      isExternalChat: true,
      executingUserId,
      startDate: startDate || null,
      endDate: endDate || null,
      level: level || null,
      conversationId: conversationId || null,
      chatId: chatId || null,
    }
    logger.debug(`[${requestId}] Query conditions:`, conditionsInfo)

    // Query workflow execution logs for external chat
    const logs = await db
      .select({
        id: workflowExecutionLogs.id,
        executionId: workflowExecutionLogs.executionId,
        level: workflowExecutionLogs.level,
        trigger: workflowExecutionLogs.trigger,
        startedAt: workflowExecutionLogs.startedAt,
        endedAt: workflowExecutionLogs.endedAt,
        totalDurationMs: workflowExecutionLogs.totalDurationMs,
        executionData: workflowExecutionLogs.executionData,
        workspaceId: workflowExecutionLogs.workspaceId,
        initialInput: workflowExecutionLogs.initialInput,
        finalChatOutput: workflowExecutionLogs.finalChatOutput,
        createdAt: workflowExecutionLogs.createdAt,
      })
      .from(workflowExecutionLogs)
      .where(conditions)
      .orderBy(workflowExecutionLogs.startedAt)
      .limit(limit)
      .offset(offset)

    let userWorkspaceIds: string[] = []
    try {
      userWorkspaceIds = await getWorkspaceIdsForUser(executingUserId)
    } catch {
      // Non-fatal; user will get no knowledge refs in history
    }

    // Batch fetch feedback status (liked) for all executionIds in this page
    const executionIds = logs.map((l) => l.executionId)
    let likedByExecutionId = new Map<string, boolean>()
    if (executionIds.length > 0) {
      // Aggregate to a single boolean per executionId for efficiency
      const feedbackRows = await db
        .select({
          executionId: chatPromptFeedback.executionId,
          liked: sql<boolean>`bool_or(${chatPromptFeedback.liked})`,
        })
        .from(chatPromptFeedback)
        .where(inArray(chatPromptFeedback.executionId, executionIds))
        .groupBy(chatPromptFeedback.executionId)

      likedByExecutionId = new Map(feedbackRows.map((r) => [r.executionId, !!r.liked]))
    }

    // Get total count for pagination
    const totalCountResult = await db
      .select({ count: sql`count(*)` })
      .from(workflowExecutionLogs)
      .where(conditions)

    const totalCount = totalCountResult[0]?.count || 0

    const formattedLogs = await Promise.all(
      logs.map(async (log) => {
        const executionData = await materializeExecutionData(
          toExecutionDataRecord(log.executionData),
          {
            workspaceId: log.workspaceId,
            workflowId: deploymentWorkflowId,
            executionId: log.executionId,
          }
        )

        const userInput = log.initialInput || null
        const modelOutput = log.finalChatOutput || null
        const conversationId = readHistoryConversationId(executionData)

        const rawKnowledgeRefs = Array.isArray(executionData.knowledgeRefs)
          ? executionData.knowledgeRefs
          : null
        const attachments = getPersistedHistoryAttachments(executionData)
        const generatedImages = getPersistedGeneratedImages(executionData)
        const knowledgeRefs =
          rawKnowledgeRefs == null
            ? null
            : userWorkspaceIds.length === 0
              ? null
              : rawKnowledgeRefs.filter((ref) => {
                  if (!isRecord(ref) || typeof ref.workspaceId !== 'string') return false
                  return userWorkspaceIds.includes(ref.workspaceId)
                })

        return {
          id: log.id,
          executionId: log.executionId,
          level: log.level,
          trigger: log.trigger,
          startedAt: log.startedAt.toISOString(),
          endedAt: log.endedAt?.toISOString() || null,
          totalDurationMs: log.totalDurationMs,
          conversationId,
          userInput,
          attachments,
          modelOutput,
          generatedImages,
          knowledgeRefs,
          liked: likedByExecutionId.has(log.executionId)
            ? likedByExecutionId.get(log.executionId)!
            : null,
          createdAt: log.createdAt.toISOString(),
        }
      })
    )

    const response = {
      logs: formattedLogs,
      pagination: {
        limit,
        offset,
        total: totalCount,
        hasMore: offset + limit < Number(totalCount),
      },
      //   filters: {
      //     startDate: startDate || null,
      //     endDate: endDate || null,
      //     conversationId: conversationId || null,
      //     level: level || null,
      //   }
      //   summary: {
      //     totalExecutions: Number(totalCount),
      //     successfulExecutions: formattedLogs.filter(log => log.level === 'info').length,
      //     failedExecutions: formattedLogs.filter(log => log.level === 'error').length,
      //     uniqueConversations: new Set(formattedLogs.map(log => log.conversationId).filter(Boolean)).size,
      //   },
    }

    logger.info(
      `[${requestId}] Successfully fetched ${formattedLogs.length} chat history entries for identifier: ${identifier}`
    )

    return addCorsHeaders(createSuccessResponse(response), request)
  } catch (error: any) {
    logger.error(`[${requestId}] Error fetching chat history:`, error)
    return addCorsHeaders(
      createErrorResponse(error.message || 'Failed to fetch chat history', 500),
      request
    )
  }
}
