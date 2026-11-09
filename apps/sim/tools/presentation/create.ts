import type {
  PresentationCreateParams,
  PresentationCreateResponse,
} from '@/tools/presentation/types'
import type { ToolConfig } from '@/tools/types'

export const createTool: ToolConfig<PresentationCreateParams, PresentationCreateResponse> = {
  id: 'presentation_create',
  name: 'Create Presentation',
  description: 'Create a presentation with specified number of slides, tone, and verbosity',
  version: '1.0.0',

  params: {
    operation: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Operation to perform (e.g., create)',
    },
    numberOfSlides: {
      type: 'number',
      required: true,
      visibility: 'user-or-llm',
      description: 'Number of slides to create',
    },
    tone: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Tone of the presentation (e.g., professional)',
    },
    verbosity: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Verbosity level of the presentation (e.g., standard)',
    },
    template: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Presentation template (e.g., Position2)',
    },
    content: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Presentation content',
    },
    slides_markdown: {
      type: 'array',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Array of markdown strings for each slide. Bypasses outline generation and uses your markdown directly. Auto-sets slide count to array length.',
    },
    instructions: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Custom guidance for AI generation. Influences outline generation, layout selection, and slide content. Examples: "Focus on ROI", "Use bullet points", "Keep slides concise"',
    },
  },

  request: {
    url: () => {
      return '/api/tools/presentation/create'
    },
    method: 'POST',
    headers: () => {
      return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }
    },
    body: (params: PresentationCreateParams) => {
      // Validate slides_markdown if provided
      if (params.slides_markdown) {
        // Parse if it's a string
        let slidesArray = params.slides_markdown
        if (typeof params.slides_markdown === 'string') {
          try {
            slidesArray = JSON.parse(params.slides_markdown)
          } catch {
            throw new Error(
              'slides_markdown must be a valid JSON array. Example: ["slide 1", "slide 2"]'
            )
          }
        }

        // Validate it's an array
        if (!Array.isArray(slidesArray)) {
          throw new Error('slides_markdown must be an array of strings')
        }

        // Validate all elements are strings
        if (!slidesArray.every((item) => typeof item === 'string')) {
          throw new Error('All slides in slides_markdown must be strings')
        }

        // Use the validated array and auto-set numberOfSlides
        return {
          operation: params.operation,
          numberOfSlides: slidesArray.length, // Auto-set to array length
          tone: params.tone,
          verbosity: params.verbosity,
          template: params.template,
          content: params.content,
          slides_markdown: slidesArray,
          instructions: params.instructions,
        }
      }

      return {
        operation: params.operation,
        numberOfSlides: params.numberOfSlides,
        tone: params.tone,
        verbosity: params.verbosity,
        template: params.template,
        content: params.content,
        instructions: params.instructions,
      }
    },
  },

  transformResponse: async (response: Response): Promise<PresentationCreateResponse> => {
    const data = await response.json()

    // Ensure proper file format when present; emit standard file shape
    let presentationFile = data.presentationFile
    if (presentationFile?.data) {
      const base64Url = presentationFile.data as string
      const filename = presentationFile.filename || 'presentation.pptx'
      const mimeType =
        presentationFile.mimetype ||
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'

      // Best-effort size estimate from base64/base64url length (without decoding)
      const unpaddedLen = base64Url.replace(/=+$/, '').length
      const estimatedSize = Math.floor((unpaddedLen * 3) / 4)

      presentationFile = {
        data: base64Url, // base64 string - matches ToolFileData interface
        mimeType: mimeType, // matches ToolFileData interface
        size: estimatedSize,
        name: filename,
      }
    }

    return {
      success: true,
      output: {
        presentationFile: presentationFile,
        presentationId: data.presentationId,
        message: data.message,
      },
    }
  },

  outputs: {
    presentationFile: { type: 'file', description: 'Presentation file' },
    presentationId: { type: 'string', description: 'Presentation ID' },
    message: { type: 'string', description: 'Status message' },
  },
}
