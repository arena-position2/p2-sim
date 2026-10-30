import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import sharp from 'sharp'
import { resolveGoogleGenerativeLanguageApiKey } from '@/lib/core/config/api-keys'
import { assertKnownSizeWithinLimit } from '@/lib/core/utils/stream-limits'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { assertGeminiImageModel } from '@/lib/image-generation/block-model-config'
import { IMAGE_GENERATION_PROVIDER_TIMEOUT_MS } from '@/lib/image-generation/constants'
import { buildImageBillingMetadata } from '@/lib/tools/image-pricing'
import type { StorageContext } from '@/lib/uploads'
import { S3_AGENT_GENERATED_IMAGES_CONFIG } from '@/lib/uploads/config'
import { downloadFile } from '@/lib/uploads/core/storage-service'
import { extractStorageKey, inferContextFromKey, isInternalFileUrl } from '@/lib/uploads/utils/file'
import { saveGeneratedImage } from '@/lib/uploads/utils/image-storage.server'
import type { ToolResponse } from '@/tools/types'

const logger = createLogger('GoogleApiService')

const SVG_MIME = 'image/svg+xml'
const MAX_URL_IMAGE_SIZE_BYTES = 20 * 1024 * 1024 // 20MB
const URL_FETCH_TIMEOUT_MS = 30_000 // 30 seconds

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

function summarizeInlineImageInput(inputImage: unknown): Record<string, unknown> {
  if (typeof inputImage === 'string') {
    const trimmed = inputImage.trim()
    return {
      type: 'string',
      length: trimmed.length,
      isHttpUrl: trimmed.startsWith('http://') || trimmed.startsWith('https://'),
      isInternalFileUrl: trimmed.includes('/api/files/serve/'),
      isDataUrl: trimmed.startsWith('data:'),
    }
  }

  if (Array.isArray(inputImage)) {
    return {
      type: 'array',
      length: inputImage.length,
      first: summarizeInlineImageInput(inputImage[0]),
    }
  }

  if (isRecord(inputImage)) {
    return {
      type: 'object',
      keys: Object.keys(inputImage).sort(),
      hasKey: typeof inputImage.key === 'string',
      hasPath: typeof inputImage.path === 'string',
      hasUrl: typeof inputImage.url === 'string',
      size: typeof inputImage.size === 'number' ? inputImage.size : undefined,
      typeField: typeof inputImage.type === 'string' ? inputImage.type : undefined,
      mimeTypeField: typeof inputImage.mimeType === 'string' ? inputImage.mimeType : undefined,
      urlIsInternal:
        typeof inputImage.url === 'string' && inputImage.url.includes('/api/files/serve/'),
      pathIsInternal:
        typeof inputImage.path === 'string' && inputImage.path.includes('/api/files/serve/'),
    }
  }

  return { type: typeof inputImage }
}

function normalizeImageMimeType(
  buffer: Buffer,
  preferredMimeType?: string,
  responseMimeType?: string | null
): string {
  const detectedMimeType = detectImageMimeType(buffer)
  const normalizedResponseMimeType = responseMimeType?.split(';')[0].trim().toLowerCase()
  const normalizedPreferredMimeType = preferredMimeType?.split(';')[0].trim().toLowerCase()
  const isGenericResponseMimeType =
    !normalizedResponseMimeType ||
    normalizedResponseMimeType === 'application/octet-stream' ||
    normalizedResponseMimeType === 'binary/octet-stream'

  return (
    detectedMimeType ??
    (isGenericResponseMimeType ? normalizedPreferredMimeType : normalizedResponseMimeType) ??
    normalizedPreferredMimeType ??
    'image/png'
  )
}

function detectImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (
    buffer.length >= 6 &&
    (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif'
  }
  return null
}

/**
 * Gemini image API does not support image/svg+xml. Convert SVG to PNG for API compatibility.
 */
async function ensureSupportedMime(
  buffer: Buffer,
  mimeType: string
): Promise<{ mimeType: string; data: string }> {
  const normalized = mimeType.toLowerCase().split(';')[0].trim()
  if (!normalized || normalized === 'image/*') {
    const detected = detectImageMimeType(buffer) ?? 'image/png'
    return { mimeType: detected, data: buffer.toString('base64') }
  }
  if (normalized !== SVG_MIME) {
    return { mimeType: normalized || 'image/png', data: buffer.toString('base64') }
  }
  logger.info('Converting SVG to PNG for Gemini API compatibility')
  const pngBuffer = await sharp(buffer).png().toBuffer()
  return { mimeType: 'image/png', data: pngBuffer.toString('base64') }
}

async function fetchImageUrlForInlineData(
  url: string,
  preferredMimeType?: string
): Promise<InlineImageData> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Sim-Workflow/1.0' },
    })
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  if (buffer.length === 0) {
    throw new Error('Image from URL is empty')
  }
  if (buffer.length > MAX_URL_IMAGE_SIZE_BYTES) {
    throw new Error(
      `Image from URL exceeds 20MB limit (${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`
    )
  }

  const mimeType = normalizeImageMimeType(
    buffer,
    preferredMimeType,
    response.headers.get('content-type')
  )

  if (!mimeType.startsWith('image/')) {
    throw new Error(`URL did not return an image (${mimeType})`)
  }

  logger.info('Fetched image from URL for inline data', { mimeType, size: buffer.length })
  return ensureSupportedMime(buffer, mimeType)
}
const GOOGLE_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

export interface NanoBananaRequestBody {
  contents: Array<{
    parts: Array<{
      text?: string
      inlineData?: {
        mimeType: string
        data: string
      }
    }>
  }>
  generationConfig?: {
    imageConfig?: {
      aspectRatio?: string
      /** Output resolution for Nano Banana Pro: "1K" | "2K" | "4K" (uppercase K). */
      imageSize?: string
    }
    responseModalities?: string[]
  }
}

interface InlineImageData {
  mimeType: string
  data: string
}

async function resolveStorageImageForInlineData(
  key: string,
  context: StorageContext,
  preferredMimeType?: string
): Promise<InlineImageData> {
  logger.info('Resolving image from storage for inline data', {
    key,
    context,
    preferredMimeType,
    maxBytes: MAX_URL_IMAGE_SIZE_BYTES,
    memory: getMemorySnapshot(),
  })
  const fileBuffer = await downloadFile({ key, context, maxBytes: MAX_URL_IMAGE_SIZE_BYTES })
  assertKnownSizeWithinLimit(fileBuffer.length, MAX_URL_IMAGE_SIZE_BYTES, 'reference image')
  const mimeType = normalizeImageMimeType(fileBuffer, preferredMimeType)
  logger.info('Resolved image from storage for inline data', {
    mimeType,
    size: fileBuffer.length,
    context,
    estimatedBase64Length: Math.ceil(fileBuffer.length / 3) * 4,
    memory: getMemorySnapshot(),
  })
  return ensureSupportedMime(fileBuffer, mimeType)
}

interface NanoBananaResponseParams {
  model?: string
  aspectRatio?: string
  imageSize?: string
  inputImage?: unknown
  inputImageMimeType?: string
  inputImages?: unknown[]
  _context?: {
    workflowId?: string
    sessionUserId?: string
    userId?: string
  }
}

interface CandidatePart {
  text?: string
  inlineData?: {
    mimeType?: string
    data?: string
  }
  inline_data?: {
    mime_type?: string
    data?: string
  }
  image?: {
    data?: string
    mimeType?: string
    mime_type?: string
  }
}

function getObjectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }

  return Object.keys(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const IMAGE_GENERATION_FAILURE_FINISH_REASONS = new Set([
  'NO_IMAGE',
  'IMAGE_OTHER',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_SAFETY',
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
])

function getCandidateFinishReason(candidate: Record<string, unknown>): string {
  const reason = candidate.finishReason ?? candidate.finish_reason
  return typeof reason === 'string' && reason.length > 0 ? reason : 'UNKNOWN'
}

function getCandidateFinishMessage(candidate: Record<string, unknown>): string | undefined {
  const message = candidate.finishMessage ?? candidate.finish_message
  if (typeof message === 'string' && message.trim().length > 0) {
    return message.trim()
  }
  return undefined
}

function formatNanoBananaEmptyCandidateError(
  finishReason: string,
  finishMessage?: string,
  imageSize?: string
): string {
  if (finishMessage) {
    const resolutionHint =
      imageSize === '4K'
        ? ' Try Resolution 2K or 1K, fewer reference images, or smaller reference images.'
        : ''
    return `Google Nano Banana could not generate an image (${finishReason}): ${finishMessage}${resolutionHint}`
  }

  switch (finishReason) {
    case 'NO_IMAGE':
      return 'Google Nano Banana returned NO_IMAGE. The model did not generate an image for this prompt; try a shorter/simpler prompt or a different aspect ratio.'
    case 'IMAGE_OTHER':
      return imageSize === '4K'
        ? 'Google Nano Banana could not generate a 4K image for this prompt. Try Resolution 2K or 1K, fewer reference images, or a simpler prompt.'
        : 'Google Nano Banana could not generate an image for this prompt. Try a shorter prompt, a different aspect ratio, or fewer reference images.'
    case 'IMAGE_PROHIBITED_CONTENT':
      return 'Google Nano Banana blocked image generation because a reference image or prompt was flagged as prohibited content.'
    case 'IMAGE_SAFETY':
    case 'SAFETY':
      return 'Google Nano Banana blocked image generation for safety reasons. Try changing the prompt or reference images.'
    case 'RECITATION':
      return 'Google Nano Banana stopped image generation because the output was too close to existing content.'
    case 'BLOCKLIST':
      return 'Google Nano Banana blocked image generation because the prompt or reference content matched a blocklist.'
    default:
      return `Google Nano Banana returned no image data (${finishReason}). Try a simpler prompt, lower resolution, or fewer reference images.`
  }
}

const extractCandidateParts = (candidate: Record<string, unknown>): CandidatePart[] => {
  const directParts = candidate.parts
  if (Array.isArray(directParts)) {
    return directParts as CandidatePart[]
  }

  const content = candidate.content as
    | { parts?: CandidatePart[]; role?: string }
    | CandidatePart[]
    | undefined

  if (Array.isArray(content)) {
    return content
  }

  if (content?.parts && Array.isArray(content.parts)) {
    return content.parts
  }

  return []
}

export async function buildNanoBananaToolResponse(
  dt: unknown,
  params?: NanoBananaResponseParams
): Promise<ToolResponse> {
  const responseData = isRecord(dt) && isRecord(dt.data) ? dt.data : dt
  const candidates = isRecord(responseData) ? responseData.candidates : undefined

  if (!Array.isArray(candidates) || candidates.length === 0) {
    logger.error('No candidates found in Nano Banana response', {
      topLevelKeys: getObjectKeys(dt),
      dataKeys: getObjectKeys(responseData),
    })
    throw new Error('No candidates found in response')
  }

  const candidate = candidates[0] as Record<string, unknown>
  const finishReason = getCandidateFinishReason(candidate)
  const finishMessage = getCandidateFinishMessage(candidate)
  const candidateParts = extractCandidateParts(candidate)

  if (candidateParts.length === 0) {
    logger.error('Nano Banana candidate returned without image parts', {
      finishReason,
      finishMessage,
      candidateKeys: getObjectKeys(candidate),
      hasPromptFeedback: Boolean(isRecord(responseData) ? responseData.promptFeedback : undefined),
      modelVersion: isRecord(responseData) ? responseData.modelVersion : undefined,
      imageSize: params?.imageSize,
    })
    throw new Error(
      formatNanoBananaEmptyCandidateError(finishReason, finishMessage, params?.imageSize)
    )
  }

  let base64Image: string | null = null
  let mimeType = 'image/png'

  for (const part of candidateParts) {
    const inlineData = part.inlineData ?? part.inline_data
    const imageData = inlineData?.data ?? part.image?.data
    if (imageData) {
      base64Image = imageData
      mimeType =
        part.inlineData?.mimeType ??
        part.inline_data?.mime_type ??
        part.image?.mimeType ??
        part.image?.mime_type ??
        'image/png'
      logger.info('Found image data in part', { mimeType })
      break
    }
  }

  if (!base64Image) {
    logger.error('No image data found in Nano Banana response parts', {
      candidatePartCount: candidateParts.length,
      finishReason,
      finishMessage,
    })
    if (IMAGE_GENERATION_FAILURE_FINISH_REASONS.has(finishReason) || finishMessage) {
      throw new Error(
        formatNanoBananaEmptyCandidateError(finishReason, finishMessage, params?.imageSize)
      )
    }
    throw new Error('No image data found in response parts')
  }

  logger.info('Successfully received Nano Banana image', { base64Length: base64Image.length })

  const workflowId = params?._context?.workflowId || 'unknown'
  const userId = params?._context?.sessionUserId ?? params?._context?.userId ?? 'unknown'

  let finalImageUrl: string | null = null
  let s3UploadFailed: boolean | undefined
  try {
    const saveResult = await saveGeneratedImage(base64Image, workflowId, userId, mimeType)
    finalImageUrl = saveResult.url
    s3UploadFailed = saveResult.s3UploadFailed
    logger.info('Successfully saved Nano Banana image to storage', { url: finalImageUrl })
  } catch (error) {
    logger.error('Error saving Nano Banana image to storage:', error)
    throw new Error(`Failed to save generated image to storage: ${toError(error).message}`)
  }

  const metadata = {
    model: params?.model || 'gemini-2.5-flash-image',
    mimeType,
    aspectRatio: params?.aspectRatio || '1:1',
    imageSize: params?.imageSize ?? null,
    hasInputImage: !!(params?.inputImage && params?.inputImageMimeType),
    hasInputImages: Array.isArray(params?.inputImages) && params.inputImages.length > 0,
    inputImageCount: Array.isArray(params?.inputImages) ? params.inputImages.length : null,
    inputImageMimeType: params?.inputImageMimeType || null,
    stored: !!finalImageUrl,
    s3UploadFailed,
  }

  return {
    success: true,
    output: {
      content: finalImageUrl || 'nano-banana-generated-image',
      image: finalImageUrl,
      images: [finalImageUrl],
      metadata: {
        ...metadata,
        provider: 'gemini',
        model: metadata.model,
      },
      __imageBilling: buildImageBillingMetadata({
        provider: 'gemini',
        model: metadata.model,
        resolution: params?.imageSize ?? undefined,
        aspectRatio: params?.aspectRatio,
        numImages: 1,
        hasEdit: metadata.hasInputImage || metadata.hasInputImages,
      }),
      s3UploadFailed,
    },
  }
}

/**
 * Build the Google Generative Language generateContent URL for a given model.
 *
 * @param model - The Gemini model name (for example, gemini-2.5-flash-image).
 * @returns Fully-qualified generateContent endpoint URL.
 */
export const buildGenerateContentUrl = (model: string): string => {
  const url = `${GOOGLE_API_BASE_URL}/${model}:generateContent`
  logger.info('Resolved generateContent URL', { model, url })
  return url
}

/**
 * Convert an input image reference into inline data accepted by Gemini.
 *
 * @param inputImage - A base64 string or an object containing a path (e.g., s3://...).
 * @param inputImageMimeType - Optional MIME type override.
 * @returns Inline image data or null if no image provided.
 */
export const resolveInlineImageData = async (
  inputImage: unknown,
  inputImageMimeType?: string
): Promise<InlineImageData | null> => {
  logger.info('Resolving inline image data', {
    inputImage: summarizeInlineImageInput(inputImage),
    inputImageMimeType,
    memory: getMemorySnapshot(),
  })

  if (!inputImage) {
    logger.info('No inline image input provided')
    return null
  }

  if (typeof inputImage === 'string') {
    const str = inputImage.trim()
    if (isInternalFileUrl(str)) {
      try {
        const s3Key = extractStorageKey(str)
        logger.info('Inline image string is internal file URL', {
          key: s3Key,
          context: inferContextFromKey(s3Key),
          inputLength: str.length,
          memory: getMemorySnapshot(),
        })
        return await resolveStorageImageForInlineData(
          s3Key,
          inferContextFromKey(s3Key),
          inputImageMimeType
        )
      } catch (error) {
        logger.error('Failed to resolve image from internal URL', {
          url: str.slice(0, 80),
          error,
        })
        throw new Error(`Failed to process input image: ${toError(error).message}`)
      }
    }
    if (str.startsWith('http://') || str.startsWith('https://')) {
      try {
        logger.info('Inline image string is external URL', {
          inputLength: str.length,
          preferredMimeType: inputImageMimeType,
          memory: getMemorySnapshot(),
        })
        return await fetchImageUrlForInlineData(str, inputImageMimeType)
      } catch (error) {
        logger.error('Failed to fetch image from URL', { url: str.slice(0, 80), error })
        throw new Error(`Failed to fetch image from URL: ${toError(error).message}`)
      }
    }
    const mimeType = inputImageMimeType || 'image/png'
    const buffer = Buffer.from(inputImage, 'base64')
    logger.info('Inline image string treated as base64 payload', {
      mimeType,
      base64Length: inputImage.length,
      estimatedBytes: Math.floor((inputImage.length * 3) / 4),
      decodedBytes: buffer.length,
      memory: getMemorySnapshot(),
    })
    return ensureSupportedMime(buffer, mimeType)
  }

  const obj = inputImage as { path?: string; key?: string; url?: string; type?: string }
  if (typeof inputImage !== 'object' || inputImage === null) {
    throw new Error('Invalid input image format')
  }

  if (obj.key) {
    try {
      const context = inferContextFromKey(obj.key)
      return await resolveStorageImageForInlineData(
        obj.key,
        context,
        obj.type || inputImageMimeType
      )
    } catch (error) {
      logger.error('Failed to resolve inline image data from key', error)
      throw new Error(`Failed to process input image: ${toError(error).message}`)
    }
  }

  if (obj.path) {
    try {
      const filePath = obj.path
      let s3Key: string
      let context: StorageContext
      if (filePath.startsWith('s3://')) {
        const urlWithoutProtocol = filePath.replace('s3://', '')
        const pathParts = urlWithoutProtocol.split('/')
        const bucket = pathParts[0]
        s3Key = pathParts.slice(1).join('/').split('?')[0]
        context =
          bucket && bucket === S3_AGENT_GENERATED_IMAGES_CONFIG.bucket
            ? 'agent-generated-images'
            : 'workspace'
      } else {
        s3Key = extractStorageKey(filePath)
        context = inferContextFromKey(s3Key)
      }

      return await resolveStorageImageForInlineData(s3Key, context, obj.type || inputImageMimeType)
    } catch (error) {
      logger.error('Failed to resolve inline image data', error)
      throw new Error(`Failed to process input image: ${toError(error).message}`)
    }
  }

  if (obj.url && isInternalFileUrl(obj.url)) {
    try {
      const s3Key = extractStorageKey(obj.url)
      return await resolveStorageImageForInlineData(
        s3Key,
        inferContextFromKey(s3Key),
        obj.type || inputImageMimeType
      )
    } catch (error) {
      logger.error('Failed to resolve inline image data from URL', error)
      throw new Error(`Failed to process input image: ${toError(error).message}`)
    }
  }

  if (obj.url && (obj.url.startsWith('http://') || obj.url.startsWith('https://'))) {
    try {
      return await fetchImageUrlForInlineData(obj.url, obj.type || inputImageMimeType)
    } catch (error) {
      logger.error('Failed to fetch image from object URL', {
        url: obj.url.slice(0, 80),
        error,
      })
      throw new Error(`Failed to fetch image from URL: ${toError(error).message}`)
    }
  }

  throw new Error('Invalid input image format')
}

async function resolveInternalImageViaProviderUrl(
  internalReference: string,
  preferredMimeType: string | undefined,
  userId: string,
  requestId: string
): Promise<InlineImageData> {
  const absoluteUrl = internalReference.startsWith('http')
    ? internalReference
    : `${getBaseUrl()}${internalReference.startsWith('/') ? internalReference : `/${internalReference}`}`

  const { resolveInternalFileUrl } = await import('@/lib/uploads/utils/file.server')
  const resolution = await resolveInternalFileUrl(absoluteUrl, userId, requestId, logger)
  if (resolution.error || !resolution.fileUrl) {
    throw new Error(resolution.error?.message ?? 'Failed to resolve provider image URL')
  }

  logger.info('Resolved internal image via temporary provider URL', {
    key: extractStorageKey(absoluteUrl),
    requestId,
  })

  return fetchImageUrlForInlineData(resolution.fileUrl, preferredMimeType)
}

/**
 * Resolves a reference image for external image providers (OpenAI edits, Fal.ai image_urls).
 * App-facing metadata should keep `/api/files/serve/...` URLs; this helper mints a short-lived
 * presigned URL only for the provider fetch step.
 */
export const resolveProviderInlineImageData = async (
  inputImage: unknown,
  inputImageMimeType: string | undefined,
  userId: string,
  requestId: string
): Promise<InlineImageData | null> => {
  logger.info('Resolving provider inline image data', {
    inputImage: summarizeInlineImageInput(inputImage),
    inputImageMimeType,
    requestId,
    memory: getMemorySnapshot(),
  })

  if (!inputImage) {
    return null
  }

  if (typeof inputImage === 'string') {
    const str = inputImage.trim()
    if (isInternalFileUrl(str)) {
      return resolveInternalImageViaProviderUrl(str, inputImageMimeType, userId, requestId)
    }
    if (str.startsWith('http://') || str.startsWith('https://')) {
      return fetchImageUrlForInlineData(str, inputImageMimeType)
    }
    const mimeType = inputImageMimeType || 'image/png'
    const buffer = Buffer.from(str, 'base64')
    return ensureSupportedMime(buffer, mimeType)
  }

  const obj = inputImage as { path?: string; key?: string; url?: string; type?: string }
  if (typeof inputImage !== 'object' || inputImage === null) {
    throw new Error('Invalid input image format')
  }

  if (obj.key) {
    return resolveInternalImageViaProviderUrl(
      `/api/files/serve/${encodeURIComponent(obj.key)}`,
      obj.type || inputImageMimeType,
      userId,
      requestId
    )
  }

  if (obj.path) {
    if (obj.path.startsWith('s3://')) {
      const urlWithoutProtocol = obj.path.replace('s3://', '')
      const pathParts = urlWithoutProtocol.split('/')
      const bucket = pathParts[0]
      const s3Key = pathParts.slice(1).join('/').split('?')[0]
      const context =
        bucket && bucket === S3_AGENT_GENERATED_IMAGES_CONFIG.bucket
          ? 'agent-generated-images'
          : 'workspace'
      return resolveInternalImageViaProviderUrl(
        `/api/files/serve/${encodeURIComponent(s3Key)}?context=${context}`,
        obj.type || inputImageMimeType,
        userId,
        requestId
      )
    }

    if (isInternalFileUrl(obj.path)) {
      return resolveInternalImageViaProviderUrl(
        obj.path,
        obj.type || inputImageMimeType,
        userId,
        requestId
      )
    }
  }

  if (obj.url && isInternalFileUrl(obj.url)) {
    return resolveInternalImageViaProviderUrl(
      obj.url,
      obj.type || inputImageMimeType,
      userId,
      requestId
    )
  }

  if (obj.url && (obj.url.startsWith('http://') || obj.url.startsWith('https://'))) {
    return fetchImageUrlForInlineData(obj.url, obj.type || inputImageMimeType)
  }

  throw new Error('Invalid input image format')
}

/**
 * Deduplicate inputImages array before processing. First occurrence wins.
 * Keys: URL strings by value; objects by key, url, or path (whichever present).
 *
 * @param inputImages - Raw array of image refs
 * @returns Deduplicated array
 */
function deduplicateInputImages(inputImages: unknown[]): unknown[] {
  const seen = new Set<string>()
  const result: unknown[] = []
  for (const item of inputImages) {
    let key: string
    if (typeof item === 'string') {
      key = item.trim()
    } else if (item && typeof item === 'object') {
      const obj = item as { key?: string; url?: string; path?: string }
      key = (obj.key || obj.url || obj.path || JSON.stringify(item)) as string
    } else {
      key = String(item)
    }
    if (key && !seen.has(key)) {
      seen.add(key)
      result.push(item)
    }
  }
  return result
}

/**
 * Resolve an array of image references to inline data for multi-image fusion.
 * Deduplicates before processing.
 *
 * @param inputImages - Array of base64 strings, URLs, or objects with path/key/url.
 * @returns Array of inline image data in order, or empty array if none.
 */
export const resolveInlineImageDataArray = async (
  inputImages: unknown[]
): Promise<InlineImageData[]> => {
  const deduplicated = deduplicateInputImages(inputImages)
  const results: InlineImageData[] = []
  for (let i = 0; i < deduplicated.length; i++) {
    const item = deduplicated[i]
    const mimeType =
      typeof item === 'object' && item !== null && 'type' in item
        ? (item as { type?: string }).type
        : undefined
    const resolved = await resolveInlineImageData(item, mimeType)
    if (resolved) {
      results.push(resolved)
    }
  }
  return results
}

/**
 * Build the Nano Banana generateContent request payload.
 *
 * @param params - Request parameters including prompt, aspect ratio, optional image(s).
 * @returns Request body ready for the Google Generative Language API.
 */
export const buildNanoBananaRequestBody = async (params: {
  prompt: string
  aspectRatio?: string
  /** For Nano Banana Pro (gemini-3-pro-image-preview): "1K" | "2K" | "4K". */
  imageSize?: string
  inputImage?: unknown
  inputImageMimeType?: string
  /** Multiple images for fusion (Nano Banana Pro). When set, takes precedence over inputImage. */
  inputImages?: unknown[]
}): Promise<NanoBananaRequestBody> => {
  const parts: Array<{ text?: string; inlineData?: InlineImageData }> = [
    {
      text: params.prompt,
    },
  ]

  if (Array.isArray(params.inputImages) && params.inputImages.length > 0) {
    const inlineImages = await resolveInlineImageDataArray(params.inputImages)
    for (const inlineImage of inlineImages) {
      parts.push({ inlineData: inlineImage })
    }
  } else {
    const inlineImage = await resolveInlineImageData(params.inputImage, params.inputImageMimeType)
    if (inlineImage) {
      parts.push({ inlineData: inlineImage })
    }
  }

  const body: NanoBananaRequestBody = {
    contents: [
      {
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  }

  if (params.aspectRatio || params.imageSize) {
    body.generationConfig!.imageConfig = {
      ...(params.aspectRatio && { aspectRatio: params.aspectRatio }),
      ...(params.imageSize && { imageSize: params.imageSize }),
    }
  }
  return body
}

/** Timeout for the outgoing request to Google – fail before route maxDuration on stuck generations. */
const GOOGLE_API_TIMEOUT_MS = IMAGE_GENERATION_PROVIDER_TIMEOUT_MS

export interface NanoBananaGenerationParams {
  model: string
  prompt: string
  aspectRatio?: string
  imageSize?: string
  apiKey?: string
  inputImage?: unknown
  inputImageMimeType?: string
  inputImages?: unknown[]
  _context?: {
    workflowId?: string
    userId?: string
    sessionUserId?: string
  }
}

export interface NanoBananaGenerationResult {
  toolResponse: ToolResponse
  httpStatus: number
}

/**
 * Generate a Nano Banana image in-process (avoids nested internal HTTP calls that can deadlock dev servers).
 */
export async function generateNanoBananaImage(
  params: NanoBananaGenerationParams
): Promise<NanoBananaGenerationResult> {
  const {
    model,
    prompt,
    aspectRatio,
    imageSize,
    inputImage,
    inputImageMimeType,
    inputImages,
    _context,
  } = params

  if (!model || !prompt) {
    return {
      toolResponse: {
        success: false,
        output: {},
        error: 'Missing required fields: model and prompt are required',
      },
      httpStatus: 400,
    }
  }

  try {
    assertGeminiImageModel(model)
  } catch (error) {
    return {
      toolResponse: {
        success: false,
        output: {},
        error: toError(error).message,
      },
      httpStatus: 400,
    }
  }

  try {
    const apiKey = resolveGoogleGenerativeLanguageApiKey(params.apiKey)
    const url = buildGenerateContentUrl(model)
    const requestBody = await buildNanoBananaRequestBody({
      prompt,
      aspectRatio,
      imageSize,
      inputImage,
      inputImageMimeType,
      inputImages,
    })

    const imageCount = inputImages?.length ?? (inputImage ? 1 : 0)
    logger.info('Sending Nano Banana request', {
      model,
      aspectRatio,
      imageCount,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), GOOGLE_API_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const errorText = await response.text()
      let errorMessage = `Nano Banana API error: ${response.status} ${response.statusText}`
      try {
        const errJson = JSON.parse(errorText) as { error?: { message?: string } }
        if (errJson?.error?.message) {
          errorMessage = `Nano Banana API error: ${errJson.error.message}`
          if (errJson.error.message.toLowerCase().includes('deadline')) {
            errorMessage +=
              '. Try using Resolution 1K, fewer input images, or smaller images for fusion.'
          }
        }
      } catch {
        if (errorText) errorMessage += ` - ${errorText.slice(0, 500)}`
      }
      logger.error('Nano Banana API error response', {
        status: response.status,
        statusText: response.statusText,
        body: errorText,
      })
      return {
        toolResponse: {
          success: false,
          output: {},
          error: errorMessage,
        },
        httpStatus: response.status,
      }
    }

    const data = await response.json()

    const userId = _context?.sessionUserId ?? _context?.userId
    const toolResponse = await buildNanoBananaToolResponse(data, {
      model,
      aspectRatio,
      imageSize,
      inputImage,
      inputImageMimeType,
      inputImages,
      _context: {
        workflowId: _context?.workflowId,
        userId,
      },
    })

    return { toolResponse, httpStatus: 200 }
  } catch (error) {
    logger.error('Unhandled Nano Banana API error', error)
    return {
      toolResponse: {
        success: false,
        output: {},
        error: toError(error).message,
      },
      httpStatus: 500,
    }
  }
}
