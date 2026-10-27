import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { getRotatingApiKey } from '@/lib/core/config/api-keys'
import { IMAGE_GENERATION_PROVIDER_TIMEOUT_MS } from '@/lib/image-generation/constants'
import {
  buildImageBillingMetadata,
  calculateHostedImageToolCost,
  getImageModelPerImageCost,
} from '@/lib/tools/image-pricing'
import { S3_AGENT_GENERATED_IMAGES_CONFIG } from '@/lib/uploads/config'
import { saveGeneratedImage } from '@/lib/uploads/utils/image-storage.server'
import type { BaseImageRequestBody } from '@/tools/openai/types'
import type { ToolConfig } from '@/tools/types'

const logger = createLogger('ImageTool')

const GPT_IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const
const GPT_IMAGE_2_SIZES = [...GPT_IMAGE_SIZES, '2560x1440', '3840x2160'] as const
const GPT_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
] as const

export const imageTool: ToolConfig = {
  id: 'openai_image',
  name: 'Image Generator',
  description: "Generate images using OpenAI's Image models",
  version: '1.0.0',

  params: {
    model: {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description:
        'The model to use. Supports dall-e-3, gpt-image-2, gpt-image-1.5, gpt-image-1, and gpt-image-1-mini.',
    },
    prompt: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'A text description of the desired image',
    },
    size: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description:
        'Image size. dall-e-3: 1024x1024, 1024x1792, or 1792x1024. GPT Image models: auto, 1024x1024, 1536x1024, or 1024x1536. gpt-image-2 also supports 2560x1440 and 3840x2160.',
    },
    quality: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Quality. dall-e-3: standard|hd. GPT Image models: auto|low|medium|high',
    },
    style: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'The style of the image (vivid or natural), only for dall-e-3',
    },
    background: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Background for GPT Image models: auto|transparent|opaque',
    },
    outputFormat: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Output image format (png, jpeg, webp), only for GPT Image models',
    },
    moderation: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Moderation level (auto or low), only for GPT Image models',
    },
    apiKey: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'OpenAI API key',
    },
    n: {
      type: 'number',
      required: false,
      visibility: 'hidden',
      description: 'Reserved for legacy callers. This tool returns a single generated image.',
    },
  },

  hosting: {
    enabled: (params) => {
      const model = String(params.model ?? '')
      return model !== 'dall-e-3' && !model.startsWith('dall-e')
    },
    envKeyPrefix: 'OPENAI_API_KEY',
    apiKeyParam: 'apiKey',
    byokProviderId: 'openai',
    pricing: {
      type: 'custom',
      getCost: (params, output) => {
        const priced = calculateHostedImageToolCost(params, output)
        const metadata: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(priced.metadata)) {
          metadata[key] = value
        }
        return { cost: priced.cost, metadata }
      },
    },
    rateLimit: {
      mode: 'per_request',
      requestsPerMinute: 20,
      burstMultiplier: 1,
    },
  },

  request: {
    modelInput: {
      mode: 'project',
      select: (params) => ({ prompt: params.prompt }),
    },
    url: 'https://api.openai.com/v1/images/generations',
    method: 'POST',
    timeout: IMAGE_GENERATION_PROVIDER_TIMEOUT_MS,
    headers: (params) => {
      const apiKey =
        typeof params?.apiKey === 'string' && params.apiKey.trim().length > 0
          ? params.apiKey
          : getRotatingApiKey('openai')
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      }
    },
    body: (params) => {
      const requestedModel = String(params.model || 'dall-e-3')
      const requestedSize = String(params.size || '')
      const size =
        requestedModel === 'dall-e-3'
          ? ['1024x1024', '1024x1792', '1792x1024'].includes(requestedSize)
            ? requestedSize
            : '1024x1024'
          : requestedModel === 'gpt-image-2' &&
              GPT_IMAGE_2_SIZES.includes(requestedSize as (typeof GPT_IMAGE_2_SIZES)[number])
            ? requestedSize
            : GPT_IMAGE_MODELS.includes(requestedModel as (typeof GPT_IMAGE_MODELS)[number]) &&
                GPT_IMAGE_SIZES.includes(requestedSize as (typeof GPT_IMAGE_SIZES)[number])
              ? requestedSize
              : 'auto'
      const body: BaseImageRequestBody = {
        model: requestedModel,
        prompt: params.prompt,
        size,
        n: 1,
      }

      if (requestedModel === 'dall-e-3') {
        if (params.quality) body.quality = params.quality
        if (params.style) body.style = params.style
      } else if (GPT_IMAGE_MODELS.includes(requestedModel as (typeof GPT_IMAGE_MODELS)[number])) {
        if (params.quality) body.quality = params.quality
        if (params.background) body.background = params.background
        if (params.outputFormat) body.output_format = params.outputFormat
        if (params.moderation) body.moderation = params.moderation
      }

      return body
    },
  },

  transformResponse: async (response, params) => {
    try {
      const data = await response.json()

      const sanitizedData = structuredClone(data)
      if (sanitizedData.data && Array.isArray(sanitizedData.data)) {
        sanitizedData.data.forEach((item: { b64_json?: string }) => {
          if (item.b64_json) {
            item.b64_json = `[base64 data truncated, length: ${item.b64_json.length}]`
          }
        })
      }

      const modelName = String(params?.model || 'dall-e-3')
      const resolvedSize = String(params?.size || 'auto')
      const resolvedQuality = typeof params?.quality === 'string' ? params.quality : undefined
      const billingDimensions = {
        provider: 'openai' as const,
        model: modelName,
        size: resolvedSize,
        quality: resolvedQuality,
        numImages: 1,
      }
      const imageBilling =
        getImageModelPerImageCost(billingDimensions) != null
          ? buildImageBillingMetadata(billingDimensions)
          : undefined
      let imageUrl = null
      let base64Image = null

      if (data.data?.[0]?.url) {
        imageUrl = data.data[0].url
      } else if (data.data?.[0]?.b64_json) {
        base64Image = data.data[0].b64_json
        logger.info(
          `Found base64 encoded image in response for ${modelName}`,
          `length: ${base64Image.length}`
        )
      } else {
        logger.error('No image data found in OpenAI image response', {
          topLevelKeys: data && typeof data === 'object' ? Object.keys(data) : [],
          dataLength: Array.isArray(data?.data) ? data.data.length : 0,
        })
        throw new Error('No image data found in response')
      }

      // Preserve the original imageUrl before any processing
      const originalImageUrl = imageUrl

      // Use session user for path when present so path reflects who triggered the run
      const workflowId = params?._context?.workflowId || 'unknown'
      const userId = params?._context?.sessionUserId ?? params?._context?.userId ?? 'unknown'

      logger.info('Image generation context:', {
        workflowId,
        userId,
        hasImageUrl: !!imageUrl,
        hasBase64Image: !!base64Image,
        originalImageUrl: originalImageUrl ? originalImageUrl.substring(0, 100) : null,
      })

      let finalImageUrl: string | null = null
      let s3UploadFailed: boolean | undefined

      if (imageUrl && !base64Image) {
        try {
          logger.info('Fetching generated image for storage...')
          const { fetchRemoteImage } = await import('@/lib/internal/image/fetch')
          const image = await fetchRemoteImage(imageUrl)
          base64Image = image.buffer.toString('base64')
          logger.info('Download from temporary storage completed', {
            base64Length: base64Image.length,
          })
        } catch (error) {
          logger.error('Error downloading image from URL:', {
            error: getErrorMessage(error),
            imageUrl: imageUrl ? imageUrl.substring(0, 100) : 'null',
            originalImageUrl: originalImageUrl ? originalImageUrl.substring(0, 100) : 'null',
          })
          const agentS3Configured =
            !!S3_AGENT_GENERATED_IMAGES_CONFIG.bucket && !!S3_AGENT_GENERATED_IMAGES_CONFIG.region
          if (agentS3Configured) {
            throw new Error(
              `Failed to download image from OpenAI temporary URL for S3 storage: ${getErrorMessage(error)}`
            )
          }
          imageUrl = originalImageUrl
        }
      }

      // Save image to storage and get URL
      if (base64Image) {
        try {
          // Determine MIME type from base64 header or default to png
          let mimeType = 'image/png'
          if (base64Image.startsWith('/9j/') || base64Image.startsWith('iVBORw0KGgo')) {
            mimeType = base64Image.startsWith('/9j/') ? 'image/jpeg' : 'image/png'
          }

          const agentS3Configured =
            !!S3_AGENT_GENERATED_IMAGES_CONFIG.bucket && !!S3_AGENT_GENERATED_IMAGES_CONFIG.region
          if (agentS3Configured) {
            logger.info('S3 upload started', { workflowId, userId, mimeType })
          }
          const saveResult = await saveGeneratedImage(base64Image, workflowId, userId, mimeType)
          finalImageUrl = saveResult.url
          s3UploadFailed = saveResult.s3UploadFailed
          if (agentS3Configured && finalImageUrl) {
            logger.info('S3 URL returned', { url: finalImageUrl })
          }
          logger.info(`Successfully saved generated image to storage: ${finalImageUrl}`)
        } catch (error) {
          const err = toError(error)
          logger.error('Error saving generated image to storage:', {
            error: err.message,
            workflowId,
            userId,
            stack: err.stack,
          })
          throw new Error(`Failed to save generated image: ${err.message}`)
        }
      } else if (imageUrl && !base64Image) {
        const agentS3Configured =
          !!S3_AGENT_GENERATED_IMAGES_CONFIG.bucket && !!S3_AGENT_GENERATED_IMAGES_CONFIG.region
        if (agentS3Configured) {
          throw new Error(
            'Could not download image from OpenAI temporary URL; S3 storage requires the image to be downloaded first.'
          )
        }
        logger.warn('Could not download image for storage, will return original URL', {
          imageUrl: imageUrl.substring(0, 100),
        })
      }

      // Use stored URL if available, otherwise fall back to original imageUrl
      // Always ensure we return a URL in the image field
      // Use originalImageUrl which was preserved before any processing
      const imageUrlToReturn = finalImageUrl || originalImageUrl || ''

      logger.info('Image generation result:', {
        hasFinalImageUrl: !!finalImageUrl,
        hasImageUrl: !!imageUrl,
        hasOriginalImageUrl: !!originalImageUrl,
        hasBase64Image: !!base64Image,
        originalImageUrl: originalImageUrl ? originalImageUrl.substring(0, 100) : null,
        imageUrlToReturn: imageUrlToReturn ? imageUrlToReturn.substring(0, 100) : '',
        stored: !!finalImageUrl,
      })

      // Ensure we always return a URL - use originalImageUrl as final fallback
      // If download failed but we have originalImageUrl, use it
      const finalContent = imageUrlToReturn || originalImageUrl || 'direct-image'
      // Always ensure image field has a value - prefer stored URL, then original URL
      const finalImage = finalImageUrl || originalImageUrl || ''

      // Log if we're falling back to original URL
      if (!finalImageUrl && originalImageUrl) {
        logger.warn('Using original DALL-E URL as fallback (download/storage failed)', {
          originalImageUrl: originalImageUrl.substring(0, 100),
        })
      }

      return {
        success: true,
        output: {
          content: finalContent,
          image: finalImage,
          images: finalImage ? [finalImage] : [],
          metadata: {
            model: modelName,
            provider: 'openai',
            size: resolvedSize,
            quality: resolvedQuality,
            stored: !!finalImageUrl,
            s3UploadFailed,
          },
          ...(imageBilling ? { __imageBilling: imageBilling } : {}),
          s3UploadFailed,
        },
      }
    } catch (error) {
      logger.error('Error in image generation response handling:', error)
      throw error
    }
  },

  outputs: {
    content: { type: 'string', description: 'Image URL or identifier' },
    image: {
      type: 'file',
      description: 'Generated image (URL in S3/local storage or base64)',
    },
    images: {
      type: 'array',
      description: 'Generated images (URLs in S3/local storage or base64)',
      items: { type: 'file', description: 'Generated image' },
    },
    metadata: {
      type: 'json',
      description: 'Generation metadata (model, stored, etc.)',
    },
  },
}
