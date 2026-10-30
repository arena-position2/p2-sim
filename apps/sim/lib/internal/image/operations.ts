import { createLogger } from '@sim/logger'
import type { ImageToolBody } from '@/lib/api/contracts/tools/media/image'
import { getUserFacingErrorMessage } from '@/lib/core/errors/database-query-error'
import { isPayloadSizeLimitError } from '@/lib/core/utils/stream-limits'
import { runImageToolGeneration } from '@/lib/image-generation/run-image-tool.server'
import type { ImageGenerationInput } from '@/lib/internal/image/schema'

const logger = createLogger('ImageOperations')

export interface ImageOperationContext {
  userId: string
  workspaceId?: string
  workflowId?: string
  executionId?: string
  requestId: string
  signal?: AbortSignal
}

/**
 * In-process image generation for the internal `image_generate` tool.
 *
 * Generation (OpenAI edit/references, Gemini, Fal.ai) stays in
 * {@link runImageToolGeneration}; this wrapper is the abort-aware operation
 * boundary the tool registry calls.
 */
export async function executeImageGeneration(
  body: ImageGenerationInput,
  context: ImageOperationContext
): Promise<Response> {
  const { requestId } = context
  logger.info(`[${requestId}] Image generation request started`)

  try {
    context.signal?.throwIfAborted()
    const prompt = body.prompt
    if (prompt.length < 3 || prompt.length > 4000) {
      return Response.json(
        { error: 'Prompt must be between 3 and 4000 characters' },
        { status: 400 }
      )
    }

    const storedImage = await runImageToolGeneration(
      {
        ...(body as ImageToolBody),
        userId: context.userId,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.executionId ? { executionId: context.executionId } : {}),
      },
      {
        userId: context.userId,
        requestId,
        workspaceId: context.workspaceId,
        workflowId: context.workflowId,
        executionId: context.executionId,
      }
    )
    context.signal?.throwIfAborted()

    logger.info(`[${requestId}] Image generation completed successfully`, {
      provider: storedImage.provider,
      model: storedImage.model,
      contentType: storedImage.contentType,
    })

    return Response.json(storedImage)
  } catch (error) {
    context.signal?.throwIfAborted()
    logger.error(`[${requestId}] Image generation operation error:`, error)
    const errorMessage = getUserFacingErrorMessage(error, 'Unknown error')
    return Response.json(
      { error: errorMessage },
      { status: isPayloadSizeLimitError(error) ? 413 : 500 }
    )
  }
}
