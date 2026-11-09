import { type NextRequest, NextResponse } from 'next/server'
import { presentationCreateContract } from '@/lib/api/contracts/presentation-create'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { env } from '@/lib/core/config/env'

const PRESENTATION_API_BASE_URL = env.PRESENTATION_API_BASE_URL
export async function POST(req: NextRequest) {
  try {
    const parsed = await parseRequest(presentationCreateContract, req, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json({ error: getValidationErrorMessage(error) }, { status: 400 }),
    })
    if (!parsed.success) return parsed.response
    const { numberOfSlides, tone, verbosity, template, content, slides_markdown, instructions } =
      parsed.data.body

    if (!numberOfSlides && !slides_markdown) {
      return NextResponse.json(
        { error: 'Missing required field: numberOfSlides (or provide slides_markdown)' },
        { status: 400 }
      )
    }

    // Step 1: Generate presentation
    const generatePayload: Record<string, any> = {
      content: content || '',
      n_slides: slides_markdown
        ? slides_markdown.length
        : typeof numberOfSlides === 'string'
          ? Number.parseInt(numberOfSlides, 10)
          : numberOfSlides,
      language: 'English',
      template: template || 'position2-test',
      tone: tone,
      verbosity: verbosity,
      include_title_slide: true,
      include_table_of_contents: true,
      web_search: true,
      export_as: 'pptx',
      instructions: instructions || '',
      trigger_webhook: false,
    }

    // Add slides_markdown if provided
    if (slides_markdown) {
      generatePayload.slides_markdown = slides_markdown
    }

    const generateResponse = await fetch(
      `${PRESENTATION_API_BASE_URL}/p2-presenton/api/v1/ppt/presentation/generate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(generatePayload),
      }
    )

    if (!generateResponse.ok) {
      const errorText = await generateResponse.text()
      let errorData
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = errorText
      }
      return NextResponse.json(errorData, { status: generateResponse.status })
    }

    const generateData = await generateResponse.json()
    const { presentation_id, path: filePath } = generateData

    if (!presentation_id || !filePath) {
      return NextResponse.json(
        {
          error: 'Invalid response from presentation API',
          details: 'Missing presentation_id or path',
        },
        { status: 500 }
      )
    }

    // Step 2: Download the PPTX file if download is requested
    const downloadResponse = await fetch(
      `${PRESENTATION_API_BASE_URL}/p2-presenton/api/v1/ppt/presentation/download-pptx`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file_path: filePath,
        }),
      }
    )

    if (!downloadResponse.ok) {
      const errorText = await downloadResponse.text()
      let errorData
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = errorText
      }
      return NextResponse.json(errorData, { status: downloadResponse.status })
    }

    // Convert the file to base64
    const fileBuffer = await downloadResponse.arrayBuffer()
    const base64File = Buffer.from(fileBuffer).toString('base64')
    const presentationFile = {
      data: base64File,
      filename: filePath.split('/').pop() || 'presentation.pptx',
      mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }

    const responseData = {
      presentationFile: presentationFile,
      presentationId: presentation_id,
      message: `Presentation created successfully with ${numberOfSlides} slides, tone: ${tone}, verbosity: ${verbosity}`,
    }

    return NextResponse.json(responseData, { status: 200 })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to create presentation',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
