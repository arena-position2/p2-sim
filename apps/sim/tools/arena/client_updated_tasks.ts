import type {
  ArenaClientUpdatedTasksParams,
  ArenaClientUpdatedTasksResponse,
} from '@/tools/arena/types'
import type { ToolConfig } from '@/tools/types'

export const clientUpdatedTasks: ToolConfig<
  ArenaClientUpdatedTasksParams,
  ArenaClientUpdatedTasksResponse
> = {
  id: 'arena_client_updated_tasks',
  name: 'Arena Client Updated Tasks',
  description: 'Get updated tasks for a client in Arena.',
  version: '1.0.0',

  params: {
    'client-updated-tasks-client': {
      type: 'object',
      required: false,
      visibility: 'user-or-llm',
      description: 'Client associated with the tasks (basic mode)',
    },
    'client-updated-tasks-client-id': {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Client ID for the tasks (advanced mode)',
    },
    'client-updated-tasks-period': {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Time period for tasks (7days, today, 14days)',
    },
    'client-updated-tasks-page-number': {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Page number for pagination',
    },
    'client-updated-tasks-page-size': {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Page size for pagination',
    },
  },

  request: {
    url: (params: ArenaClientUpdatedTasksParams) => {
      if (!params['client-updated-tasks-period']) {
        throw new Error('Missing required field: period')
      }

      const isAdvancedMode = !!params['client-updated-tasks-client-id']
      let clientId = ''
      if (isAdvancedMode) {
        clientId = params['client-updated-tasks-client-id']?.trim() || ''
      } else {
        const clientValue = params['client-updated-tasks-client']
        clientId = typeof clientValue === 'string' ? clientValue : clientValue?.clientId || ''
      }

      if (!clientId) throw new Error('Missing required field: clientId')

      const pageNumber = params['client-updated-tasks-page-number']
      const pageSize = params['client-updated-tasks-page-size']
      const resolvedPageNumber = pageNumber ? Number(pageNumber) : 1
      const resolvedPageSize = pageSize ? Number(pageSize) : 10

      if (!Number.isInteger(resolvedPageNumber) || resolvedPageNumber <= 0) {
        throw new Error('Invalid pageNumber')
      }

      if (!Number.isInteger(resolvedPageSize) || resolvedPageSize <= 0) {
        throw new Error('Invalid pageSize')
      }

      let url = `/api/tools/arena/client-updated-tasks`
      url += `?cid=${encodeURIComponent(clientId)}`
      url += `&period=${encodeURIComponent(params['client-updated-tasks-period'])}`
      url += `&pageNumber=${encodeURIComponent(String(resolvedPageNumber))}`
      url += `&pageSize=${encodeURIComponent(String(resolvedPageSize))}`

      return url
    },
    method: 'GET',
    headers: () => {
      return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }
    },
  },

  transformResponse: async (response: Response): Promise<ArenaClientUpdatedTasksResponse> => {
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
