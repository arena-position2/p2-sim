import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import {
  figmaGenerateDesignContract,
  figmaGenerateDesignDocsContract,
} from '@/lib/api/contracts/figma'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { generateFigmaDesign } from '@/lib/figma-design-generator'

const logger = createLogger('FigmaGenerateDesignJsonAPI')

export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes for design generation

/**
 * POST /api/figma/generate-design-json
 *
 * Generate a Figma design using AI and automation (JSON API for internal tool calls)
 *
 * Request body (application/json):
 * - projectId: string (required)
 * - fileName: string (required)
 * - prompt: string (required)
 * - brandGuidelinesFile: string (optional) - file path
 * - wireframesFile: string (optional) - file path
 * - additionalDataFile: string (optional) - file path
 * - additionalInfo: string (optional)
 */
export async function POST(request: NextRequest) {
  try {
    const parsed = await parseRequest(figmaGenerateDesignContract, request, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json(
          { success: false, error: getValidationErrorMessage(error) },
          { status: 400 }
        ),
    })
    if (!parsed.success) return parsed.response
    const {
      projectId,
      fileName,
      prompt,
      brandGuidelinesFile,
      wireframesFile,
      additionalDataFile,
      additionalInfo,
      description,
    } = parsed.data.body
    const designTargetsInput = parsed.data.body.designTargets
    const designTargets = Array.isArray(designTargetsInput)
      ? (designTargetsInput as string[])
      : typeof designTargetsInput === 'string' && designTargetsInput.length > 0
        ? designTargetsInput
            .split(',')
            .map((target) => target.trim())
            .filter(Boolean)
        : undefined
    // Generate the design
    const result = await generateFigmaDesign({
      projectId,
      fileName,
      prompt,
      brandGuidelinesFile,
      wireframesFile,
      additionalDataFile,
      additionalInfo,
      description,
      designTargets,
    })

    return NextResponse.json(result)
  } catch (error) {
    logger.error('Error in generate-design-json API', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/figma/generate-design-json
 *
 * Get API documentation
 */
export async function GET(request: NextRequest) {
  const parsed = await parseRequest(figmaGenerateDesignDocsContract, request, {})
  if (!parsed.success) return parsed.response
  return NextResponse.json({
    endpoint: '/api/figma/generate-design-json',
    method: 'POST',
    description: 'Generate a Figma design using AI and automation (JSON API)',
    contentType: 'application/json',
    requiredFields: {
      projectId: 'string - Figma project ID',
      fileName: 'string - Name for the new Figma file',
      prompt: 'string - Design prompt for AI generation',
    },
    optionalFields: {
      brandGuidelinesFile: 'string - Path to brand guidelines file',
      wireframesFile: 'string - Path to wireframes file',
      additionalDataFile: 'string - Path to additional data file',
      additionalInfo: 'string - Additional information as text',
      designTargets:
        'array|string - Device or layout targets (desktop, mobile, tablet, etc.) to generate simultaneously',
    },
    response: {
      success: 'boolean',
      renderedData: 'string - Generated HTML/CSS (if successful)',
      figmaFileUrl: 'string - URL to the created Figma file (if successful)',
      error: 'string - Error message (if failed)',
    },
  })
}
