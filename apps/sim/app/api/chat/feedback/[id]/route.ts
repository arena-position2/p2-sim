import { db } from '@sim/db'
import { chatPromptFeedback, user, workflowExecutionLogs } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import { normalizeEmail } from '@sim/utils/string'
import { and, eq, or } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { verifyCronAuth } from '@/lib/auth/internal'
import { createCodedErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'

const logger = createLogger('ChatFeedbackAPI')

// Define validation schema for feedback request body
const feedbackSchema = z.object({
  comment: z.string().optional(),
  inComplete: z.boolean().default(false),
  inAccurate: z.boolean().default(false),
  outOfDate: z.boolean().default(false),
  tooLong: z.boolean().default(false),
  tooShort: z.boolean().default(false),
  liked: z.union([z.boolean(), z.null()]),
  /**
   * Cron auth only: Sim user id to attribute the feedback to.
   * Ignored when a browser session is present.
   */
  userId: z.string().min(1).optional(),
  /**
   * Cron auth only: resolve the Sim user by email when `userId` is omitted.
   * Ignored when a browser session is present.
   */
  emailId: z.string().email().optional(),
})

/**
 * Resolves a Sim user id from an email address.
 */
async function resolveUserIdByEmail(emailId: string): Promise<string | null> {
  const normalizedEmail = normalizeEmail(emailId)
  const [userRecord] = await db
    .select({ id: user.id })
    .from(user)
    .where(or(eq(user.email, normalizedEmail), eq(user.normalizedEmail, normalizedEmail)))
    .limit(1)

  return userRecord?.id ?? null
}

/**
 * POST /api/chat/feedback/[id]
 * `[id]` is the workflow execution id. `workflowId` is loaded from `workflow_execution_logs`.
 * Auth: logged-in Sim session, or `Authorization: Bearer <CRON_SECRET>`.
 * Cron requests must include `userId` or `emailId`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession()
    const sessionUserId = session?.user?.id ?? null
    const executionId = (await params).id

    if (!sessionUserId) {
      const authError = verifyCronAuth(request, 'Chat prompt feedback')
      if (authError) {
        return authError
      }
    }

    // Parse and validate request body
    const body = feedbackSchema.parse(await request.json())

    let userId = sessionUserId
    if (!userId) {
      if (body.userId) {
        userId = body.userId
      } else if (body.emailId) {
        userId = await resolveUserIdByEmail(body.emailId)
        if (!userId) {
          return createCodedErrorResponse('User not found', 404)
        }
      } else {
        return NextResponse.json(
          { error: 'userId or emailId is required when authenticating with CRON_SECRET' },
          { status: 400 }
        )
      }
    }

    try {
      // Check if subdomain is available
      const workflowExectution = await db
        .select()
        .from(workflowExecutionLogs)
        .where(eq(workflowExecutionLogs.executionId, executionId))
        .limit(1)

      if (workflowExectution.length === 0) {
        return createCodedErrorResponse('Invalid execution Id', 400)
      }

      const executionLog = workflowExectution[0]
      if (!executionLog.workflowId) {
        return createCodedErrorResponse('Invalid execution: missing workflow', 400)
      }

      // If liked is null, delete existing feedback records for this executionId+userId (unlike action)
      if (body.liked === null) {
        await db
          .delete(chatPromptFeedback)
          .where(
            and(
              eq(chatPromptFeedback.executionId, executionId),
              eq(chatPromptFeedback.userId, userId)
            )
          )

        return createSuccessResponse({
          message: 'Feedback removed successfully',
        })
      }

      // Otherwise, create a new feedback record
      const id = generateId()

      await db.insert(chatPromptFeedback).values({
        id,
        userId,
        executionId,
        workflowId: executionLog.workflowId,
        comment: body.comment,
        inComplete: body.inComplete,
        inAccurate: body.inAccurate,
        outOfDate: body.outOfDate,
        tooLong: body.tooLong,
        tooShort: body.tooShort,
        liked: body.liked,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      // Return successful response with chat URL
      return createSuccessResponse({
        id,
        message: 'Chat Prompt Feedback created successfully',
      })
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        const errorMessage = validationError.issues[0]?.message || 'Invalid request data'
        return createCodedErrorResponse(errorMessage, 400, 'VALIDATION_ERROR')
      }
      throw validationError
    }
  } catch (error: any) {
    logger.error('Error creating chat deployment:', error)
    return createCodedErrorResponse(error.message || 'Failed to create chat deployment', 500)
  }
}
