import { type NextRequest, NextResponse } from 'next/server'
import { googleImageContract, googleImageDocsContract } from '@/lib/api/contracts/ads'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { generateNanoBananaImage } from '@/app/api/google/api-service'

export const runtime = 'nodejs'

/** Allow up to 10 minutes for image generation (same as image-generator; 4K/fusion can be slow). */
export const maxDuration = 1200

/** Outgoing request timeout is enforced in generateNanoBananaImage (see api-service). */

/**
 * POST /api/google
 *
 * Generate an image using Google's Gemini (Nano Banana) model.
 *
 * Request body (application/json):
 * - model: string (required) - Gemini image model (gemini-2.5-flash-image or gemini-3-pro-image-preview)
 * - prompt: string (required) - Text description for the image
 * - aspectRatio: string (optional) - e.g., 1:1, 16:9
 * - imageSize: string (optional) - For Pro only: 1K, 2K, 4K
 * - inputImage: string | { path: string; type?: string } (optional) - base64 image or file reference
 * - inputImageMimeType: string (optional) - MIME type for the input image
 * - inputImages: array (optional) - multiple images for fusion (Nano Banana Pro)
 */
export const POST = withRouteHandler(async (request: NextRequest) => {
  const parsed = await parseRequest(
    googleImageContract,
    request,
    {},
    {
      validationErrorResponse: (error) =>
        validationErrorResponse(error, getValidationErrorMessage(error)),
    }
  )
  if (!parsed.success) return parsed.response
  const body = parsed.data.body
  const { workflowId, userId } = parsed.data.query

  const { toolResponse, httpStatus } = await generateNanoBananaImage({
    model: body.model,
    prompt: body.prompt,
    aspectRatio: body.aspectRatio,
    imageSize: body.imageSize,
    apiKey: body.apiKey,
    inputImage: body.inputImage,
    inputImageMimeType: body.inputImageMimeType,
    inputImages: body.inputImages,
    _context: {
      workflowId,
      userId,
    },
  })

  return NextResponse.json(toolResponse, { status: httpStatus })
})

/**
 * GET /api/google
 *
 * API documentation for Nano Banana image generation.
 */
export const GET = withRouteHandler(async (request: NextRequest) => {
  const parsed = await parseRequest(
    googleImageDocsContract,
    request,
    {},
    {
      validationErrorResponse: (error) =>
        validationErrorResponse(error, getValidationErrorMessage(error)),
    }
  )
  if (!parsed.success) return parsed.response

  return NextResponse.json({
    endpoint: '/api/google',
    method: 'POST',
    description: 'Generate an image using Google Gemini (Nano Banana)',
    contentType: 'application/json',
    requiredFields: {
      model: 'string - Gemini image model (gemini-2.5-flash-image or gemini-3-pro-image-preview)',
      prompt: 'string - Text description for the image',
    },
    optionalFields: {
      aspectRatio: 'string - Aspect ratio (1:1, 16:9, etc.)',
      imageSize: 'string - For Pro only: 1K, 2K, 4K',
      inputImage: 'string | { path: string; type?: string } - Base64 image or file reference',
      inputImageMimeType: 'string - MIME type of the input image',
      inputImages:
        'array - Multiple images for fusion (Nano Banana Pro); each item: base64 string or { path, type? }',
    },
    response: {
      success: 'boolean',
      output: 'object - Generated image output with image URL, images array, and metadata',
      error: 'string - Error message when unsuccessful',
    },
  })
})
