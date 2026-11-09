import type { ArenaSaveSummaryParams, ArenaSaveSummaryResponse } from '@/tools/arena/types'
import type { ToolConfig } from '@/tools/types'

export const saveSummary: ToolConfig<ArenaSaveSummaryParams, ArenaSaveSummaryResponse> = {
  id: 'arena_save_summary',
  name: 'Arena Save Summary',
  description: 'Save a summary for a client in Arena.',
  version: '1.0.0',

  params: {
    'save-summary-client': {
      type: 'object',
      required: true,
      visibility: 'user-or-llm',
      description: 'Client associated with the summary',
    },
    'save-summary-text': {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Summary text to save',
    },
  },

  request: {
    url: () => `/api/tools/arena/save-summary`,
    method: 'POST',
    headers: () => {
      return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }
    },
    body: (params: ArenaSaveSummaryParams) => {
      // ✅ Validation checks
      if (!params._context?.workflowId) throw new Error('Missing required field: workflowId')

      const clientValue = params['save-summary-client']
      const clientId = typeof clientValue === 'string' ? clientValue : clientValue?.clientId
      if (!clientId) throw new Error('Missing required field: Client')

      if (!params['save-summary-text']) throw new Error('Missing required field: Summary')

      const body: Record<string, any> = {
        workflowId: params._context.workflowId,
        clientId: clientId,
        summary: params['save-summary-text'],
      }

      return body
    },
  },

  transformResponse: async (response: Response): Promise<ArenaSaveSummaryResponse> => {
    const data = await response.json()
    return {
      success: true,
      output: {
        success: true,
        output: data,
      },
    }
  },

  outputs: {
    success: { type: 'boolean', description: 'Indicates if transform was successful' },
    output: { type: 'object', description: 'Output from Arena' },
  },
}
