import { db } from '@sim/db'
import { chatPromptFeedback, workflowExecutionLogs } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import { and, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
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
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession()
    const executionId = (await params).id

    if (!session) {
      return createCodedErrorResponse('Unauthorized', 401)
    }

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized - no active session' }, { status: 401 })
    }

    // Parse and validate request body
    const body = feedbackSchema.parse(await request.json())

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
              eq(chatPromptFeedback.userId, session.user.id)
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
        userId: session.user.id,
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
