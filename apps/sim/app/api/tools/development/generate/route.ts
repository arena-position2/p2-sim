import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getValidationErrorMessage } from '@/lib/api/server'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import { buildToolLlmCostFromModelUsage } from '@/lib/billing/core/tool-llm-cost'
import { generateRequestId } from '@/lib/core/utils/request'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { generateNextjsApp } from '@/lib/development/nextjs-app-generator'
import {
  getDevelopmentReferenceImageErrorMessage,
  resolveDevelopmentReferenceImage,
} from '@/lib/development/resolve-development-reference-image'
import { RawFileInputSchema } from '@/lib/uploads/utils/file-schemas'

const logger = createLogger('DevelopmentGenerateAPI')

export const runtime = 'nodejs'
export const maxDuration = 600

const RequestSchema = z.object({
  userInput: z.string().min(1, 'userInput is required'),
  repoName: z.string().optional(),
  privateRepo: z.boolean().optional(),
  referenceImage: RawFileInputSchema.nullish(),
  arenaMode: z.boolean().optional(),
  workspaceId: z.string().optional(),
  workflowId: z.string().optional(),
  executionId: z.string().optional(),
})

export const POST = withRouteHandler(async (request: NextRequest) => {
  const requestId = generateRequestId()
  const auth = await checkInternalAuth(request, { requireWorkflowId: false })
  if (!auth.success || !auth.userId) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Authentication required' },
      { status: 401 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: getValidationErrorMessage(parsed.error, 'Invalid request') },
      { status: 400 }
    )
  }

  let referenceImage
  try {
    referenceImage = await resolveDevelopmentReferenceImage({
      referenceImage: parsed.data.referenceImage ?? undefined,
      userId: auth.userId,
      requestId,
      logger,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: getDevelopmentReferenceImageErrorMessage(error) },
      { status: 400 }
    )
  }

  logger.info('Generating Next.js app', {
    repoName: parsed.data.repoName,
    privateRepo: parsed.data.privateRepo,
    hasReferenceImage: Boolean(referenceImage),
    arenaMode: parsed.data.arenaMode === true,
  })

  const result = await generateNextjsApp({
    userInput: parsed.data.userInput,
    repoName: parsed.data.repoName,
    privateRepo: parsed.data.privateRepo,
    referenceImage,
    arenaMode: parsed.data.arenaMode === true,
  })

  // Cost is returned on the response for span → usage_log billing (no side-channel).
  const billing = buildToolLlmCostFromModelUsage(result.llmUsage)

  if (!result.success) {
    return NextResponse.json(billing ? { ...result, ...billing } : result, { status: 500 })
  }

  return NextResponse.json(billing ? { ...result, ...billing } : result)
})
