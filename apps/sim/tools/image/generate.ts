import { isUserFile } from '@/lib/core/utils/user-file'
import {
  IMAGE_BLOCK_MODEL_IDS,
  reconcileImageProviderAndModel,
} from '@/lib/image-generation/block-model-config'
import { FALAI_HOSTED_KEY_MARKUP_MULTIPLIER } from '@/lib/tools/falai-pricing'
import { calculateHostedImageToolCost } from '@/lib/tools/image-pricing'
import type { ImageGenerationParams, ImageGenerationResponse } from '@/tools/image/types'
import type { InternalToolConfig, ToolFileData } from '@/tools/types'

interface ImageGenerationRuntimeParams extends ImageGenerationParams {
  __usingHostedKey?: boolean
  __skipHostedKeyHandling?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractImageUrl(image: unknown): string {
  if (typeof image === 'string') {
    return image
  }

  if (isRecord(image) && typeof image.url === 'string') {
    return image.url
  }

  return ''
}

function toImageFile(image: unknown, contentType = 'image/png'): ToolFileData | '' {
  if (isUserFile(image)) {
    return {
      name: image.name,
      url: image.url,
      mimeType: image.type ?? contentType,
      ...(typeof image.size === 'number' ? { size: image.size } : {}),
      ...(image.base64 !== undefined ? { data: image.base64 } : {}),
    }
  }

  const imageUrl = extractImageUrl(image)
  if (!imageUrl) {
    return ''
  }

  const name =
    isRecord(image) && typeof image.name === 'string' && image.name.trim().length > 0
      ? image.name
      : 'generated-image.png'
  const mimeType =
    isRecord(image) && typeof image.mimeType === 'string' && image.mimeType.trim().length > 0
      ? image.mimeType
      : isRecord(image) && typeof image.type === 'string' && image.type.trim().length > 0
        ? image.type
        : contentType
  const data =
    isRecord(image) && image.data !== undefined && image.data !== null
      ? (image.data as ToolFileData['data'])
      : undefined

  return {
    name,
    url: imageUrl,
    mimeType,
    ...(data !== undefined ? { data } : {}),
  }
}

function resolvePrimaryImageFile(
  data: {
    imageFile?: unknown
    image?: unknown
    imageUrl?: string
    fileName?: string
    contentType?: string
    metadata?: { contentType?: string }
  },
  contentType: string
): ToolFileData | '' {
  if (isUserFile(data.imageFile)) {
    return toImageFile(data.imageFile, contentType)
  }

  if (isUserFile(data.image)) {
    return toImageFile(data.image, contentType)
  }

  if (data.imageUrl) {
    return toImageFile(
      {
        name: data.fileName || 'generated-image.png',
        url: data.imageUrl,
        mimeType: contentType,
      },
      contentType
    )
  }

  if (data.imageFile !== undefined && data.imageFile !== null && data.imageFile !== '') {
    const normalized = toImageFile(data.imageFile, contentType)
    if (normalized) {
      return normalized
    }
  }

  if (data.image !== undefined && data.image !== null && data.image !== '') {
    return toImageFile(data.image, contentType)
  }

  return ''
}

function normalizeImagesOutput(
  images: unknown[] | undefined,
  primaryImage: unknown,
  contentType?: string
) {
  if (Array.isArray(images) && images.length > 0) {
    return images.map((image) => toImageFile(image, contentType))
  }

  const primary = toImageFile(primaryImage, contentType)
  return primary ? [primary] : []
}

const IMAGE_GENERATE_MODEL_IDS = IMAGE_BLOCK_MODEL_IDS.join(', ')

type ImageGenerationToolConfig = InternalToolConfig<ImageGenerationParams, ImageGenerationResponse>

export const imageGenerateTool: ImageGenerationToolConfig = {
  id: 'image_generate',
  name: 'Image Generator',
  description: 'Generate images with OpenAI GPT Image or Google Nano Banana models',
  version: '1.0.0',

  params: {
    provider: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Image generation provider. Use openai for gpt-image-* models; gemini for gemini-*-image* models. When omitted, provider is inferred from model.',
    },
    apiKey: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description:
        'Provider API key. OpenAI and Gemini use hosted keys; only required when using a BYOK provider.',
    },
    model: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: `Provider model ID. Supported models: ${IMAGE_GENERATE_MODEL_IDS}. Provider is inferred from model when omitted.`,
    },
    prompt: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Text prompt describing the image to generate',
    },
    size: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Provider-specific image size',
    },
    aspectRatio: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Aspect ratio, such as auto, 1:1, 16:9, or 9:16',
    },
    resolution: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Provider-specific image resolution, such as 1K, 2K, 4K, 1k, or 2k',
    },
    quality: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Provider-specific image quality',
    },
    background: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Background setting when supported',
    },
    outputFormat: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Output image format: png, jpeg, or webp where supported',
    },
    moderation: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'OpenAI moderation level: auto or low',
    },
    safetyTolerance: {
      type: 'string',
      required: false,
      visibility: 'hidden',
      description: 'Legacy safety tolerance when supported',
    },
    seed: {
      type: 'number',
      required: false,
      visibility: 'hidden',
      description: 'Random seed when supported',
    },
    enableSafetyChecker: {
      type: 'boolean',
      required: false,
      visibility: 'hidden',
      description: 'Enable the safety checker when supported',
    },
    enableWebSearch: {
      type: 'boolean',
      required: false,
      visibility: 'hidden',
      description: 'Enable web search grounding when supported',
    },
    thinkingLevel: {
      type: 'string',
      required: false,
      visibility: 'hidden',
      description: 'Thinking level when supported: minimal or high',
    },
    inputImage: {
      type: 'json',
      required: false,
      visibility: 'user-only',
      description:
        'Reference images for editing. Chat and Start block files are used automatically when unset.',
    },
    inputImages: {
      type: 'json',
      required: false,
      visibility: 'hidden',
      description:
        'Multiple reference images for fusion. Supported on Gemini models (up to 14) and subject to per-model limits.',
    },
    inputImageUrl: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Reference image URLs or refs',
    },
    inputImageUrls: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Multiple reference image URLs or refs',
    },
    inputImageMimeType: {
      type: 'string',
      required: false,
      visibility: 'hidden',
      description: 'MIME type of input image',
    },
    inputImageWarning: {
      type: 'string',
      required: false,
      visibility: 'hidden',
      description:
        'Warning emitted when multiple input images were provided and the latest one was used',
    },
  },

  hosting: {
    enabled: (params) => {
      if ((params as ImageGenerationRuntimeParams).__skipHostedKeyHandling === true) {
        return false
      }
      const reconciled = reconcileImageProviderAndModel({
        provider: params.provider,
        model: typeof params.model === 'string' ? params.model : undefined,
      })
      return (
        reconciled.provider === 'falai' ||
        reconciled.provider === 'openai' ||
        reconciled.provider === 'gemini'
      )
    },
    envKeyPrefix: (params) => {
      const reconciled = reconcileImageProviderAndModel({
        provider: params.provider,
        model: typeof params.model === 'string' ? params.model : undefined,
      })
      if (reconciled.provider === 'gemini') return 'GOOGLE_API_KEY'
      if (reconciled.provider === 'openai') return 'OPENAI_API_KEY'
      return 'FALAI_API_KEY'
    },
    apiKeyParam: 'apiKey',
    byokProviderId: (params) => {
      const reconciled = reconcileImageProviderAndModel({
        provider: params.provider,
        model: typeof params.model === 'string' ? params.model : undefined,
      })
      if (reconciled.provider === 'gemini') return 'google'
      if (reconciled.provider === 'openai') return 'openai'
      return 'falai'
    },
    pricing: {
      type: 'custom',
      getCost: (params, output) => {
        if (
          typeof output.__falaiCostDollars === 'number' &&
          !Number.isNaN(output.__falaiCostDollars)
        ) {
          const providerCostDollars = output.__falaiCostDollars
          return {
            cost: providerCostDollars * FALAI_HOSTED_KEY_MARKUP_MULTIPLIER,
            metadata: {
              ...(typeof output.__falaiBilling === 'object' && output.__falaiBilling !== null
                ? (output.__falaiBilling as Record<string, unknown>)
                : {}),
              providerCostDollars,
              markupMultiplier: FALAI_HOSTED_KEY_MARKUP_MULTIPLIER,
            },
          }
        }

        const reconciled = reconcileImageProviderAndModel({
          provider: params.provider,
          model: typeof params.model === 'string' ? params.model : undefined,
        })
        if (reconciled.provider === 'falai') {
          throw new Error('Fal.ai image response missing cost data')
        }

        const priced = calculateHostedImageToolCost(
          params as unknown as Record<string, unknown>,
          output
        )
        return {
          cost: priced.cost,
          metadata: priced.metadata as unknown as Record<string, unknown>,
        }
      },
    },
    rateLimit: {
      mode: 'per_request',
      requestsPerMinute: 40,
      burstMultiplier: 1,
    },
  },

  operation: {
    modelInput: {
      mode: 'project',
      select: (params) => ({ prompt: params.prompt }),
    },
    input: (params: ImageGenerationRuntimeParams) => ({
      provider: params.provider,
      apiKey: params.apiKey,
      model: params.model,
      prompt: params.prompt,
      size: params.size,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      quality: params.quality,
      background: params.background,
      outputFormat: params.outputFormat,
      moderation: params.moderation,
      safetyTolerance: params.safetyTolerance,
      numImages: params.numImages,
      seed: params.seed,
      enableSafetyChecker: params.enableSafetyChecker,
      enableWebSearch: params.enableWebSearch,
      thinkingLevel: params.thinkingLevel,
      inputImage: params.inputImage,
      inputImages: params.inputImages,
      inputImageUrl: params.inputImageUrl,
      inputImageUrls: params.inputImageUrls,
      inputImageMimeType: params.inputImageMimeType,
      inputImageWarning: params.inputImageWarning,
      useHostedCostTracking: params.__usingHostedKey === true,
    }),
  },

  transformResponse: async (response: Response) => {
    const data = (await response.json()) as {
      success?: boolean
      error?: string
      output?: Partial<ImageGenerationResponse['output']> & {
        image?: unknown
        images?: unknown[]
        s3UploadFailed?: boolean
      }
      content?: string
      image?: string
      imageUrl?: string
      imageFile?: unknown
      fileName?: string
      contentType?: string
      provider?: string
      model?: string
      metadata?: ImageGenerationResponse['output']['metadata']
      s3UploadFailed?: boolean
      __falaiCostDollars?: number
      __falaiBilling?: ImageGenerationResponse['output']['__falaiBilling']
      __imageBilling?: ImageGenerationResponse['output']['__imageBilling']
    }

    if (!response.ok || data.error || data.success === false) {
      return {
        success: false,
        error: data.error || 'Image generation failed',
        output: {
          content: '',
          image: '',
          images: [],
          imageUrl: '',
          provider: data.provider || '',
          model: data.model || '',
          metadata: {
            provider: data.provider || '',
            model: data.model || '',
          },
        },
      }
    }

    if (data.success === true && data.output) {
      const output = data.output
      const contentType = output.metadata?.contentType || 'image/png'
      const imageUrl =
        typeof output.imageUrl === 'string'
          ? output.imageUrl
          : extractImageUrl(output.image) || extractImageUrl(output.images?.[0])
      const image = toImageFile(output.image ?? imageUrl, contentType)
      const images = normalizeImagesOutput(output.images, image, contentType)
      const metadata = output.metadata ?? { provider: '', model: '' }

      return {
        success: true,
        output: {
          content: output.content || imageUrl || 'direct-image',
          image: image || images[0] || '',
          images,
          imageUrl,
          provider: output.provider || metadata.provider || '',
          model: output.model || metadata.model || '',
          metadata: {
            ...metadata,
            provider: output.provider || metadata.provider || '',
            model: output.model || metadata.model || '',
          },
          s3UploadFailed: output.s3UploadFailed,
          __falaiCostDollars: output.__falaiCostDollars,
          __falaiBilling: output.__falaiBilling,
          __imageBilling: output.__imageBilling,
        },
      }
    }

    const contentType = data.contentType || data.metadata?.contentType || 'image/png'
    const image = resolvePrimaryImageFile(data, contentType)
    const imageUrl = data.imageUrl || extractImageUrl(image)
    const images = normalizeImagesOutput(undefined, image, contentType)

    return {
      success: true,
      output: {
        content: data.content || imageUrl || 'direct-image',
        image: image || images[0] || '',
        images,
        imageUrl,
        provider: data.provider || data.metadata?.provider || '',
        model: data.model || data.metadata?.model || '',
        metadata: {
          ...data.metadata,
          provider: data.provider || data.metadata?.provider || '',
          model: data.model || data.metadata?.model || '',
        },
        s3UploadFailed: data.s3UploadFailed ?? data.metadata?.s3UploadFailed,
        __falaiCostDollars: data.__falaiCostDollars,
        __falaiBilling: data.__falaiBilling,
        __imageBilling: data.__imageBilling,
      },
    }
  },

  outputs: {
    content: { type: 'string', description: 'Generated image URL or identifier' },
    image: { type: 'file', description: 'Generated image file' },
    images: {
      type: 'array',
      description: 'All generated image files when multiple images were requested',
      items: { type: 'file', description: 'Generated image file' },
    },
    imageUrl: { type: 'string', description: 'Generated image URL' },
    provider: { type: 'string', description: 'Provider used' },
    model: { type: 'string', description: 'Model used' },
    metadata: {
      type: 'json',
      description: 'Generation metadata',
      properties: {
        provider: { type: 'string', description: 'Provider used' },
        model: { type: 'string', description: 'Model used' },
        description: { type: 'string', description: 'Provider description', optional: true },
        revisedPrompt: { type: 'string', description: 'Revised prompt', optional: true },
        seed: { type: 'number', description: 'Seed used for generation', optional: true },
        jobId: { type: 'string', description: 'Provider job ID', optional: true },
        contentType: { type: 'string', description: 'Image MIME type', optional: true },
        count: { type: 'number', description: 'Number of images returned', optional: true },
        requested: { type: 'number', description: 'Number of images requested', optional: true },
        failed: { type: 'number', description: 'Number of failed generations', optional: true },
        warnings: {
          type: 'array',
          description: 'Warnings emitted during generation',
          items: { type: 'string', description: 'Warning message' },
          optional: true,
        },
        s3UploadFailed: {
          type: 'boolean',
          description: 'Whether storage upload failed for any image',
          optional: true,
        },
      },
    },
  },
}
