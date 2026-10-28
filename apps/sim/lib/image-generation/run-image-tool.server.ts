import { createLogger } from '@sim/logger'
import { sleep } from '@sim/utils/helpers'
import { generateId } from '@sim/utils/id'
import { isRecordLike } from '@sim/utils/object'
import { type ImageToolBody, imageProviders } from '@/lib/api/contracts/tools/media/image'
import {
  getRotatingApiKey,
  resolveGoogleGenerativeLanguageApiKey,
} from '@/lib/core/config/api-keys'
import { getMaxExecutionTimeout } from '@/lib/core/execution-limits'
import {
  secureFetchWithPinnedIP,
  validateUrlWithDNS,
} from '@/lib/core/security/input-validation.server'
import {
  assertKnownSizeWithinLimit,
  DEFAULT_MAX_ERROR_BODY_BYTES,
  readResponseJsonWithLimit,
  readResponseTextWithLimit,
  readResponseToBufferWithLimit,
} from '@/lib/core/utils/stream-limits'
import { getBaseUrl } from '@/lib/core/utils/urls'
import {
  normalizeImageModelId,
  reconcileImageProviderAndModel,
} from '@/lib/image-generation/block-model-config'
import { IMAGE_GENERATION_PROVIDER_TIMEOUT_MS } from '@/lib/image-generation/constants'
import { generateOpenAIImageEdit } from '@/lib/image-generation/openai-reference.server'
import { type FalAICostMetadata, getFalAICostMetadata } from '@/lib/tools/falai-pricing'
import { buildImageBillingMetadata } from '@/lib/tools/image-pricing'
import { generateFileId } from '@/lib/uploads/contexts/execution/utils'
import { extractStorageKey, isInternalFileUrl } from '@/lib/uploads/utils/file-utils'
import { resolveInternalFileUrl } from '@/lib/uploads/utils/file-utils.server'
import { saveGeneratedImage } from '@/lib/uploads/utils/image-storage.server'
import { parseImageUrls } from '@/lib/utils/parse-image-urls'

const logger = createLogger('ImageToolGeneration', { logLevel: 'INFO' })
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_JSON_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 256 * 1024
const GPT_IMAGE_2_MODEL = 'gpt-image-2'

type ImageProvider = (typeof imageProviders)[number]

interface GeneratedImageResult {
  buffer: Buffer
  contentType: string
  fileName: string
  provider: ImageProvider
  model: string
  sourceUrl?: string
  description?: string
  revisedPrompt?: string
  seed?: number
  jobId?: string
  falaiCost?: FalAICostMetadata
}

function hasReferenceImage(body: ImageToolBody): boolean {
  const inputImage = (body as Record<string, unknown>).inputImage
  const inputImages = (body as Record<string, unknown>).inputImages
  return (
    (inputImage !== undefined && inputImage !== null && inputImage !== '') ||
    (Array.isArray(inputImages) && inputImages.length > 0)
  )
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

function summarizeImageInput(value: unknown): Record<string, unknown> {
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
      first: summarizeImageInput(value[0]),
    }
  }

  if (isRecordLike(value)) {
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

function logGptImage2Route(
  requestId: string,
  stage: string,
  metadata: Record<string, unknown>
): void {
  logger.info(`[${requestId}] GPT Image 2 route ${stage}`, {
    ...metadata,
    memory: getMemorySnapshot(),
  })
}

export interface StoredImageResponse {
  content: string
  imageUrl: string
  /** Canonical generated-image file object (`id`, `name`, `url`, `size`, `type`). */
  image?: unknown
  images?: unknown[]
  imageFile?: unknown
  fileName: string
  contentType: string
  provider: ImageProvider
  model: string
  metadata: {
    provider: ImageProvider
    model: string
    description?: string
    revisedPrompt?: string
    seed?: number
    jobId?: string
    contentType: string
  }
  __falaiCostDollars?: number
  __falaiBilling?: FalAICostMetadata
  __imageBilling?: ReturnType<typeof buildImageBillingMetadata>
}

function resolveImageProviderApiKey(provider: ImageProvider, apiKey: string | undefined): string {
  const trimmedKey = apiKey?.trim()

  if (provider === 'gemini') {
    return resolveGoogleGenerativeLanguageApiKey(trimmedKey)
  }

  if (trimmedKey) {
    return trimmedKey
  }

  if (provider === 'openai') {
    return getRotatingApiKey('openai')
  }

  throw new Error('API key is required')
}

export interface RunImageToolOptions {
  userId: string
  requestId?: string
  workspaceId?: string
  workflowId?: string
  executionId?: string
}

/**
 * Builds an image tool request body from workflow tool execution params.
 */
export function buildImageToolBodyFromExecutionParams(
  params: Record<string, unknown>
): ImageToolBody {
  const context = isRecordLike(params._context) ? params._context : undefined

  return {
    provider: String(params.provider ?? 'openai'),
    apiKey: typeof params.apiKey === 'string' ? params.apiKey : undefined,
    model: typeof params.model === 'string' ? params.model : undefined,
    prompt: String(params.prompt ?? ''),
    size: typeof params.size === 'string' ? params.size : undefined,
    aspectRatio: typeof params.aspectRatio === 'string' ? params.aspectRatio : undefined,
    resolution: typeof params.resolution === 'string' ? params.resolution : undefined,
    quality: typeof params.quality === 'string' ? params.quality : undefined,
    background: typeof params.background === 'string' ? params.background : undefined,
    outputFormat: typeof params.outputFormat === 'string' ? params.outputFormat : undefined,
    moderation: typeof params.moderation === 'string' ? params.moderation : undefined,
    safetyTolerance:
      typeof params.safetyTolerance === 'string' ? params.safetyTolerance : undefined,
    numImages: 1,
    seed: typeof params.seed === 'number' ? params.seed : undefined,
    enableSafetyChecker:
      typeof params.enableSafetyChecker === 'boolean' ? params.enableSafetyChecker : undefined,
    enableWebSearch:
      typeof params.enableWebSearch === 'boolean' ? params.enableWebSearch : undefined,
    thinkingLevel: typeof params.thinkingLevel === 'string' ? params.thinkingLevel : undefined,
    inputImage: params.inputImage,
    inputImages: params.inputImages,
    inputImageUrl: params.inputImageUrl,
    inputImageUrls: params.inputImageUrls,
    inputImageMimeType: params.inputImageMimeType,
    inputImageWarning: params.inputImageWarning,
    workspaceId:
      (typeof context?.workspaceId === 'string' ? context.workspaceId : undefined) ??
      (typeof params.workspaceId === 'string' ? params.workspaceId : undefined),
    workflowId:
      (typeof context?.workflowId === 'string' ? context.workflowId : undefined) ??
      (typeof params.workflowId === 'string' ? params.workflowId : undefined),
    executionId:
      (typeof context?.executionId === 'string' ? context.executionId : undefined) ??
      (typeof params.executionId === 'string' ? params.executionId : undefined),
    userId:
      (typeof context?.userId === 'string' ? context.userId : undefined) ??
      (typeof params.userId === 'string' ? params.userId : undefined),
    useHostedCostTracking: params.__usingHostedKey === true,
  } as ImageToolBody
}

/**
 * Runs image generation in-process for OpenAI, Gemini, and Fal.ai providers.
 */
export async function runImageToolGeneration(
  body: ImageToolBody,
  options: RunImageToolOptions
): Promise<StoredImageResponse> {
  const requestId = options.requestId ?? generateId().slice(0, 8)
  const reconciled = reconcileImageProviderAndModel({
    provider: body.provider,
    model: normalizeImageModelId(body.model),
  })
  if (reconciled.coerced) {
    logger.warn(`[${requestId}] Coerced image generation provider to match model`, {
      requestedProvider: body.provider,
      model: reconciled.model,
      resolvedProvider: reconciled.provider,
    })
  }

  const provider = resolveAllowedParam(
    reconciled.provider,
    imageProviders,
    'openai',
    'provider'
  ) as ImageProvider
  const prompt = body.prompt
  const resolvedBody: ImageToolBody = {
    ...body,
    provider,
    ...(reconciled.model ? { model: reconciled.model } : {}),
    userId: options.userId || body.userId,
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.workflowId ? { workflowId: options.workflowId } : {}),
    ...(options.executionId ? { executionId: options.executionId } : {}),
  }

  if (prompt.length < 3 || prompt.length > 4000) {
    throw new Error('Prompt must be between 3 and 4000 characters')
  }

  logger.info(
    `[${requestId}] Generating image with ${provider}, model: ${resolvedBody.model || 'default'}`
  )

  const apiKey = resolveImageProviderApiKey(provider, resolvedBody.apiKey)
  let imageResult: GeneratedImageResult

  if (provider === 'openai') {
    imageResult = await generateWithOpenAI(apiKey, resolvedBody, requestId, logger, options.userId)
  } else if (provider === 'gemini') {
    imageResult = await generateWithGemini(apiKey, resolvedBody, requestId, logger)
  } else if (provider === 'falai') {
    imageResult = await generateWithFalAI(apiKey, resolvedBody, requestId, logger, options.userId)
  } else {
    throw new Error(`Unknown provider: ${provider}`)
  }

  const storedImage = await storeGeneratedImage(
    imageResult,
    resolvedBody,
    options.userId,
    requestId
  )

  logger.info(`[${requestId}] Image generation completed successfully`, {
    provider,
    model: storedImage.model,
    contentType: storedImage.contentType,
  })

  return storedImage
}

const OPENAI_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
] as const
const OPENAI_IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const
const OPENAI_IMAGE_2_SIZES = [...OPENAI_IMAGE_SIZES, '2560x1440', '3840x2160'] as const
const OPENAI_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const
const OPENAI_IMAGE_BACKGROUNDS = ['auto', 'transparent', 'opaque'] as const
const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const
const OPENAI_MODERATION_LEVELS = ['auto', 'low'] as const

const GEMINI_IMAGE_MODELS = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
] as const
const GEMINI_BASE_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const
const GEMINI_EXTREME_ASPECT_RATIOS = ['1:4', '1:8', '4:1', '8:1'] as const
const GEMINI_IMAGE_SIZES = ['512', '1K', '2K', '4K'] as const
const GEMINI_PRO_IMAGE_SIZES = ['1K', '2K', '4K'] as const

interface FalAIImageModelConfig {
  endpoint: string
  editEndpoint?: string
  defaultSize?: string
  sizeOptions?: readonly string[]
  defaultAspectRatio?: string
  aspectRatios?: readonly string[]
  defaultResolution?: string
  resolutionOptions?: readonly string[]
  defaultOutputFormat?: string
  outputFormats?: readonly string[]
  defaultQuality?: string
  qualityOptions?: readonly string[]
  defaultBackground?: string
  backgroundOptions?: readonly string[]
  defaultSafetyTolerance?: string
  safetyToleranceOptions?: readonly string[]
  maxNumImages?: number
  supportsSeed?: boolean
  supportsEnableSafetyChecker?: boolean
  supportsEnableWebSearch?: boolean
  supportsThinkingLevel?: boolean
}

const FALAI_NANO_BANANA_ASPECT_RATIOS = [
  'auto',
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '5:4',
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
] as const
const FALAI_EXTREME_ASPECT_RATIOS = ['4:1', '1:4', '8:1', '1:8'] as const
const FALAI_STANDARD_IMAGE_SIZES = [
  'square_hd',
  'square',
  'portrait_4_3',
  'portrait_16_9',
  'landscape_4_3',
  'landscape_16_9',
] as const
const FALAI_SEEDREAM_IMAGE_SIZES = [...FALAI_STANDARD_IMAGE_SIZES, 'auto_2K', 'auto_4K'] as const

const FALAI_IMAGE_MODEL_CONFIGS: Record<string, FalAIImageModelConfig> = {
  'nano-banana-2': {
    endpoint: 'fal-ai/nano-banana-2',
    editEndpoint: 'fal-ai/nano-banana-2/edit',
    defaultAspectRatio: 'auto',
    aspectRatios: [...FALAI_NANO_BANANA_ASPECT_RATIOS, ...FALAI_EXTREME_ASPECT_RATIOS],
    defaultResolution: '1K',
    resolutionOptions: ['0.5K', '1K', '2K', '4K'],
    defaultOutputFormat: 'png',
    outputFormats: IMAGE_OUTPUT_FORMATS,
    defaultSafetyTolerance: '4',
    safetyToleranceOptions: ['1', '2', '3', '4', '5', '6'],
    maxNumImages: 4,
    supportsSeed: true,
    supportsEnableWebSearch: true,
    supportsThinkingLevel: true,
  },
  'nano-banana-pro': {
    endpoint: 'fal-ai/nano-banana-pro',
    defaultAspectRatio: '1:1',
    aspectRatios: FALAI_NANO_BANANA_ASPECT_RATIOS,
    defaultResolution: '1K',
    resolutionOptions: ['1K', '2K', '4K'],
    defaultOutputFormat: 'png',
    outputFormats: IMAGE_OUTPUT_FORMATS,
    defaultSafetyTolerance: '4',
    safetyToleranceOptions: ['1', '2', '3', '4', '5', '6'],
    maxNumImages: 4,
    supportsSeed: true,
    supportsEnableWebSearch: true,
  },
  'nano-banana': {
    endpoint: 'fal-ai/nano-banana',
    defaultAspectRatio: '1:1',
    aspectRatios: FALAI_NANO_BANANA_ASPECT_RATIOS.filter((ratio) => ratio !== 'auto'),
    defaultOutputFormat: 'png',
    outputFormats: IMAGE_OUTPUT_FORMATS,
    defaultSafetyTolerance: '4',
    safetyToleranceOptions: ['1', '2', '3', '4', '5', '6'],
    maxNumImages: 4,
    supportsSeed: true,
  },
  'gpt-image-1.5': {
    endpoint: 'fal-ai/gpt-image-1.5',
    defaultSize: '1024x1024',
    sizeOptions: ['1024x1024', '1536x1024', '1024x1536'],
    defaultQuality: 'high',
    qualityOptions: ['low', 'medium', 'high'],
    defaultBackground: 'auto',
    backgroundOptions: OPENAI_IMAGE_BACKGROUNDS,
    defaultOutputFormat: 'png',
    outputFormats: IMAGE_OUTPUT_FORMATS,
    maxNumImages: 4,
  },
  'seedream-v4.5': {
    endpoint: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    defaultSize: 'auto_2K',
    sizeOptions: FALAI_SEEDREAM_IMAGE_SIZES,
    maxNumImages: 6,
    supportsSeed: true,
    supportsEnableSafetyChecker: true,
  },
  'flux-2-pro': {
    endpoint: 'fal-ai/flux-2-pro',
    defaultSize: 'landscape_4_3',
    sizeOptions: FALAI_STANDARD_IMAGE_SIZES,
    defaultOutputFormat: 'jpeg',
    outputFormats: ['jpeg', 'png'],
    defaultSafetyTolerance: '2',
    safetyToleranceOptions: ['1', '2', '3', '4', '5'],
    supportsSeed: true,
    supportsEnableSafetyChecker: true,
  },
  'grok-imagine-image': {
    endpoint: 'xai/grok-imagine-image',
    defaultAspectRatio: '1:1',
    aspectRatios: [
      '2:1',
      '20:9',
      '19.5:9',
      '16:9',
      '4:3',
      '3:2',
      '1:1',
      '2:3',
      '3:4',
      '9:16',
      '9:19.5',
      '9:20',
      '1:2',
    ],
    defaultResolution: '1k',
    resolutionOptions: ['1k', '2k'],
    defaultOutputFormat: 'jpeg',
    outputFormats: IMAGE_OUTPUT_FORMATS,
    maxNumImages: 4,
  },
}

function getStringProperty(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function getNumberProperty(
  record: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' ? value : undefined
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return Array.isArray(value) ? value.find(isRecordLike) : undefined
}

function pickAllowed(
  value: string | undefined,
  allowed: readonly string[],
  fallback: string
): string {
  return value && allowed.includes(value) ? value : fallback
}

/**
 * Uses fallback when value is omitted; throws when a non-empty value is not in the allowlist.
 */
function resolveAllowedParam(
  value: string | undefined,
  allowed: readonly string[],
  fallback: string,
  fieldLabel: string
): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) {
    return fallback
  }
  if (!allowed.includes(trimmed)) {
    throw new Error(`Invalid ${fieldLabel}: "${trimmed}". Must be one of: ${allowed.join(', ')}`)
  }
  return trimmed
}

function getContentTypeForFormat(format: string | undefined): string {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

function extensionFromContentType(contentType: string): string {
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  if (contentType.includes('webp')) return 'webp'
  return 'png'
}

async function bufferFromImageUrl(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  if (url.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.+)$/u.exec(url)
    if (!match) throw new Error('Invalid data URI image response')
    const buffer = Buffer.from(match[2], 'base64')
    assertKnownSizeWithinLimit(buffer.length, MAX_IMAGE_BYTES, 'inline image response')
    return {
      contentType: match[1],
      buffer,
    }
  }

  const urlValidation = await validateUrlWithDNS(url, 'imageUrl', 'contentFetch')
  if (!urlValidation.isValid || !urlValidation.resolvedIP) {
    throw new Error(urlValidation.error || 'Generated image URL failed validation')
  }

  const imageResponse = await secureFetchWithPinnedIP(url, urlValidation.resolvedIP, {
    method: 'GET',
    maxResponseBytes: MAX_IMAGE_BYTES,
    timeout: IMAGE_GENERATION_PROVIDER_TIMEOUT_MS,
    profile: 'contentFetch',
  })
  if (!imageResponse.ok) {
    await readResponseTextWithLimit(imageResponse, {
      maxBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
      label: 'generated image error response',
    }).catch(() => '')
    throw new Error(`Failed to download generated image: ${imageResponse.status}`)
  }

  const contentType = imageResponse.headers.get('content-type') || 'image/png'
  const buffer = await readResponseToBufferWithLimit(imageResponse, {
    maxBytes: MAX_IMAGE_BYTES,
    label: 'generated image download',
  })
  return { buffer, contentType }
}

async function generateWithOpenAI(
  apiKey: string,
  body: ImageToolBody,
  requestId: string,
  logger: ReturnType<typeof createLogger>,
  userId: string
): Promise<GeneratedImageResult> {
  const model = resolveAllowedParam(body.model, OPENAI_IMAGE_MODELS, 'gpt-image-1.5', 'model')
  const bodyRecord = body as Record<string, unknown>
  const inputImage = bodyRecord.inputImage
  const inputImages = bodyRecord.inputImages
  const inputImageMimeType = bodyRecord.inputImageMimeType
  const isGptImage2 = model === GPT_IMAGE_2_MODEL

  if (isGptImage2) {
    logGptImage2Route(requestId, 'openai generation started', {
      provider: body.provider,
      model,
      promptLength: body.prompt.length,
      hasReferenceImage: hasReferenceImage(body),
      hasInputImage: inputImage !== undefined && inputImage !== null && inputImage !== '',
      hasInputImages: Array.isArray(inputImages) && inputImages.length > 0,
      inputImage: summarizeImageInput(inputImage),
      inputImages: Array.isArray(inputImages)
        ? { length: inputImages.length, first: summarizeImageInput(inputImages[0]) }
        : undefined,
      inputImageMimeType,
      requestedSize: body.size,
      requestedQuality: body.quality,
      requestedBackground: body.background,
      requestedOutputFormat: body.outputFormat,
      requestedModeration: body.moderation,
      workspaceId: body.workspaceId,
      workflowId: body.workflowId,
      executionId: body.executionId,
    })
  }

  if (hasReferenceImage(body)) {
    const editParams = {
      model,
      prompt: body.prompt,
      size:
        model === 'gpt-image-2'
          ? pickAllowed(body.size, OPENAI_IMAGE_2_SIZES, 'auto')
          : pickAllowed(body.size, OPENAI_IMAGE_SIZES, 'auto'),
      quality: body.quality ? pickAllowed(body.quality, OPENAI_IMAGE_QUALITIES, 'auto') : undefined,
      background: body.background
        ? pickAllowed(body.background, OPENAI_IMAGE_BACKGROUNDS, 'auto')
        : undefined,
      outputFormat: body.outputFormat
        ? pickAllowed(body.outputFormat, IMAGE_OUTPUT_FORMATS, 'png')
        : undefined,
      moderation: body.moderation
        ? pickAllowed(body.moderation, OPENAI_MODERATION_LEVELS, 'auto')
        : undefined,
      inputImage,
      inputImages: Array.isArray(inputImages) ? inputImages : undefined,
      inputImageMimeType: typeof inputImageMimeType === 'string' ? inputImageMimeType : undefined,
    }

    if (isGptImage2) {
      logGptImage2Route(requestId, 'edit dispatching', {
        size: editParams.size,
        quality: editParams.quality,
        background: editParams.background,
        outputFormat: editParams.outputFormat,
        moderation: editParams.moderation,
        inputImageMimeType: editParams.inputImageMimeType,
      })
    }

    const editResult = await generateOpenAIImageEdit(
      apiKey,
      {
        ...editParams,
      },
      { userId, requestId }
    )

    if (isGptImage2) {
      logGptImage2Route(requestId, 'edit completed', {
        outputBytes: editResult.buffer.length,
        contentType: editResult.contentType,
        revisedPromptLength: editResult.revisedPrompt?.length,
      })
    }

    return {
      buffer: editResult.buffer,
      contentType: editResult.contentType,
      fileName: `openai-${model}.${extensionFromContentType(editResult.contentType)}`,
      provider: 'openai',
      model,
      revisedPrompt: editResult.revisedPrompt,
    }
  }
  const size =
    model === 'gpt-image-2'
      ? pickAllowed(body.size, OPENAI_IMAGE_2_SIZES, 'auto')
      : pickAllowed(body.size, OPENAI_IMAGE_SIZES, 'auto')
  const outputFormat = pickAllowed(body.outputFormat, IMAGE_OUTPUT_FORMATS, 'png')
  const requestBody: Record<string, string | number> = {
    model,
    prompt: body.prompt,
    size,
    n: 1,
  }

  if (body.quality) {
    requestBody.quality = pickAllowed(body.quality, OPENAI_IMAGE_QUALITIES, 'auto')
  }
  if (body.background) {
    requestBody.background = pickAllowed(body.background, OPENAI_IMAGE_BACKGROUNDS, 'auto')
  }
  if (body.outputFormat) {
    requestBody.output_format = outputFormat
  }
  if (body.moderation) {
    requestBody.moderation = pickAllowed(body.moderation, OPENAI_MODERATION_LEVELS, 'auto')
  }

  if (isGptImage2) {
    logGptImage2Route(requestId, 'text-to-image dispatching', {
      requestBodyKeys: Object.keys(requestBody).sort(),
      size,
      outputFormat,
      quality: requestBody.quality,
      background: requestBody.background,
      moderation: requestBody.moderation,
      maxImageJsonBytes: MAX_IMAGE_JSON_BYTES,
    })
  }

  const openaiResponse = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(IMAGE_GENERATION_PROVIDER_TIMEOUT_MS),
  })

  if (isGptImage2) {
    logGptImage2Route(requestId, 'text-to-image response received', {
      status: openaiResponse.status,
      ok: openaiResponse.ok,
      contentType: openaiResponse.headers.get('content-type'),
      contentLength: openaiResponse.headers.get('content-length'),
      requestId:
        openaiResponse.headers.get('x-request-id') ??
        openaiResponse.headers.get('openai-request-id') ??
        openaiResponse.headers.get('x-openai-request-id'),
    })
  }

  if (!openaiResponse.ok) {
    const error = await readResponseTextWithLimit(openaiResponse, {
      maxBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
      label: 'OpenAI image error response',
    })
    if (isGptImage2) {
      logGptImage2Route(requestId, 'text-to-image error response read', {
        status: openaiResponse.status,
        errorLength: error.length,
        errorPreview: error.slice(0, 500),
      })
    }
    throw new Error(`OpenAI API error: ${openaiResponse.status} - ${error}`)
  }

  if (isGptImage2) {
    logGptImage2Route(requestId, 'text-to-image json read starting', {
      maxImageJsonBytes: MAX_IMAGE_JSON_BYTES,
    })
  }
  const data = await readResponseJsonWithLimit(openaiResponse, {
    maxBytes: MAX_IMAGE_JSON_BYTES,
    label: 'OpenAI image response',
  })
  if (isGptImage2) {
    logGptImage2Route(requestId, 'text-to-image json read completed', {
      topLevelKeys: isRecordLike(data) ? Object.keys(data).sort() : [],
      dataCount: isRecordLike(data) && Array.isArray(data.data) ? data.data.length : null,
    })
  }
  if (!isRecordLike(data)) {
    throw new Error('Invalid OpenAI image response')
  }

  const firstImage = firstRecord(data.data)
  const base64Image = getStringProperty(firstImage, 'b64_json')
  const imageUrl = getStringProperty(firstImage, 'url')
  const revisedPrompt = getStringProperty(firstImage, 'revised_prompt')
  let buffer: Buffer
  let contentType = getContentTypeForFormat(outputFormat)

  if (base64Image) {
    if (isGptImage2) {
      logGptImage2Route(requestId, 'text-to-image base64 decode starting', {
        base64Length: base64Image.length,
        estimatedBytes: Math.floor((base64Image.length * 3) / 4),
        contentType,
      })
    }
    buffer = Buffer.from(base64Image, 'base64')
    assertKnownSizeWithinLimit(buffer.length, MAX_IMAGE_BYTES, 'OpenAI image response')
    if (isGptImage2) {
      logGptImage2Route(requestId, 'text-to-image base64 decoded', {
        outputBytes: buffer.length,
        contentType,
      })
    }
  } else if (imageUrl) {
    if (isGptImage2) {
      logGptImage2Route(requestId, 'text-to-image URL download starting', {
        sourceUrlLength: imageUrl.length,
      })
    }
    const downloaded = await bufferFromImageUrl(imageUrl)
    buffer = downloaded.buffer
    contentType = downloaded.contentType
    if (isGptImage2) {
      logGptImage2Route(requestId, 'text-to-image URL downloaded', {
        outputBytes: buffer.length,
        contentType,
      })
    }
  } else {
    logger.error(`[${requestId}] OpenAI response missing image payload`)
    throw new Error('No image data found in OpenAI response')
  }

  if (isGptImage2) {
    logGptImage2Route(requestId, 'openai generation completed', {
      outputBytes: buffer.length,
      contentType,
      hasSourceUrl: Boolean(imageUrl),
      revisedPromptLength: revisedPrompt?.length,
    })
  }

  return {
    buffer,
    contentType,
    fileName: `openai-${model}.${extensionFromContentType(contentType)}`,
    provider: 'openai',
    model,
    sourceUrl: imageUrl,
    revisedPrompt,
  }
}

async function generateWithGemini(
  apiKey: string,
  body: ImageToolBody,
  requestId: string,
  logger: ReturnType<typeof createLogger>
): Promise<GeneratedImageResult> {
  const model = resolveAllowedParam(
    body.model,
    GEMINI_IMAGE_MODELS,
    'gemini-3.1-flash-image-preview',
    'model'
  )
  const aspectRatios =
    model === 'gemini-3.1-flash-image-preview'
      ? [...GEMINI_BASE_ASPECT_RATIOS, ...GEMINI_EXTREME_ASPECT_RATIOS]
      : GEMINI_BASE_ASPECT_RATIOS
  const imageConfig: Record<string, string> = {}

  if (body.aspectRatio) {
    imageConfig.aspectRatio = resolveAllowedParam(
      body.aspectRatio,
      aspectRatios,
      '1:1',
      'aspect ratio'
    )
  }

  if (model === 'gemini-3.1-flash-image-preview' && body.resolution) {
    imageConfig.imageSize = resolveAllowedParam(
      body.resolution,
      GEMINI_IMAGE_SIZES,
      '1K',
      'resolution'
    )
  } else if (model === 'gemini-3-pro-image-preview' && body.resolution) {
    imageConfig.imageSize = resolveAllowedParam(
      body.resolution,
      GEMINI_PRO_IMAGE_SIZES,
      '1K',
      'resolution'
    )
  }

  const requestBody: Record<string, unknown> = {
    contents: [
      {
        parts: [{ text: body.prompt }],
      },
    ],
  }

  requestBody.generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    ...(Object.keys(imageConfig).length > 0 && { imageConfig }),
  }

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(IMAGE_GENERATION_PROVIDER_TIMEOUT_MS),
    }
  )

  if (!geminiResponse.ok) {
    const error = await readResponseTextWithLimit(geminiResponse, {
      maxBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
      label: 'Gemini image error response',
    })
    throw new Error(`Gemini API error: ${geminiResponse.status} - ${error}`)
  }

  const data = await readResponseJsonWithLimit(geminiResponse, {
    maxBytes: MAX_IMAGE_JSON_BYTES,
    label: 'Gemini image response',
  })
  if (!isRecordLike(data)) {
    throw new Error('Invalid Gemini image response')
  }

  const candidate = firstRecord(data.candidates)
  const content = isRecordLike(candidate?.content) ? candidate.content : undefined
  const parts = Array.isArray(content?.parts) ? content.parts : []
  const textPart = parts.find((part) => isRecordLike(part) && typeof part.text === 'string')
  const imagePart = parts.find((part) => {
    if (!isRecordLike(part)) return false
    return isRecordLike(part.inlineData) || isRecordLike(part.inline_data)
  })

  if (!isRecordLike(imagePart)) {
    logger.error(`[${requestId}] Gemini response missing image part`)
    throw new Error('No image data found in Gemini response')
  }

  const inlineData = isRecordLike(imagePart.inlineData)
    ? imagePart.inlineData
    : isRecordLike(imagePart.inline_data)
      ? imagePart.inline_data
      : undefined
  const base64Image = getStringProperty(inlineData, 'data')
  const contentType =
    getStringProperty(inlineData, 'mimeType') ||
    getStringProperty(inlineData, 'mime_type') ||
    'image/png'

  if (!base64Image) {
    throw new Error('Gemini image response missing inline image data')
  }

  return {
    buffer: (() => {
      const buffer = Buffer.from(base64Image, 'base64')
      assertKnownSizeWithinLimit(buffer.length, MAX_IMAGE_BYTES, 'Gemini image response')
      return buffer
    })(),
    contentType,
    fileName: `gemini-${model}.${extensionFromContentType(contentType)}`,
    provider: 'gemini',
    model,
    description: isRecordLike(textPart) ? getStringProperty(textPart, 'text') : undefined,
  }
}

function buildFalAIQueueUrl(endpoint: string, requestId: string, path: 'status' | 'response') {
  return `https://queue.fal.run/${endpoint}/requests/${requestId}/${path}`
}

function getFalAIErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (isRecordLike(error)) {
    return (
      getStringProperty(error, 'message') ||
      getStringProperty(error, 'detail') ||
      JSON.stringify(error)
    )
  }
  return 'Unknown Fal.ai error'
}

function extractReferenceUrl(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed
    }
    if (trimmed.startsWith('/')) {
      return `${getBaseUrl()}${trimmed}`
    }
    return undefined
  }

  if (!isRecordLike(value)) {
    return undefined
  }

  const url =
    typeof value.url === 'string'
      ? value.url.trim()
      : typeof value.path === 'string'
        ? value.path.trim()
        : ''

  if (!url) {
    return undefined
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }

  if (url.startsWith('/')) {
    return `${getBaseUrl()}${url}`
  }

  return undefined
}

function collectReferenceUrls(...inputs: unknown[]): string[] {
  const urls = new Set<string>()
  for (const input of inputs) {
    if (typeof input === 'string') {
      const parsedUrls = parseImageUrls(input)
      if (parsedUrls.length > 0) {
        for (const parsedUrl of parsedUrls) {
          const url = extractReferenceUrl(parsedUrl)
          if (url) urls.add(url)
        }
        continue
      }
    }

    if (Array.isArray(input)) {
      for (const item of input) {
        const url = extractReferenceUrl(item)
        if (url) urls.add(url)
      }
      continue
    }

    const url = extractReferenceUrl(input)
    if (url) urls.add(url)
  }

  return Array.from(urls)
}

async function collectProviderReferenceUrls(
  userId: string,
  requestId: string,
  ...inputs: unknown[]
): Promise<string[]> {
  const urls = collectReferenceUrls(...inputs)
  const resolvedUrls: string[] = []

  for (const url of urls) {
    if (isInternalFileUrl(url)) {
      const resolution = await resolveInternalFileUrl(url, userId, requestId, logger)
      if (resolution.error || !resolution.fileUrl) {
        throw new Error(resolution.error?.message ?? 'Failed to resolve provider reference URL')
      }
      resolvedUrls.push(resolution.fileUrl)
      continue
    }

    resolvedUrls.push(url)
  }

  return resolvedUrls
}

async function generateWithFalAI(
  apiKey: string,
  body: ImageToolBody,
  requestId: string,
  logger: ReturnType<typeof createLogger>,
  userId: string
): Promise<GeneratedImageResult> {
  const falaiModelIds = Object.keys(FALAI_IMAGE_MODEL_CONFIGS)
  const model = resolveAllowedParam(body.model, falaiModelIds, 'nano-banana-2', 'model')
  const modelConfig = FALAI_IMAGE_MODEL_CONFIGS[model]
  if (!modelConfig) {
    throw new Error(`Unknown Fal.ai image model: ${model}`)
  }

  const referenceUrls = await collectProviderReferenceUrls(
    userId,
    requestId,
    body.inputImage,
    body.inputImages,
    body.inputImageUrl,
    body.inputImageUrls
  )
  const endpoint =
    referenceUrls.length > 0 && modelConfig.editEndpoint
      ? modelConfig.editEndpoint
      : modelConfig.endpoint

  const requestBody: Record<string, string | number | boolean | string[]> = {
    prompt: body.prompt,
    sync_mode: false,
  }

  if (referenceUrls.length > 0 && modelConfig.editEndpoint) {
    requestBody.image_urls = referenceUrls
    logger.info(`[${requestId}] Fal.ai image edit references resolved`, {
      model,
      endpoint,
      referenceCount: referenceUrls.length,
      referenceUrlLengths: referenceUrls.map((url) => url.length),
    })
  } else if (referenceUrls.length > 0) {
    logger.warn(`[${requestId}] Fal.ai model does not support reference image edit endpoint`, {
      model,
      referenceCount: referenceUrls.length,
    })
  }

  if (modelConfig.maxNumImages) {
    requestBody.num_images = 1
  }
  if (modelConfig.supportsSeed && body.seed !== undefined) {
    requestBody.seed = body.seed
  }
  if (modelConfig.sizeOptions && modelConfig.defaultSize) {
    requestBody.image_size = pickAllowed(
      body.size,
      modelConfig.sizeOptions,
      modelConfig.defaultSize
    )
  }
  if (modelConfig.aspectRatios && modelConfig.defaultAspectRatio) {
    requestBody.aspect_ratio = resolveAllowedParam(
      body.aspectRatio,
      modelConfig.aspectRatios,
      modelConfig.defaultAspectRatio,
      'aspect ratio'
    )
  }
  if (modelConfig.resolutionOptions && modelConfig.defaultResolution) {
    requestBody.resolution = resolveAllowedParam(
      body.resolution,
      modelConfig.resolutionOptions,
      modelConfig.defaultResolution,
      'resolution'
    )
  }
  if (modelConfig.outputFormats && modelConfig.defaultOutputFormat) {
    requestBody.output_format = pickAllowed(
      body.outputFormat,
      modelConfig.outputFormats,
      modelConfig.defaultOutputFormat
    )
  }
  if (modelConfig.qualityOptions && modelConfig.defaultQuality) {
    requestBody.quality = pickAllowed(
      body.quality,
      modelConfig.qualityOptions,
      modelConfig.defaultQuality
    )
  }
  if (modelConfig.backgroundOptions && modelConfig.defaultBackground) {
    requestBody.background = pickAllowed(
      body.background,
      modelConfig.backgroundOptions,
      modelConfig.defaultBackground
    )
  }
  if (modelConfig.safetyToleranceOptions && modelConfig.defaultSafetyTolerance) {
    requestBody.safety_tolerance = pickAllowed(
      body.safetyTolerance,
      modelConfig.safetyToleranceOptions,
      modelConfig.defaultSafetyTolerance
    )
  }
  if (modelConfig.supportsEnableSafetyChecker && body.enableSafetyChecker !== undefined) {
    requestBody.enable_safety_checker = body.enableSafetyChecker
  }
  if (modelConfig.supportsEnableWebSearch && body.enableWebSearch !== undefined) {
    requestBody.enable_web_search = body.enableWebSearch
  }
  if (modelConfig.supportsThinkingLevel && body.thinkingLevel) {
    requestBody.thinking_level = pickAllowed(body.thinkingLevel, ['minimal', 'high'], 'minimal')
  }

  const createResponse = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  if (!createResponse.ok) {
    const error = await readResponseTextWithLimit(createResponse, {
      maxBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
      label: 'Fal.ai create error response',
    })
    throw new Error(`Fal.ai API error: ${createResponse.status} - ${error}`)
  }

  const createData = await readResponseJsonWithLimit(createResponse, {
    maxBytes: MAX_IMAGE_JSON_BYTES,
    label: 'Fal.ai create response',
  })
  if (!isRecordLike(createData)) {
    throw new Error('Invalid Fal.ai queue response')
  }

  const falRequestId = getStringProperty(createData, 'request_id')
  if (!falRequestId) {
    throw new Error('Fal.ai queue response missing request_id')
  }

  const statusUrl =
    getStringProperty(createData, 'status_url') ||
    buildFalAIQueueUrl(endpoint, falRequestId, 'status')
  const responseUrl =
    getStringProperty(createData, 'response_url') ||
    buildFalAIQueueUrl(endpoint, falRequestId, 'response')

  logger.info(`[${requestId}] Fal.ai image request created: ${falRequestId}`)

  const pollIntervalMs = 1000
  const maxAttempts = Math.ceil(getMaxExecutionTimeout() / pollIntervalMs)
  let attempts = 0

  while (attempts < maxAttempts) {
    if (attempts > 0) {
      await sleep(pollIntervalMs)
    }

    const statusResponse = await fetch(statusUrl, {
      headers: {
        Authorization: `Key ${apiKey}`,
      },
    })

    if (!statusResponse.ok) {
      await readResponseTextWithLimit(statusResponse, {
        maxBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
        label: 'Fal.ai status error response',
      }).catch(() => '')
      throw new Error(`Fal.ai status check failed: ${statusResponse.status}`)
    }

    const statusData = await readResponseJsonWithLimit(statusResponse, {
      maxBytes: MAX_IMAGE_JSON_BYTES,
      label: 'Fal.ai status response',
    })
    if (!isRecordLike(statusData)) {
      throw new Error('Invalid Fal.ai status response')
    }

    const status = getStringProperty(statusData, 'status')
    if (status === 'COMPLETED') {
      const statusError = statusData.error
      if (statusError) {
        throw new Error(`Fal.ai generation failed: ${getFalAIErrorMessage(statusError)}`)
      }

      const resultResponse = await fetch(
        getStringProperty(statusData, 'response_url') || responseUrl,
        {
          headers: {
            Authorization: `Key ${apiKey}`,
          },
        }
      )

      if (!resultResponse.ok) {
        await readResponseTextWithLimit(resultResponse, {
          maxBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
          label: 'Fal.ai result error response',
        }).catch(() => '')
        throw new Error(`Failed to fetch Fal.ai result: ${resultResponse.status}`)
      }

      const resultData = await readResponseJsonWithLimit(resultResponse, {
        maxBytes: MAX_IMAGE_JSON_BYTES,
        label: 'Fal.ai result response',
      })
      if (!isRecordLike(resultData)) {
        throw new Error('Invalid Fal.ai result response')
      }

      const firstImage = firstRecord(resultData.images)
      const imageUrl =
        getStringProperty(firstImage, 'url') ||
        getStringProperty(firstImage, 'data') ||
        getStringProperty(firstImage, 'content')
      if (!imageUrl) {
        throw new Error('No image URL in Fal.ai response')
      }

      const downloaded = await bufferFromImageUrl(imageUrl)
      const contentType =
        getStringProperty(firstImage, 'content_type') ||
        getStringProperty(firstImage, 'contentType') ||
        downloaded.contentType
      const fileName =
        getStringProperty(firstImage, 'file_name') ||
        getStringProperty(firstImage, 'fileName') ||
        `falai-${model}.${extensionFromContentType(contentType)}`

      return {
        buffer: downloaded.buffer,
        contentType,
        fileName,
        provider: 'falai',
        model,
        sourceUrl: imageUrl.startsWith('data:') ? undefined : imageUrl,
        description: getStringProperty(resultData, 'description'),
        revisedPrompt: getStringProperty(resultData, 'revised_prompt'),
        seed: getNumberProperty(resultData, 'seed'),
        jobId: falRequestId,
        falaiCost: body.useHostedCostTracking
          ? await getFalAICostMetadata({
              apiKey,
              endpointId: endpoint,
              requestId: falRequestId,
            })
          : undefined,
      }
    }

    if (['ERROR', 'FAILED', 'CANCELLED'].includes(status || '')) {
      throw new Error(`Fal.ai generation failed: ${getFalAIErrorMessage(statusData.error)}`)
    }

    attempts += 1
  }

  throw new Error('Fal.ai image generation timed out')
}

function buildImageBillingForBody(
  imageResult: GeneratedImageResult,
  body: ImageToolBody
): ReturnType<typeof buildImageBillingMetadata> | undefined {
  if (imageResult.provider !== 'openai' && imageResult.provider !== 'gemini') {
    return undefined
  }

  try {
    return buildImageBillingMetadata({
      provider: imageResult.provider,
      model: imageResult.model,
      size: body.size,
      quality: body.quality,
      resolution: body.resolution,
      aspectRatio: body.aspectRatio,
      numImages: 1,
      hasEdit: hasReferenceImage(body),
    })
  } catch {
    return undefined
  }
}

function buildStoredImageResponse(
  imageResult: GeneratedImageResult,
  safeFileName: string,
  imageUrl: string,
  imageFile: StoredImageResponse['imageFile'],
  body: ImageToolBody,
  s3UploadFailed?: boolean
): StoredImageResponse {
  const imageBilling = buildImageBillingForBody(imageResult, body)
  return {
    content: imageUrl,
    imageUrl,
    image: imageFile,
    images: imageFile ? [imageFile] : [],
    imageFile,
    fileName: safeFileName,
    contentType: imageResult.contentType,
    provider: imageResult.provider,
    model: imageResult.model,
    metadata: {
      provider: imageResult.provider,
      model: imageResult.model,
      description: imageResult.description,
      revisedPrompt: imageResult.revisedPrompt,
      seed: imageResult.seed,
      jobId: imageResult.jobId,
      contentType: imageResult.contentType,
      ...(s3UploadFailed ? { s3UploadFailed } : {}),
    },
    __falaiCostDollars: imageResult.falaiCost?.costDollars,
    __falaiBilling: imageResult.falaiCost,
    ...(imageBilling ? { __imageBilling: imageBilling } : {}),
    ...(s3UploadFailed ? { s3UploadFailed } : {}),
  }
}

async function storeGeneratedImage(
  imageResult: GeneratedImageResult,
  body: ImageToolBody,
  userId: string,
  requestId: string
): Promise<StoredImageResponse> {
  const timestamp = Date.now()
  const safeFileName = imageResult.fileName || `image-${imageResult.provider}-${timestamp}.png`
  const isGptImage2 = imageResult.provider === 'openai' && imageResult.model === GPT_IMAGE_2_MODEL
  const workflowId = body.workflowId?.trim()
  const actorUserId = body.userId?.trim() || userId.trim() || 'unknown'

  if (isGptImage2) {
    logGptImage2Route(requestId, 'storage started', {
      outputBytes: imageResult.buffer.length,
      contentType: imageResult.contentType,
      fileName: safeFileName,
      hasWorkflowId: Boolean(workflowId),
      workspaceId: body.workspaceId,
      workflowId: body.workflowId,
      executionId: body.executionId,
    })
  }

  if (workflowId) {
    if (isGptImage2) {
      logGptImage2Route(requestId, 'agent-generated-images upload starting', {
        outputBytes: imageResult.buffer.length,
        contentType: imageResult.contentType,
        fileName: safeFileName,
        workflowId,
        actorUserId,
      })
    }

    const saveResult = await saveGeneratedImage(
      imageResult.buffer.toString('base64'),
      workflowId,
      actorUserId,
      imageResult.contentType
    )
    const imageUrl = saveResult.url
    const key = extractStorageKey(imageUrl)
    const imageFile = {
      id: generateFileId(),
      name: safeFileName,
      url: imageUrl,
      key,
      size: imageResult.buffer.length,
      type: imageResult.contentType,
      context: 'agent-generated-images' as const,
    }

    if (isGptImage2) {
      logGptImage2Route(requestId, 'agent-generated-images upload completed', {
        fileName: safeFileName,
        imageUrlLength: imageUrl.length,
        key,
        size: imageFile.size,
        type: imageFile.type,
        s3UploadFailed: saveResult.s3UploadFailed,
      })
    }

    return buildStoredImageResponse(
      imageResult,
      safeFileName,
      imageUrl,
      imageFile,
      body,
      saveResult.s3UploadFailed
    )
  }

  const { StorageService } = await import('@/lib/uploads')
  const storageKey = `copilot/${timestamp}-${safeFileName}`
  if (isGptImage2) {
    logGptImage2Route(requestId, 'fallback upload starting', {
      outputBytes: imageResult.buffer.length,
      contentType: imageResult.contentType,
      fileName: safeFileName,
      key: storageKey,
      context: 'copilot',
    })
  }
  const fileInfo = await StorageService.uploadFile({
    file: imageResult.buffer,
    fileName: storageKey,
    contentType: imageResult.contentType,
    context: 'copilot',
    preserveKey: true,
    customKey: storageKey,
  })
  const imageUrl = `${getBaseUrl()}${fileInfo.path}`
  const imageFile = {
    id: generateFileId(),
    name: safeFileName,
    url: imageUrl,
    key: fileInfo.key,
    size: imageResult.buffer.length,
    type: imageResult.contentType,
    context: 'copilot' as const,
  }
  if (isGptImage2) {
    logGptImage2Route(requestId, 'fallback upload completed', {
      fileName: safeFileName,
      imageUrlLength: imageUrl.length,
      path: fileInfo.path,
      key: fileInfo.key,
    })
  }
  logger.info(`[${requestId}] Stored generated image fallback`, {
    fileName: safeFileName,
    key: fileInfo.key,
    size: imageResult.buffer.length,
  })

  return buildStoredImageResponse(imageResult, safeFileName, imageUrl, imageFile, body)
}
