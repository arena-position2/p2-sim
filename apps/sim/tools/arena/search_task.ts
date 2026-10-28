import {
  getCurrentMonth,
  getCurrentWeek,
  getFutureDate,
  getLastMonth,
  getLastWeek,
  getNextMonth,
  getNextWeek,
  getPastDate,
  getToday,
  getTomorrow,
  getYesterday,
} from '@/lib/arena-utils/arena-date-utils'
import type { SearchTaskQueryParams, SearchTaskResponse } from '@/tools/arena/types'
import type { ToolConfig } from '@/tools/types'

export const searchTask: ToolConfig<SearchTaskQueryParams, SearchTaskResponse> = {
  id: 'arena_search_task',
  name: 'Arena Search Task',
  description:
    'Search Arena tasks using client, project, state, visibility, due date, assignee, and page size. For search by task name or number only, use the Search Task (name only) operation.',
  version: '1.0.0',

  params: {
    'search-task-client': {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Client associated with the task',
    },
    'search-task-project': {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Project under which the task belongs',
    },
    'search-task-assignee': {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'User ID of the assignee',
    },
    'search-task-visibility': {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Task visibility (Internal / Client Facing)',
    },
    'search-task-state': {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'State of the task',
    },
    'search-task-due-date': {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Due date of the task',
    },
    'search-task-max-results': {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Max number of search results (page size)',
    },
  },

  request: {
    url: (params: SearchTaskQueryParams) => {
      const base = `/api/tools/arena/search-tasks`
      const q: string[] = []
      const add = (key: string, value: string | number) => {
        q.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      }

      const clientName = params['search-task-client']?.name?.trim()
      if (clientName) {
        add('account', clientName)
      }

      if (params['search-task-project']) {
        const projectId =
          typeof params['search-task-project'] === 'string'
            ? params['search-task-project']
            : params['search-task-project']?.sysId
        if (projectId) {
          add('projectSysId', projectId)
        }
      }
      if (params['search-task-state']?.length) {
        add('statusList', params['search-task-state'].join(','))
      }
      if (params['search-task-visibility'] === 'Internal') {
        add('taskType', 'INTERNAL')
      }
      if (params['search-task-visibility'] === 'Client Facing') {
        add('taskType', 'CLIENT-FACING')
      }
      if (params['search-task-assignee']) {
        const assigneeId =
          typeof params['search-task-assignee'] === 'string'
            ? params['search-task-assignee']
            : params['search-task-assignee']?.value
        if (assigneeId) {
          add('assigneeId', assigneeId)
        }
      }
      if (params._context?.workflowId) {
        add('workflowId', params._context.workflowId)
      }

      const due = params['search-task-due-date']
      if (due === 'Today') {
        const { startDate, endDate } = getToday()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'Yesterday') {
        const { startDate, endDate } = getYesterday()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'Tomorrow') {
        const { startDate, endDate } = getTomorrow()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'This Week') {
        const { startDate, endDate } = getCurrentWeek()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'Next Week') {
        const { startDate, endDate } = getNextWeek()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'Last Week') {
        const { startDate, endDate } = getLastWeek()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'This Month') {
        const { startDate, endDate } = getCurrentMonth()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'Next Month') {
        const { startDate, endDate } = getNextMonth()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'Last Month') {
        const { startDate, endDate } = getLastMonth()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'Past Dates') {
        const { startDate, endDate } = getPastDate()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      if (due === 'Future Dates') {
        const { startDate, endDate } = getFutureDate()
        add('fromDate', startDate)
        add('toDate', endDate)
      }
      const maxResults = params['search-task-max-results']
      if (maxResults !== undefined && String(maxResults) !== '') {
        const pageSize = Number(maxResults)
        if (Number.isInteger(pageSize)) {
          add('pageSize', pageSize)
        }
      }

      return q.length > 0 ? `${base}?${q.join('&')}` : base
    },
    method: 'GET',
    headers: (_params: SearchTaskQueryParams) => {
      return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }
    },
  },

  transformResponse: async (response: Response): Promise<SearchTaskResponse> => {
    const data = await response.json()
    return {
      success: true,
      output: {
        success: true,
        output: data,
      },
    }
  },

  //this output config will override block output config
  outputs: {
    // ts: { type: 'string', description: 'Timestamp when response was transformed' },
    // response: { type: 'object', description: 'Response from Arena' },
    // success: { type: 'boolean', description: 'Indicates if transform was successful' },
    success: { type: 'boolean', description: 'Indicates if transform was successful' },
    output: { type: 'object', description: 'Output from Arena' },
  },
}
