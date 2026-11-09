import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import {
  imageGenerationBodySchema,
  imageGenerationContract,
} from '@/lib/api/contracts/image-generation'
import { getValidationErrorMessage } from '@/lib/api/server'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import {
  INLINE_IMAGE_PAYLOAD_ERROR,
  isLikelyTruncatedJsonPayload,
  runImageGenerationWrapper,
} from '@/lib/image-generation/run-wrapper.server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 1200

const logger = createLogger('ImageGenerationWrapperApi')

export async function POST(request: NextRequest) {
  try {
    const authResult = await checkInternalAuth(request, { requireWorkflowId: false })

    if (!authResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: authResult.error || 'Authentication required',
        },
        { status: 401 }
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      logger.error('Failed to parse image generation wrapper request body', {
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        {
          success: false,
          error: isLikelyTruncatedJsonPayload(error)
            ? INLINE_IMAGE_PAYLOAD_ERROR
            : 'Invalid JSON request body',
        },
        { status: isLikelyTruncatedJsonPayload(error) ? 413 : 400 }
      )
    }

    const imageGenerationRequestSchema = imageGenerationContract.body ?? imageGenerationBodySchema
    const parsed = imageGenerationRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: getValidationErrorMessage(parsed.error) },
        { status: 400 }
      )
    }

    const result = await runImageGenerationWrapper(parsed.data)

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          ...(result.failures ? { failures: result.failures } : {}),
        },
        { status: result.status }
      )
    }

    return NextResponse.json({
      success: true,
      output: result.output,
    })
  } catch (error) {
    logger.error('Image generation wrapper request failed', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      },
      { status: 500 }
    )
  }
}
