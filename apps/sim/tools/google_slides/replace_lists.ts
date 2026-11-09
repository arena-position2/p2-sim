import { createLogger } from '@sim/logger'
import type { ToolConfig } from '@/tools/types'

const logger = createLogger('GoogleSlidesReplaceListsTool')

interface ReplaceListsParams {
  accessToken: string
  presentationId: string
  objectId: string
  listItems: string[]
}

interface ReplaceListsResponse {
  success: boolean
  output: {
    replaced: boolean
    objectId: string
    listItems: string[]
    metadata: {
      presentationId: string
      url: string
    }
  }
}

export const replaceListsTool: ToolConfig<ReplaceListsParams, ReplaceListsResponse> = {
  id: 'google_slides_replace_lists',
  name: 'Replace Lists in Google Slides',
  description:
    'Replace all list content in a shape in a Google Slides presentation. This preserves bullet/numbering style and formatting.',
  version: '1.0.0',

  oauth: {
    required: true,
    provider: 'google-drive',
  },

  params: {
    accessToken: {
      type: 'string',
      required: true,
      visibility: 'hidden',
      description: 'The access token for the Google Slides API',
    },
    presentationId: {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description: 'The ID of the presentation',
    },
    objectId: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description:
        'The object ID of the shape containing the list to replace. The shape must have list formatting.',
    },
    listItems: {
      type: 'array',
      required: true,
      visibility: 'user-or-llm',
      description: 'Array of strings representing the list items to insert',
    },
  },

  request: {
    url: (params) => {
      const presentationId = params.presentationId?.trim()
      if (!presentationId) {
        throw new Error('Presentation ID is required')
      }
      // First, read the presentation to get the shape's text length
      return `https://slides.googleapis.com/v1/presentations/${presentationId}`
    },
    method: 'GET',
    headers: (params) => {
      if (!params.accessToken) {
        throw new Error('Access token is required')
      }
      return {
        Authorization: `Bearer ${params.accessToken}`,
      }
    },
  },

  postProcess: async (result, params, _executeTool) => {
    if (!result.success) {
      return result
    }

    const presentationId = params?.presentationId?.trim()
    const objectId = params?.objectId?.trim()
    const listItems = params?.listItems || []

    if (!presentationId || !objectId) {
      throw new Error('Presentation ID and Object ID are required')
    }

    if (!Array.isArray(listItems) || listItems.length === 0) {
      throw new Error('List items must be a non-empty array')
    }

    try {
      // Get the presentation data from the read response
      const presentationData = result.output as any
      const slides = presentationData.slides || []

      // Find the shape with the matching objectId
      let textEndIndex = 0
      let shapeFound = false

      for (const slide of slides) {
        const pageElements = slide.pageElements || []
        for (const element of pageElements) {
          if (element.objectId === objectId) {
            shapeFound = true
            // Get the text length from the shape's text elements
            if (element.shape?.text?.textElements) {
              const textElements = element.shape.text.textElements
              // Find the last text element with an endIndex
              for (const textElement of textElements) {
                if (textElement.endIndex !== undefined && textElement.endIndex > textEndIndex) {
                  textEndIndex = textElement.endIndex
                }
              }
            }
            break
          }
        }
        if (shapeFound) break
      }

      if (!shapeFound) {
        throw new Error(`Shape with objectId ${objectId} not found in presentation`)
      }

      if (textEndIndex === 0) {
        // If no text found, we'll delete from 0 to 0 (which is safe)
        textEndIndex = 1
      }

      // Build the list text string - each item followed by newline
      const listText = listItems.map((item) => `${item}\n`).join('')

      // Make the batchUpdate call to delete and insert
      const batchUpdateResponse = await fetch(
        `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requests: [
              {
                deleteText: {
                  objectId,
                  textRange: {
                    type: 'FIXED_RANGE',
                    startIndex: 0,
                    endIndex: textEndIndex - 1,
                  },
                },
              },
              {
                insertText: {
                  objectId,
                  insertionIndex: 0,
                  text: listText,
                },
              },
            ],
          }),
        }
      )

      const batchUpdateData = await batchUpdateResponse.json()

      if (!batchUpdateResponse.ok) {
        logger.error('Google Slides batchUpdate error:', { data: batchUpdateData })
        throw new Error(batchUpdateData.error?.message || 'Failed to replace list content')
      }

      return {
        success: true,
        output: {
          replaced: true,
          objectId,
          listItems,
          metadata: {
            presentationId,
            url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
          },
        },
      }
    } catch (error) {
      logger.error('Google Slides replace lists - Error processing:', { error })
      throw error
    }
  },

  transformResponse: async (response: Response) => {
    const data = await response.json()

    if (!response.ok) {
      logger.error('Google Slides API error:', { data })
      throw new Error(data.error?.message || 'Failed to read presentation')
    }

    // Return the presentation data for postProcess to use
    return {
      success: true,
      output: data,
    }
  },

  outputs: {
    replaced: {
      type: 'boolean',
      description: 'Whether the list content was successfully replaced',
    },
    objectId: {
      type: 'string',
      description: 'The object ID where list content was replaced',
    },
    listItems: {
      type: 'json',
      description: 'The list items that were inserted',
    },
    metadata: {
      type: 'object',
      description: 'Operation metadata including presentation ID and URL',
      properties: {
        presentationId: { type: 'string', description: 'The presentation ID' },
        url: { type: 'string', description: 'URL to the presentation' },
      },
    },
  },
}
