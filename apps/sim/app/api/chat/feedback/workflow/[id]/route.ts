import { db } from '@sim/db'
import { chat, chatPromptFeedback, user, workflow, workflowExecutionLogs } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { count, desc, eq, inArray } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { createCodedErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'

const logger = createLogger('ChatFeedbackByWorkflowAPI')

/**
 * Extract user prompt and response from executionData, initialInput, and finalChatOutput
 * Priority: database columns (initialInput/finalChatOutput) > traceSpans extraction
 */
function extractChatData(
  executionData: any,
  initialInput: string | null,
  finalChatOutput: string | null
): {
  userPrompt: string | null
  response: string | null
} {
  let userPrompt = null
  let response = null

  // Get userPrompt from initialInput column (most reliable source)
  if (initialInput && typeof initialInput === 'string' && initialInput.trim().length > 0) {
    userPrompt = initialInput.trim()
  }

  // Get response from finalChatOutput column (most reliable source)
  if (finalChatOutput && typeof finalChatOutput === 'string' && finalChatOutput.trim().length > 0) {
    response = finalChatOutput.trim()
  }

  // Fallback: extract from traceSpans if database columns are not available
  if (executionData?.traceSpans) {
    let traceSpansArray: any[] = []

    // Handle both traceSpans formats: object with spans property or direct array
    if (executionData.traceSpans.spans && Array.isArray(executionData.traceSpans.spans)) {
      traceSpansArray = executionData.traceSpans.spans
    } else if (Array.isArray(executionData.traceSpans)) {
      traceSpansArray = executionData.traceSpans
    }

    if (traceSpansArray.length > 0) {
      // Find workflow execution span in traceSpans
      const workflowSpan = traceSpansArray.find((span: any) => span.type === 'workflow')
      if (workflowSpan?.children && Array.isArray(workflowSpan.children)) {
        // Filter agent spans from workflow children
        const agentSpans = workflowSpan.children.filter((child: any) => child.type === 'agent')
        if (agentSpans.length > 0) {
          const agentSpan = agentSpans[0] // Use first agent span

          // Extract userPrompt from traceSpans only if not already set from initialInput
          if (!userPrompt) {
            const rawUserPrompt = agentSpan.input?.userPrompt || null
            // Remove "user input: " prefix if present
            if (rawUserPrompt && typeof rawUserPrompt === 'string') {
              userPrompt = rawUserPrompt.replace(/^user input:\s*/i, '').trim()
            } else if (rawUserPrompt) {
              userPrompt = rawUserPrompt
            }
          }

          // Extract response from traceSpans only if not already set from finalChatOutput
          if (!response) {
            response = agentSpan.output?.content || null
          }
        }
      }
    }
  }

  return { userPrompt, response }
}

/**
 * GET /api/chat/feedback/workflow/[id]
 * Fetch all chat feedback records for a given workflowId
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: workflowId } = await params
    if (!workflowId) {
      return createCodedErrorResponse('workflowId is required', 400)
    }

    // Parse pagination parameters from query string with validation
    const { searchParams } = new URL(request.url)
    const pageSizeParam = Number(searchParams.get('pageSize'))
    const pageParam = Number(searchParams.get('page'))
    const pageSize = Number.isFinite(pageSizeParam) ? Math.min(Math.max(pageSizeParam, 1), 100) : 20
    const pageNumber = Number.isFinite(pageParam) ? Math.max(pageParam, 1) : 1
    const offset = (pageNumber - 1) * pageSize

    // Fetch author email from chat table for workflow context
    let authorEmail: string | null = null

    // Get chat record to find the user who created the chat
    const chatRecord = await db
      .select({
        userId: chat.userId,
      })
      .from(chat)
      .where(eq(chat.workflowId, workflowId))
      .limit(1)

    if (chatRecord.length > 0 && chatRecord[0].userId) {
      // Get author email from user table using chat userId
      const author = await db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, chatRecord[0].userId))
        .limit(1)

      if (author.length > 0) {
        authorEmail = author[0].email
      }
    }

    // Get total count of feedback records for pagination
    const totalCountResult = await db
      .select({ count: count() })
      .from(chatPromptFeedback)
      .where(eq(chatPromptFeedback.workflowId, workflowId))

    const totalCount = totalCountResult[0]?.count || 0
    const totalPages = Math.ceil(totalCount / pageSize)

    // Fetch feedback records with user email and workflow name via joins
    const feedbackRecords = await db
      .select({
        id: chatPromptFeedback.id,
        userId: chatPromptFeedback.userId,
        userEmail: user.email,
        agentName: workflow.name,
        createdAt: chatPromptFeedback.createdAt,
        comment: chatPromptFeedback.comment,
        inComplete: chatPromptFeedback.inComplete,
        inAccurate: chatPromptFeedback.inAccurate,
        outOfDate: chatPromptFeedback.outOfDate,
        tooLong: chatPromptFeedback.tooLong,
        tooShort: chatPromptFeedback.tooShort,
        liked: chatPromptFeedback.liked,
        executionId: chatPromptFeedback.executionId,
        workflowId: chatPromptFeedback.workflowId,
      })
      .from(chatPromptFeedback)
      .leftJoin(user, eq(user.id, chatPromptFeedback.userId))
      .leftJoin(workflow, eq(workflow.id, chatPromptFeedback.workflowId))
      .where(eq(chatPromptFeedback.workflowId, workflowId))
      .orderBy(desc(chatPromptFeedback.createdAt))
      .limit(pageSize)
      .offset(offset)

    // Fetch execution logs to extract userPrompt and response data
    const executionIds = feedbackRecords.map((f) => f.executionId).filter(Boolean)
    const executionLogsMap = new Map()

    if (executionIds.length > 0) {
      // Get execution data, initialInput, and finalChatOutput for each executionId
      const logs = await db
        .select({
          executionId: workflowExecutionLogs.executionId,
          executionData: workflowExecutionLogs.executionData,
          initialInput: workflowExecutionLogs.initialInput,
          finalChatOutput: workflowExecutionLogs.finalChatOutput,
        })
        .from(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.executionId, executionIds))

      // Map execution logs by executionId for quick lookup
      logs.forEach((log) => {
        executionLogsMap.set(log.executionId, {
          executionData: log.executionData,
          initialInput: log.initialInput,
          finalChatOutput: log.finalChatOutput,
        })
      })
    }

    // Build enriched feedback response with extracted userPrompt and response
    const feedback = feedbackRecords.map((record) => {
      const logData = executionLogsMap.get(record.executionId)
      const executionData = logData?.executionData
      const initialInput = logData?.initialInput || null
      const finalChatOutput = logData?.finalChatOutput || null
      // Extract userPrompt and response using database columns first, then traceSpans fallback
      const { userPrompt, response } = extractChatData(executionData, initialInput, finalChatOutput)

      return {
        id: record.id,
        comment: record.comment || null,
        response: response || null,
        userId: record.userId,
        userEmail: record.userEmail,
        authorEmail,
        agentName: record.agentName,
        createdAt: record.createdAt,
        inComplete: record.inComplete || false,
        inAccurate: record.inAccurate || false,
        outOfDate: record.outOfDate || false,
        tooLong: record.tooLong || false,
        tooShort: record.tooShort || false,
        liked: record.liked ?? null,
        userPrompt: userPrompt || null,
        executionId: record.executionId,
        workflowId: record.workflowId,
      }
    })

    return createSuccessResponse({
      feedback,
      pagination: {
        count: feedback.length,
        pageSize,
        pageNumber,
        totalCount,
        totalPages,
      },
    })
  } catch (error: any) {
    logger.error('Error fetching chat feedback by workflowId:', error)
    return createCodedErrorResponse(error.message || 'Failed to fetch feedback', 500)
  }
}
