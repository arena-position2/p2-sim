import { getTemplateMasterSchema } from '@/tools/google_slides/templates'
import type { ToolConfig } from '@/tools/types'

interface GetTemplateSchemaParams {
  template?: string
}

interface GetTemplateSchemaResponse {
  success: boolean
  output: {
    schema: Record<string, unknown>
  }
}

export const getTemplateSchemaTool: ToolConfig<GetTemplateSchemaParams, GetTemplateSchemaResponse> =
  {
    id: 'p2_docs_get_template_schema',
    name: 'Get Template Schema',
    description: 'Return the JSON schema for a presentation template (e.g. position2_2026)',
    version: '1.0',

    params: {
      template: {
        type: 'string',
        required: false,
        visibility: 'user-or-llm',
        description: 'Template id (e.g. position2_2026). Defaults to position2_2026 when omitted.',
      },
    },

    request: {
      url: '/api/tools/p2_docs/get_template_schema',
      method: 'GET',
      headers: () => ({}),
    },

    outputs: {
      schema: {
        type: 'json',
        description: 'Full presentation template schema (slides, blocks, shapeIds, etc.)',
      },
    },
  }

export async function executeGetTemplateSchemaDirect(
  params: GetTemplateSchemaParams
): Promise<GetTemplateSchemaResponse> {
  const templateId = params.template?.trim() || 'position2_2026'
  const schema = getTemplateMasterSchema(templateId)
  return {
    success: true,
    output: {
      schema: schema as unknown as Record<string, unknown>,
    },
  }
}
