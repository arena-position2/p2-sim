import { createLogger } from '@sim/logger'
import {
  assertKnownSizeWithinLimit,
  DEFAULT_MAX_ERROR_BODY_BYTES,
  readResponseJsonWithLimit,
  readResponseTextWithLimit,
} from '@/lib/core/utils/stream-limits'
import { GPT_IMAGE_2_MAX_REFERENCE_IMAGES } from '@/lib/image-generation/block-model-config'
import { IMAGE_GENERATION_PROVIDER_TIMEOUT_MS } from '@/lib/image-generation/constants'
import { resolveProviderInlineImageData } from '@/app/api/google/api-service'

const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_IMAGE_JSON_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 256 * 1024
const GPT_IMAGE_2_MODEL = 'gpt-image-2'
const logger = createLogger('OpenAIImageReference')

const GPT_IMAGE_EDIT_MODELS = new Set([
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
])

interface OpenAIImageEditParams {
  model: string
  prompt: string
  size?: string
  quality?: string
  background?: string
  outputFormat?: string
  moderation?: string
  inputImage?: unknown
  inputImages?: unknown[]
  inputImageMimeType?: string
}

interface OpenAIImageEditResult {
  buffer: Buffer
  contentType: string
  revisedPrompt?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getStringProperty(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const first = value[0]
  return isRecord(first) ? first : undefined
}

function extensionFromContentType(contentType: string): string {
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  if (contentType.includes('webp')) return 'webp'
  return 'png'
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

function summarizeInputImage(inputImage: unknown): Record<string, unknown> {
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
      first: summarizeInputImage(inputImage[0]),
    }
  }

  if (isRecord(inputImage)) {
    return {
      type: 'object',
      keys: Object.keys(inputImage).sort(),
      hasKey: typeof inputImage.key === 'string',
      hasPath: typeof inputImage.path === 'string',
      hasUrl: typeof inputImage.url === 'string',
      urlIsInternal:
        typeof inputImage.url === 'string' && inputImage.url.includes('/api/files/serve/'),
      pathIsInternal:
        typeof inputImage.path === 'string' && inputImage.path.includes('/api/files/serve/'),
      size: typeof inputImage.size === 'number' ? inputImage.size : undefined,
      typeField: typeof inputImage.type === 'string' ? inputImage.type : undefined,
      mimeTypeField: typeof inputImage.mimeType === 'string' ? inputImage.mimeType : undefined,
    }
  }

  return { type: typeof inputImage }
}

function logGptImage2(stage: string, metadata: Record<string, unknown>): void {
  logger.info(`GPT Image 2 edit ${stage}`, {
    ...metadata,
    memory: getMemorySnapshot(),
  })
}

interface OpenAIImageEditOptions {
  userId: string
  requestId?: string
}

/**
 * Generate an OpenAI GPT Image edit using one or more reference images.
 * GPT Image 2 accepts up to 16 references; other GPT Image models use a single reference.
 */
export async function generateOpenAIImageEdit(
  apiKey: string,
  params: OpenAIImageEditParams,
  options: OpenAIImageEditOptions
): Promise<OpenAIImageEditResult> {
  const model = GPT_IMAGE_EDIT_MODELS.has(params.model) ? params.model : 'gpt-image-1.5'
  const shouldLogGptImage2 = model === GPT_IMAGE_2_MODEL

  if (shouldLogGptImage2) {
    logGptImage2('started', {
      requestedModel: params.model,
      resolvedModel: model,
      promptLength: params.prompt.length,
      size: params.size,
      quality: params.quality,
      background: params.background,
      outputFormat: params.outputFormat,
      moderation: params.moderation,
      inputImageMimeType: params.inputImageMimeType,
      inputImage: summarizeInputImage(params.inputImage),
      inputImages: Array.isArray(params.inputImages)
        ? { length: params.inputImages.length, first: summarizeInputImage(params.inputImages[0]) }
        : undefined,
      maxImageBytes: MAX_IMAGE_BYTES,
      maxImageJsonBytes: MAX_IMAGE_JSON_BYTES,
    })
  }

  const referenceSources =
    Array.isArray(params.inputImages) && params.inputImages.length > 0
      ? params.inputImages
      : params.inputImage !== undefined && params.inputImage !== null && params.inputImage !== ''
        ? [params.inputImage]
        : []

  const supportsMultipleReferences = model === GPT_IMAGE_2_MODEL
  const sourcesToResolve = supportsMultipleReferences
    ? referenceSources.slice(0, GPT_IMAGE_2_MAX_REFERENCE_IMAGES)
    : referenceSources.slice(-1)

  if (sourcesToResolve.length === 0) {
    throw new Error('Reference image is required for OpenAI image editing')
  }

  const resolvedReferences: Array<{ buffer: Buffer; mimeType: string }> = []
  for (const [index, source] of sourcesToResolve.entries()) {
    const inline = await resolveProviderInlineImageData(
      source,
      params.inputImageMimeType,
      options.userId,
      `${options.requestId ?? 'openai-image-edit'}-${index}`
    )
    if (shouldLogGptImage2) {
      logGptImage2('reference resolved', {
        referenceIndex: index,
        inlineMimeType: inline?.mimeType,
        inlineBase64Length: inline?.data.length,
        estimatedInlineBytes: inline ? Math.floor((inline.data.length * 3) / 4) : null,
      })
    }
    if (!inline) {
      throw new Error('Reference image is required for OpenAI image editing')
    }

    if (shouldLogGptImage2) {
      logGptImage2('reference buffer decode starting', {
        referenceIndex: index,
        inlineMimeType: inline.mimeType,
        inlineBase64Length: inline.data.length,
      })
    }
    const buffer = Buffer.from(inline.data, 'base64')
    assertKnownSizeWithinLimit(buffer.length, MAX_IMAGE_BYTES, 'OpenAI reference image')
    if (shouldLogGptImage2) {
      logGptImage2('reference buffer decoded', {
        referenceIndex: index,
        referenceBytes: buffer.length,
        referenceMimeType: inline.mimeType,
        referenceExtension: extensionFromContentType(inline.mimeType),
      })
    }
    resolvedReferences.push({ buffer, mimeType: inline.mimeType })
  }

  const form = new FormData()
  for (const [index, reference] of resolvedReferences.entries()) {
    form.append(
      'image',
      new Blob([Uint8Array.from(reference.buffer)], { type: reference.mimeType }),
      `reference-${index}.${extensionFromContentType(reference.mimeType)}`
    )
  }
  form.append('prompt', params.prompt)
  form.append('model', model)
  form.append('n', '1')

  if (params.size) form.append('size', params.size)
  if (params.quality) form.append('quality', params.quality)
  if (params.background) form.append('background', params.background)
  if (params.outputFormat) form.append('output_format', params.outputFormat)
  if (params.moderation) form.append('moderation', params.moderation)

  if (shouldLogGptImage2) {
    logGptImage2('request dispatching', {
      endpoint: 'https://api.openai.com/v1/images/edits',
      formFields: Array.from(form.keys()),
      referenceCount: resolvedReferences.length,
      timeoutMs: IMAGE_GENERATION_PROVIDER_TIMEOUT_MS,
    })
  }

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(IMAGE_GENERATION_PROVIDER_TIMEOUT_MS),
  })

  if (shouldLogGptImage2) {
    logGptImage2('response received', {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      requestId:
        response.headers.get('x-request-id') ??
        response.headers.get('openai-request-id') ??
        response.headers.get('x-openai-request-id'),
    })
  }

  if (!response.ok) {
    const error = await readResponseTextWithLimit(response, {
      maxBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
      label: 'OpenAI image edit error response',
    })
    if (shouldLogGptImage2) {
      logGptImage2('error response read', {
        status: response.status,
        errorLength: error.length,
        errorPreview: error.slice(0, 500),
      })
    }
    throw new Error(`OpenAI API error: ${response.status} - ${error}`)
  }

  if (shouldLogGptImage2) {
    logGptImage2('json read starting', {
      maxImageJsonBytes: MAX_IMAGE_JSON_BYTES,
    })
  }
  const data = await readResponseJsonWithLimit(response, {
    maxBytes: MAX_IMAGE_JSON_BYTES,
    label: 'OpenAI image edit response',
  })
  if (shouldLogGptImage2) {
    logGptImage2('json read completed', {
      topLevelKeys: isRecord(data) ? Object.keys(data).sort() : [],
      dataCount: isRecord(data) && Array.isArray(data.data) ? data.data.length : null,
    })
  }
  if (!isRecord(data)) {
    throw new Error('Invalid OpenAI image edit response')
  }

  const firstImage = firstRecord(data.data)
  const base64Image = getStringProperty(firstImage, 'b64_json')
  const revisedPrompt = getStringProperty(firstImage, 'revised_prompt')

  if (shouldLogGptImage2) {
    logGptImage2('image payload inspected', {
      firstImageKeys: firstImage ? Object.keys(firstImage).sort() : [],
      hasBase64Image: Boolean(base64Image),
      base64Length: base64Image?.length,
      estimatedOutputBytes: base64Image ? Math.floor((base64Image.length * 3) / 4) : null,
      revisedPromptLength: revisedPrompt?.length,
    })
  }

  if (!base64Image) {
    throw new Error('No image data found in OpenAI edit response')
  }

  const outputFormat = params.outputFormat || 'png'
  const contentType =
    outputFormat === 'jpeg' ? 'image/jpeg' : outputFormat === 'webp' ? 'image/webp' : 'image/png'

  return {
    buffer: (() => {
      if (shouldLogGptImage2) {
        logGptImage2('output buffer decode starting', {
          base64Length: base64Image.length,
          contentType,
        })
      }
      const imageBuffer = Buffer.from(base64Image, 'base64')
      assertKnownSizeWithinLimit(imageBuffer.length, MAX_IMAGE_BYTES, 'OpenAI image edit response')
      if (shouldLogGptImage2) {
        logGptImage2('completed', {
          outputBytes: imageBuffer.length,
          contentType,
          revisedPromptLength: revisedPrompt?.length,
        })
      }
      return imageBuffer
    })(),
    contentType,
    revisedPrompt,
  }
}
