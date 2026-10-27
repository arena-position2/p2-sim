import { createLogger } from '@sim/logger'
import { z } from 'zod'
import {
  normalizeImageModelId,
  reconcileImageProviderAndModel,
} from '@/lib/image-generation/block-model-config'
import {
  applyNanoBananaPromptImageParams,
  normalizeOptionalString,
} from '@/lib/image-generation/nano-banana-inputs'
import { resolveImageGenerationCount } from '@/lib/image-generation/resolve-image-count.server'
import type { InternalToolOperationContext } from '@/lib/internal/tool-operations/types'
import type { ExecutionContext } from '@/executor/types'

const logger = createLogger('ImageGenerationWrapper')
const GPT_IMAGE_2_MODEL = 'gpt-image-2'

export const INLINE_IMAGE_PAYLOAD_ERROR =
  'Image Generator request payload is too large or malformed. For 4K image generation with reference images, upload the reference image as a file or use an image URL instead of passing inline base64 image data.'

/** Maximum concurrent base-tool executions per wrapper request. */
const MAX_CONCURRENT_GENERATIONS = 2

/**
 * One provider call paints every variation into a single frame.
 * When the prompt asks for several images, each call must be one variation.
 */
function promptForOutputImage(prompt: string, index: number, imageCount: number): string {
  if (imageCount <= 1) return prompt
  return `Generate exactly one image. This is variation ${index + 1} of ${imageCount}. Do not combine multiple variations, panels, or scenes into one image.\n\n${prompt}`
}

const ImageGenerationWrapperSchema = z.object({
  baseToolId: z.enum(['openai_image', 'google_imagen', 'google_nano_banana', 'image_generate']),
  params: z.record(z.string(), z.unknown()),
})

export type ImageGenerationWrapperInput = z.infer<typeof ImageGenerationWrapperSchema>

export interface ImageGenerationWrapperSuccess {
  success: true
  output: Record<string, unknown>
}

export interface ImageGenerationWrapperFailure {
  success: false
  error: string
  failures?: string[]
  status: number
}

export type ImageGenerationWrapperResult =
  | ImageGenerationWrapperSuccess
  | ImageGenerationWrapperFailure

/** Trusted executeTool options forwarded to each base-model generation. */
export interface ImageGenerationWrapperExecuteOptions {
  executionContext?: ExecutionContext
  operationContext?: InternalToolOperationContext
  signal?: AbortSignal
}

type ToolResult = {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

interface ResolvedContext {
  workflowId?: string
}

function hasExecuteOptions(
  options?: ImageGenerationWrapperExecuteOptions
): options is ImageGenerationWrapperExecuteOptions {
  return Boolean(options?.executionContext || options?.operationContext || options?.signal)
}

async function runWithConcurrency<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = new Array(count)
  let cursor = 0

  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= count) return
      results[index] = await task(index)
    }
  })

  await Promise.all(workers)
  return results
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractImageUrl(image: unknown): string | undefined {
  if (typeof image === 'string' && image.length > 0) {
    return image
  }

  if (isRecord(image) && typeof image.url === 'string' && image.url.length > 0) {
    return image.url
  }

  return undefined
}

function extractImagesFromOutput(output: Record<string, unknown>): string[] {
  const images = output.images
  if (Array.isArray(images)) {
    return images
      .map((image) => extractImageUrl(image))
      .filter((image): image is string => typeof image === 'string' && image.length > 0)
  }

  const image = extractImageUrl(output.image)
  if (image) {
    return [image]
  }

  const imageUrl = extractImageUrl(output.imageUrl)
  return imageUrl ? [imageUrl] : []
}

function getOutputMetadata(output: Record<string, unknown>): Record<string, unknown> {
  return isRecord(output.metadata) ? output.metadata : {}
}

function getStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function getMemorySnapshot(): Record<string, number> {
  const memory = process.memoryUsage()
  return {
    rssMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    externalMb: Math.round(memory.external / 1024 / 1024),
    arrayBuffersMb: Math.round(memory.arrayBuffers / 1024 / 1024),
  }
}

function summarizeReferenceInput(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return {
      type: 'string',
      length: trimmed.length,
      isHttpUrl: trimmed.startsWith('http://') || trimmed.startsWith('https://'),
      isInternalFileUrl: trimmed.includes('/api/files/serve/'),
      isDataUrl: trimmed.startsWith('data:'),
    }
  }

  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      first: summarizeReferenceInput(value[0]),
    }
  }

  if (isRecord(value)) {
    return {
      type: 'object',
      keys: Object.keys(value).sort(),
      hasKey: typeof value.key === 'string',
      hasPath: typeof value.path === 'string',
      hasUrl: typeof value.url === 'string',
      urlIsInternal: typeof value.url === 'string' && value.url.includes('/api/files/serve/'),
      pathIsInternal: typeof value.path === 'string' && value.path.includes('/api/files/serve/'),
      size: typeof value.size === 'number' ? value.size : undefined,
      typeField: typeof value.type === 'string' ? value.type : undefined,
      mimeTypeField: typeof value.mimeType === 'string' ? value.mimeType : undefined,
    }
  }

  return { type: typeof value }
}

function logGptImage2Wrapper(stage: string, metadata: Record<string, unknown>): void {
  logger.info(`GPT Image 2 wrapper ${stage}`, {
    ...metadata,
    memory: getMemorySnapshot(),
  })
}

function hasReferenceImages(params: Record<string, unknown>): boolean {
  const inputImages = params.inputImages
  const inputImage = params.inputImage
  return (
    (Array.isArray(inputImages) && inputImages.length > 0) ||
    (inputImage !== undefined && inputImage !== null && inputImage !== '')
  )
}

function resolveExecutionToolId(
  baseToolId: ImageGenerationWrapperInput['baseToolId'],
  params: Record<string, unknown>
): 'openai_image' | 'google_imagen' | 'google_nano_banana' | 'image_generate' {
  if (baseToolId !== 'image_generate') {
    return baseToolId
  }

  const reconciled = reconcileImageProviderAndModel({
    provider: getStringParam(params, 'provider'),
    model: normalizeImageModelId(getStringParam(params, 'model')),
  })
  if (reconciled.coerced) {
    logger.warn('Coerced image generation provider to match model', {
      requestedProvider: getStringParam(params, 'provider'),
      model: reconciled.model,
      resolvedProvider: reconciled.provider,
    })
  }

  const provider = reconciled.provider
  if (provider === 'openai' && hasReferenceImages(params)) {
    return 'image_generate'
  }
  if (provider === 'openai') {
    return 'openai_image'
  }
  if (provider === 'gemini') {
    return 'google_nano_banana'
  }
  return 'image_generate'
}

function buildExecutionParams(
  toolId: ReturnType<typeof resolveExecutionToolId>,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (toolId === 'google_nano_banana') {
    return {
      ...params,
      imageSize: params.imageSize ?? params.resolution,
    }
  }

  if (toolId === 'image_generate') {
    return {
      ...params,
      __skipSmartWrapper: true,
      __skipHostedKeyHandling: true,
    }
  }

  const { provider: _provider, ...openAIParams } = params
  return openAIParams
}

function getMetadataWarnings(metadata: Record<string, unknown>): string[] {
  const warnings = metadata.warnings
  if (!Array.isArray(warnings)) {
    return []
  }

  return warnings.filter(
    (warning): warning is string => typeof warning === 'string' && warning.length > 0
  )
}

/**
 * Runs the smart image-generation wrapper in-process.
 * Avoids nested internal HTTP calls that can deadlock single-worker dev servers.
 */
export async function runImageGenerationWrapper(
  input: ImageGenerationWrapperInput,
  executeOptions?: ImageGenerationWrapperExecuteOptions
): Promise<ImageGenerationWrapperResult> {
  const validated = ImageGenerationWrapperSchema.parse(input)
  const { inputImageUrl, ...baseParams } = validated.params
  const inputImageWarning = normalizeOptionalString(validated.params.inputImageWarning)
  const originalPrompt = String(baseParams.prompt ?? '')
  const imageCount = originalPrompt
    ? (await resolveImageGenerationCount({ prompt: originalPrompt })).imageCount
    : 1
  const requestedModel = getStringParam(validated.params, 'model') ?? ''
  const isGptImage2 = requestedModel === GPT_IMAGE_2_MODEL
  const executionToolId = resolveExecutionToolId(validated.baseToolId, validated.params)

  if (isGptImage2) {
    logGptImage2Wrapper('input parsed', {
      requestedBaseToolId: validated.baseToolId,
      executionToolId,
      provider: getStringParam(validated.params, 'provider'),
      model: requestedModel,
      promptLength: originalPrompt.length,
      requestedImageCountParam: validated.params.imageCount,
      resolvedImageCount: imageCount,
      hasInputImageUrl: Boolean(inputImageUrl),
      inputImageUrl: summarizeReferenceInput(inputImageUrl),
      inputImage: summarizeReferenceInput(validated.params.inputImage),
      inputImages: summarizeReferenceInput(validated.params.inputImages),
      inputImageUrls: summarizeReferenceInput(validated.params.inputImageUrls),
      size: validated.params.size,
      quality: validated.params.quality,
      background: validated.params.background,
      outputFormat: validated.params.outputFormat,
      moderation: validated.params.moderation,
    })
  }

  const resolvedBaseParams = applyNanoBananaPromptImageParams({
    baseToolId: executionToolId,
    baseParams: {
      ...baseParams,
      ...(originalPrompt ? { prompt: originalPrompt } : {}),
    },
    inputImageUrl,
    inputImages: validated.params.inputImages,
  })

  if (isGptImage2) {
    logGptImage2Wrapper('params resolved', {
      executionToolId,
      resolvedParamKeys: Object.keys(resolvedBaseParams).sort(),
      inputImage: summarizeReferenceInput(resolvedBaseParams.inputImage),
      inputImages: summarizeReferenceInput(resolvedBaseParams.inputImages),
      hasPrompt: typeof resolvedBaseParams.prompt === 'string',
      promptLength:
        typeof resolvedBaseParams.prompt === 'string' ? resolvedBaseParams.prompt.length : null,
    })
  }

  if (inputImageWarning) {
    logger.warn('Image generation input warning', {
      baseToolId: executionToolId,
      warning: inputImageWarning,
    })
  }

  const resolvedContext = resolvedBaseParams._context as ResolvedContext | undefined

  logger.info('Executing image generation wrapper', {
    baseToolId: executionToolId,
    requestedBaseToolId: validated.baseToolId,
    imageCount,
    workflowId: resolvedContext?.workflowId,
    concurrency: Math.min(MAX_CONCURRENT_GENERATIONS, imageCount),
  })

  const { executeTool } = await import('@/tools')

  const settled = await runWithConcurrency<PromiseSettledResult<ToolResult>>(
    imageCount,
    MAX_CONCURRENT_GENERATIONS,
    async (index) => {
      try {
        const executionParams: Record<string, unknown> = {
          ...buildExecutionParams(executionToolId, resolvedBaseParams),
          ...(originalPrompt
            ? { prompt: promptForOutputImage(originalPrompt, index, imageCount) }
            : {}),
        }
        if (isGptImage2) {
          logGptImage2Wrapper('tool execution starting', {
            executionToolId,
            index,
            paramKeys: Object.keys(executionParams).sort(),
            inputImage: summarizeReferenceInput(executionParams.inputImage),
            inputImages: summarizeReferenceInput(executionParams.inputImages),
            promptLength:
              typeof executionParams.prompt === 'string' ? executionParams.prompt.length : null,
          })
        }
        const result = hasExecuteOptions(executeOptions)
          ? await executeTool(executionToolId, executionParams, executeOptions)
          : await executeTool(executionToolId, executionParams)
        if (isGptImage2) {
          const rawOutput = (result as ToolResult).output
          const output: Record<string, unknown> = isRecord(rawOutput) ? rawOutput : {}
          logGptImage2Wrapper('tool execution completed', {
            executionToolId,
            index,
            success: (result as ToolResult).success,
            outputKeys: Object.keys(output).sort(),
            imageCount: extractImagesFromOutput(output).length,
            error: (result as ToolResult).error,
          })
        }
        return { status: 'fulfilled' as const, value: result as ToolResult }
      } catch (err) {
        if (isGptImage2) {
          logGptImage2Wrapper('tool execution threw', {
            executionToolId,
            index,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          })
        }
        return {
          status: 'rejected' as const,
          reason: err instanceof Error ? err : new Error(String(err)),
        }
      }
    }
  )

  const successfulResults: ToolResult[] = []
  const failureMessages: string[] = []

  for (const item of settled) {
    if (item.status === 'fulfilled' && item.value.success) {
      successfulResults.push(item.value)
    } else if (item.status === 'fulfilled') {
      failureMessages.push(item.value.error || 'Image generation failed')
    } else {
      failureMessages.push(item.reason?.message || 'Image generation failed')
    }
  }

  if (successfulResults.length === 0) {
    logger.error('All image generation attempts failed', {
      baseToolId: executionToolId,
      imageCount,
      failures: failureMessages,
    })
    if (isGptImage2) {
      logGptImage2Wrapper('all attempts failed', {
        executionToolId,
        imageCount,
        failures: failureMessages,
      })
    }
    return {
      success: false,
      error: failureMessages[0] || 'Image generation failed',
      failures: failureMessages,
      status: 500,
    }
  }

  if (failureMessages.length > 0) {
    logger.warn('Partial image generation failure', {
      baseToolId: executionToolId,
      requested: imageCount,
      succeeded: successfulResults.length,
      failed: failureMessages.length,
    })
  }

  const firstOutput = isRecord(successfulResults[0]?.output) ? successfulResults[0].output : {}
  const images = successfulResults.flatMap((result) =>
    isRecord(result.output) ? extractImagesFromOutput(result.output) : []
  )
  const s3UploadFailed = successfulResults.some((result) => {
    if (!isRecord(result.output)) return false
    return (
      result.output.s3UploadFailed === true ||
      getOutputMetadata(result.output).s3UploadFailed === true
    )
  })
    ? true
    : undefined

  const primaryImage = images[0] ?? ''
  const primaryContent =
    primaryImage ||
    (typeof firstOutput.content === 'string' && firstOutput.content.length > 0
      ? firstOutput.content
      : '')
  const outputMetadata = getOutputMetadata(firstOutput)
  const provider =
    getStringParam(firstOutput, 'provider') || getStringParam(outputMetadata, 'provider') || ''
  const model =
    getStringParam(firstOutput, 'model') || getStringParam(outputMetadata, 'model') || ''
  const falaiCostDollars = successfulResults.reduce((total, result) => {
    if (!isRecord(result.output)) return total
    const cost = result.output.__falaiCostDollars
    return typeof cost === 'number' && Number.isFinite(cost) ? total + cost : total
  }, 0)
  const falaiBilling = successfulResults
    .map((result) => (isRecord(result.output) ? result.output.__falaiBilling : undefined))
    .filter((billing) => billing !== undefined)
  const imageBilling = successfulResults
    .map((result) => (isRecord(result.output) ? result.output.__imageBilling : undefined))
    .find((billing) => billing !== undefined)
  const warnings = [
    ...getMetadataWarnings(outputMetadata),
    ...(inputImageWarning ? [inputImageWarning] : []),
    ...(failureMessages.length > 0
      ? [
          `Generated ${successfulResults.length} of ${imageCount} requested images; ${failureMessages.length} failed.`,
        ]
      : []),
  ]

  if (isGptImage2) {
    logGptImage2Wrapper('output assembled', {
      executionToolId,
      requested: imageCount,
      succeeded: successfulResults.length,
      failed: failureMessages.length,
      imagesCount: images.length,
      primaryImageLength: primaryImage.length,
      provider,
      model,
      warnings,
      s3UploadFailed,
    })
  }

  return {
    success: true,
    output: {
      content: primaryContent,
      image: primaryImage,
      imageUrl: primaryImage,
      images,
      provider,
      model,
      metadata: {
        ...outputMetadata,
        provider,
        model,
        count: images.length,
        requested: imageCount,
        failed: failureMessages.length,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(s3UploadFailed ? { s3UploadFailed } : {}),
      },
      ...(falaiCostDollars > 0 ? { __falaiCostDollars: falaiCostDollars } : {}),
      ...(falaiBilling.length > 0 ? { __falaiBilling: { requests: falaiBilling } } : {}),
      ...(imageBilling ? { __imageBilling: imageBilling } : {}),
      ...(s3UploadFailed ? { s3UploadFailed } : {}),
    },
  }
}

export function isLikelyTruncatedJsonPayload(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('unterminated string in json') ||
    message.includes('unexpected end of json input')
  )
}
