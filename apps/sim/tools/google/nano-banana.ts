import { createLogger } from '@sim/logger'
import { IMAGE_GENERATION_PROVIDER_TIMEOUT_MS } from '@/lib/image-generation/constants'
import { stripInlinePayloadFromFileReference } from '@/lib/image-generation/nano-banana-inputs'
import { calculateHostedImageToolCost } from '@/lib/tools/image-pricing'
import type { ToolConfig, ToolResponse } from '@/tools/types'

const logger = createLogger('NanoBananaTool')

interface NanoBananaParams {
  model?: string
  prompt?: string
  aspectRatio?: string
  imageSize?: string
  apiKey?: string
  inputImage?: unknown
  inputImageMimeType?: string
  inputImages?: unknown[]
  _context?: {
    workflowId?: string
    sessionUserId?: string
    userId?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolResponse(value: unknown): value is ToolResponse {
  return isRecord(value) && typeof value.success === 'boolean' && isRecord(value.output)
}

const nanoBananaTool: ToolConfig<NanoBananaParams> = {
  id: 'google_nano_banana',
  name: 'Google Nano Banana',
  description: "Generate images using Google's Gemini Native Image (Nano Banana) model",
  version: '1.0.0',

  params: {
    model: {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description: 'The Nano Banana model to use (gemini-2.5-flash-image)',
    },
    prompt: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'A text description of the desired image',
    },
    aspectRatio: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'The aspect ratio of the generated image (1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9)',
    },
    inputImage: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Reference image URL or file reference for editing. Do not pass inline base64 image data; use an uploaded file reference or URL instead.',
    },
    inputImageMimeType: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'MIME type of the input image (image/png, image/jpeg, etc.)',
    },
    inputImages: {
      type: 'array',
      items: { type: 'string' },
      required: false,
      visibility: 'user-or-llm',
      description:
        'Multiple reference images for fusion. Supported on Gemini image models (up to 14 on Nano Banana 2, 11 on Pro, 3 on Nano Banana). Use image URLs or uploaded file reference objects; do not pass inline base64 image data. When provided, used instead of inputImage.',
    },
    inputImageUrls: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Image URLs (one per line or comma-separated). Merged with inputImages and any URLs in the prompt for fusion / reference images.',
    },
  },

  hosting: {
    envKeyPrefix: 'GOOGLE_API_KEY',
    apiKeyParam: 'apiKey',
    byokProviderId: 'google',
    pricing: {
      type: 'custom',
      getCost: (params, output) => {
        const priced = calculateHostedImageToolCost(
          params as unknown as Record<string, unknown>,
          output
        )
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
    url: () => {
      logger.info('Routing Nano Banana tool request through internal API')
      return '/api/google'
    },
    method: 'POST',
    timeout: IMAGE_GENERATION_PROVIDER_TIMEOUT_MS,
    headers: () => {
      return {
        'Content-Type': 'application/json',
      }
    },
    body: (params) => {
      const body: Record<string, unknown> = {
        model: params.model,
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        imageSize: params.imageSize,
        ...(params.apiKey ? { apiKey: params.apiKey } : {}),
      }
      if (Array.isArray(params.inputImages) && params.inputImages.length > 0) {
        body.inputImages = params.inputImages.map(stripInlinePayloadFromFileReference)
      } else {
        body.inputImage = stripInlinePayloadFromFileReference(params.inputImage)
        body.inputImageMimeType = params.inputImageMimeType
      }
      return body
    },
  },

  transformResponse: async (response) => {
    try {
      if (!response.ok) {
        const errorText = await response.text()
        logger.error('Nano Banana API error response:', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        })
        throw new Error(
          `Nano Banana API error: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const data = await response.json()
      if (!isToolResponse(data)) {
        logger.error('Unexpected Nano Banana API response shape', {
          responseKeys: isRecord(data) ? Object.keys(data) : [],
        })
        throw new Error('Unexpected Nano Banana API response shape')
      }

      return data
    } catch (error) {
      logger.error('Error in Nano Banana response handling:', error)
      throw error
    }
  },

  outputs: {
    success: { type: 'boolean', description: 'Operation success status' },
    content: { type: 'string', description: 'Image identifier' },
    image: { type: 'string', description: 'Base64 encoded image data' },
    images: {
      type: 'array',
      description: 'Generated images (URLs in S3/local storage or base64)',
      items: { type: 'file', description: 'Generated image' },
    },
    metadata: {
      type: 'object',
      description: 'Image generation metadata',
      properties: {
        model: { type: 'string', description: 'Model used for image generation' },
        mimeType: { type: 'string', description: 'Image MIME type' },
        aspectRatio: { type: 'string', description: 'Image aspect ratio' },
        imageSize: {
          type: 'string',
          description: 'Output resolution (1K/2K/4K) when using Nano Banana Pro',
        },
        hasInputImage: {
          type: 'boolean',
          description: 'Whether an input image was provided for editing',
        },
        hasInputImages: {
          type: 'boolean',
          description: 'Whether multiple images were provided for fusion',
        },
        inputImageCount: {
          type: 'number',
          description: 'Number of input images used for fusion (when hasInputImages is true)',
        },
        inputImageMimeType: {
          type: 'string',
          description: 'MIME type of the input image (if provided)',
        },
      },
    },
    output: {
      type: 'object',
      description: 'Generated image data',
      properties: {
        content: { type: 'string', description: 'Image identifier' },
        image: { type: 'string', description: 'Base64 encoded image data' },
        images: {
          type: 'array',
          description: 'Generated images (URLs in S3/local storage or base64)',
          items: { type: 'file', description: 'Generated image' },
        },
        metadata: {
          type: 'object',
          description: 'Image generation metadata',
          properties: {
            model: { type: 'string', description: 'Model used for image generation' },
            mimeType: { type: 'string', description: 'Image MIME type' },
            aspectRatio: { type: 'string', description: 'Image aspect ratio' },
            imageSize: {
              type: 'string',
              description: 'Output resolution (1K/2K/4K) when using Nano Banana Pro',
            },
            hasInputImage: {
              type: 'boolean',
              description: 'Whether an input image was provided for editing',
            },
            hasInputImages: {
              type: 'boolean',
              description: 'Whether multiple images were provided for fusion',
            },
            inputImageCount: {
              type: 'number',
              description: 'Number of input images used for fusion (when hasInputImages is true)',
            },
            inputImageMimeType: {
              type: 'string',
              description: 'MIME type of the input image (if provided)',
            },
          },
        },
      },
    },
  },
}

export { nanoBananaTool }
