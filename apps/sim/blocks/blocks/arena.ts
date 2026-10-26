import { ArenaIcon } from '@/components/icons'
import { type BlockConfig, IntegrationType } from '@/blocks/types'

export const ArenaBlock: BlockConfig = {
  type: 'arena',
  name: 'Arena',
  description: 'Arena',
  longDescription: 'Arena',
  docsLink: '',
  category: 'tools',
  integrationType: IntegrationType.Productivity,
  bgColor: '#E0E0E0',
  icon: ArenaIcon,
  subBlocks: [
    {
      id: 'operation',
      title: 'Operation',
      type: 'dropdown',
      required: true,
      options: [
        { label: 'Create Task', id: 'arena_create_task' },
        {
          label: 'Create Task (names & emails)',
          id: 'arena_create_task_fields',
        },
        {
          label: 'Create Sub Task',
          id: 'arena_create_sub_task',
        },
        {
          label: 'Create Sub Task (names & emails)',
          id: 'arena_create_sub_task_fields',
        },
        {
          label: 'Add Comments',
          id: 'arena_comments',
        },
        {
          label: 'Add Comments (Task number)',
          id: 'arena_comments_task_number',
        },
        {
          label: 'Fetch tasks (client, project, assignee, state name)',
          id: 'arena_fetch_searched_tasks',
        },
        {
          label: 'Search Task',
          id: 'arena_search_task',
        },
        {
          label: 'Search Task (name only)',
          id: 'arena_search_task_simple',
        },
        {
          label: 'Save Summary',
          id: 'arena_save_summary',
        },
        {
          label: 'Get Meetings',
          id: 'arena_get_meetings',
        },
        {
          label: 'Get Token',
          id: 'arena_get_token',
        },
        {
          label: 'Get My Tasks',
          id: 'arena_get_my_tasks',
        },
        {
          label: 'Get My Overdue Tasks',
          id: 'arena_get_my_overdue_tasks',
        },
      ],
      value: () => 'arena_create_task',
    },

    // create task + sub task — selector operations (Create Task, Create Sub Task)
    {
      id: 'task-name',
      title: 'Task Name',
      type: 'long-input',
      required: true,
      placeholder: 'Enter task name',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: [
          'arena_create_task',
          'arena_create_sub_task',
          'arena_create_task_fields',
          'arena_create_sub_task_fields',
        ],
      },
    },
    {
      id: 'task-description',
      title: 'Task Description',
      type: 'long-input',
      required: true,
      placeholder: 'Enter task description',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: [
          'arena_create_task',
          'arena_create_sub_task',
          'arena_create_task_fields',
          'arena_create_sub_task_fields',
        ],
      },
    },
    {
      id: 'task-client',
      title: 'Client',
      type: 'arena-client-selector',
      required: true,
      placeholder: 'Enter client name',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: ['arena_create_task', 'arena_create_sub_task'] },
    },
    {
      id: 'task-project',
      title: 'Project',
      type: 'arena-project-selector',
      required: true,
      placeholder: 'Enter project name',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_create_task', 'arena_create_sub_task'],
      },
    },
    {
      id: 'task-group',
      title: 'Group',
      type: 'arena-group-selector',
      required: true,
      placeholder: 'Enter group name',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: ['arena_create_task'] },
    },
    {
      id: 'task-task',
      title: 'Task',
      type: 'arena-task-selector',
      required: true,
      placeholder: 'Enter task name',
      condition: {
        field: 'operation',
        value: ['arena_create_sub_task'],
      },
    },
    {
      id: 'task-assignee',
      title: 'Assignee',
      type: 'arena-assignee-selector',
      required: true,
      placeholder: 'Enter assignee name',
      dependsOn: ['operation', 'task-client', 'task-project'],
      condition: {
        field: 'operation',
        value: ['arena_create_task', 'arena_create_sub_task'],
      },
    },
    // create task + sub task — by names & emails (separate operations; no block “advanced” toggle)
    {
      id: 'task-client-name',
      title: 'Client Name',
      type: 'short-input',
      required: true,
      placeholder: 'Enter client name or use <function.result.client_name>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_create_task_fields', 'arena_create_sub_task_fields'],
      },
    },
    {
      id: 'task-project-name',
      title: 'Project Name',
      type: 'short-input',
      required: true,
      placeholder: 'Enter project name or use <function.result.project_name>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_create_task_fields', 'arena_create_sub_task_fields'],
      },
    },
    {
      id: 'task-epic-name',
      title: 'Group Name',
      type: 'short-input',
      required: true,
      placeholder: 'Enter group name or use <function.result.group_name>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_create_task_fields'],
      },
    },
    {
      id: 'task-assignee-email',
      title: 'Assignee Email',
      type: 'short-input',
      required: true,
      placeholder: 'Enter assignee email or use <function.result.assignee_email>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_create_task_fields', 'arena_create_sub_task_fields'],
      },
    },
    {
      id: 'task-number',
      title: 'Task Number',
      type: 'short-input',
      required: true,
      placeholder: 'Enter task number or use <function.result.task_number>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_create_sub_task_fields'],
      },
    },

    // Fetch searched tasks — free-text client, project, assignee, state
    {
      id: 'fetch-searched-client-name',
      title: 'Client Name',
      type: 'short-input',
      required: false,
      placeholder: 'Enter client name or use <function.result.client_name>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_fetch_searched_tasks'],
      },
    },
    {
      id: 'fetch-searched-project-name',
      title: 'Project Name',
      type: 'short-input',
      required: false,
      placeholder: 'Enter project name or use <function.result.project_name>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_fetch_searched_tasks'],
      },
    },
    {
      id: 'fetch-searched-assignee-name',
      title: 'Assignee Name',
      type: 'short-input',
      required: false,
      placeholder: 'Enter assignee name or use <function.result.assignee_name>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_fetch_searched_tasks'],
      },
    },
    {
      id: 'fetch-searched-state',
      title: 'State',
      type: 'short-input',
      required: false,
      placeholder: 'Enter state name or use <function.result.state>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_fetch_searched_tasks'],
      },
    },

    // Search Task (name only) — task name/number only; full Search Task uses filters below (no name field)
    {
      id: 'search-task-name',
      title: 'Task Name or Task Number',
      type: 'long-input',
      required: false,
      placeholder: 'Enter task name or task number or use <function.result.task_name>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_search_task_simple'],
      },
    },
    {
      id: 'search-task-client',
      title: 'Client',
      type: 'arena-client-selector',
      required: false,
      placeholder: 'Select client...',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_search_task'],
      },
    },
    {
      id: 'search-task-project',
      title: 'Project',
      type: 'arena-project-selector',
      required: false,
      placeholder: 'Select project...',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_search_task'],
      },
    },
    {
      id: 'search-task-state',
      title: 'State',
      type: 'arena-states-selector',
      required: false,
      placeholder: 'Select states...',
      condition: {
        field: 'operation',
        value: ['arena_search_task'],
      },
    },
    {
      id: 'search-task-visibility',
      title: 'Task Visibility',
      type: 'combobox',
      required: false,
      placeholder: 'Enter visibility',
      dependsOn: ['operation'],
      options: [
        { label: 'Internal', id: 'Internal' },
        { label: 'Client Facing', id: 'Client Facing' },
      ],
      value: () => '',
      condition: {
        field: 'operation',
        value: ['arena_search_task'],
      },
    },
    {
      id: 'search-task-due-date',
      title: 'Due Date',
      type: 'combobox',
      required: false,
      placeholder: 'Enter due date',
      dependsOn: ['operation'],
      options: [
        { label: 'Yesterday', id: 'Yesterday' },
        { label: 'Today', id: 'Today' },
        { label: 'Tomorrow', id: 'Tomorrow' },
        { label: 'This Week', id: 'This Week' },
        { label: 'Next Week', id: 'Next Week' },
        { label: 'Last Week', id: 'Last Week' },
        { label: 'This Month', id: 'This Month' },
        { label: 'Next Month', id: 'Next Month' },
        { label: 'Last Month', id: 'Last Month' },
        // { label: 'Past Dates', id: 'past-dates' },
        // { label: 'Future Dates', id: 'future-dates' },
      ],
      value: () => '',
      condition: {
        field: 'operation',
        value: ['arena_search_task'],
      },
    },
    {
      id: 'search-task-assignee',
      title: 'Search Assignee',
      type: 'arena-assignee-selector',
      required: false,
      placeholder: 'Select assignee...',
      dependsOn: ['search-task-client'],
      condition: {
        field: 'operation',
        value: ['arena_search_task'],
      },
    },
    {
      id: 'search-task-max-results',
      title: 'Max Results',
      type: 'short-input',
      placeholder: '10',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: ['arena_search_task'] },
    },

    //save summary blocks
    {
      id: 'save-summary-client',
      title: 'Client',
      type: 'arena-client-selector',
      required: true,
      placeholder: 'Enter client name',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_save_summary'],
      },
    },
    {
      id: 'save-summary-text',
      title: 'Summary',
      type: 'long-input',
      required: true,
      placeholder: 'Enter summary',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_save_summary'],
      },
    },

    // Add Comments — client / project / group / task
    {
      id: 'comment-client',
      title: 'Client',
      type: 'arena-client-selector',
      required: true,
      placeholder: 'Select client...',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_comments'],
      },
    },
    {
      id: 'comment-project',
      title: 'Project',
      type: 'arena-project-selector',
      required: true,
      placeholder: 'Select project...',
      dependsOn: ['operation', 'comment-client'],
      condition: {
        field: 'operation',
        value: ['arena_comments'],
      },
    },
    {
      id: 'comment-group',
      title: 'Group',
      type: 'arena-group-selector',
      required: true,
      placeholder: 'Select group...',
      dependsOn: ['operation', 'comment-client', 'comment-project'],
      condition: {
        field: 'operation',
        value: ['arena_comments'],
      },
    },
    {
      id: 'comment-task',
      title: 'Task',
      type: 'arena-task-selector',
      required: true,
      placeholder: 'Select task...',
      dependsOn: ['operation', 'comment-project'],
      condition: {
        field: 'operation',
        value: ['arena_comments'],
      },
    },
    // Add Comments (Task number)
    {
      id: 'comment-task-number',
      title: 'Task Number',
      type: 'short-input',
      required: true,
      placeholder: 'Enter task number or use <function.result.task_number>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_comments_task_number'],
      },
    },
    {
      id: 'comment-to',
      title: 'To',
      type: 'short-input',
      required: false,
      placeholder: 'e.g. email@example.com or <function.result.to_emails>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_comments_task_number'],
      },
    },
    {
      id: 'comment-cc',
      title: 'CC',
      type: 'short-input',
      required: false,
      placeholder: 'e.g. email@example.com or <function.result.cc_emails>',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_comments_task_number'],
      },
    },
    {
      id: 'comment-client-note',
      title: 'Client Note',
      type: 'switch',
      required: false,
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_comments', 'arena_comments_task_number'],
      },
    },
    {
      id: 'comment-text',
      title: 'Comments',
      type: 'long-input',
      required: true,
      placeholder: 'Enter comments',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_comments', 'arena_comments_task_number'],
      },
    },

    // Get meetings — one operation; client vs client ID via basic/advanced (same pattern as Telegram photo / photo + canonical)
    {
      id: 'get-meetings-client',
      title: 'Client',
      type: 'arena-client-selector',
      required: true,
      placeholder: 'Select client...',
      mode: 'basic',
      canonicalParamId: 'get-meetings-client',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_get_meetings'],
      },
    },
    {
      id: 'get-meetings-client-id',
      title: 'Client ID',
      type: 'short-input',
      required: true,
      placeholder: 'Enter client ID or use <function.result.client_id>',
      mode: 'advanced',
      canonicalParamId: 'get-meetings-client',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_get_meetings'],
      },
    },
    {
      id: 'get-meetings-period',
      title: 'Period',
      type: 'combobox',
      required: true,
      placeholder: 'Select period',
      dependsOn: ['operation'],
      options: [
        { label: '7 days', id: '7days' },
        { label: 'Today', id: 'today' },
        { label: '14 days', id: '14days' },
      ],
      value: () => '7days',
      condition: {
        field: 'operation',
        value: ['arena_get_meetings'],
      },
    },

    {
      id: 'get-my-tasks-within-minutes',
      title: 'Last N Minutes',
      type: 'short-input',
      required: false,
      placeholder: 'e.g. 60 — tasks updated in the last N minutes',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['arena_get_my_tasks'],
      },
    },
  ],
  inputs: {
    operation: { type: 'string', description: 'Operation to perform' },
  },
  outputs: {
    success: { type: 'boolean', description: 'Indicates if transform was successful' },
    output: { type: 'json', description: 'Output from Arena' },
  },
  tools: {
    access: [
      'arena_create_task',
      'arena_create_task_fields',
      'arena_create_sub_task',
      'arena_create_sub_task_fields',
      'arena_fetch_searched_tasks',
      'arena_search_task',
      'arena_search_task_simple',
      'arena_save_summary',
      'arena_comments',
      'arena_comments_task_number',
      'arena_get_meetings',
      'arena_get_my_tasks',
      'arena_get_my_overdue_tasks',
      'arena_get_token',
    ],
    config: {
      tool: (params) => {
        switch (params.operation) {
          case 'arena_create_task':
            return 'arena_create_task'
          case 'arena_create_task_fields':
            return 'arena_create_task_fields'
          case 'arena_create_sub_task':
            return 'arena_create_sub_task'
          case 'arena_create_sub_task_fields':
            return 'arena_create_sub_task_fields'
          case 'arena_fetch_searched_tasks':
            return 'arena_fetch_searched_tasks'
          case 'arena_search_task':
            return 'arena_search_task'
          case 'arena_search_task_simple':
            return 'arena_search_task_simple'
          case 'arena_save_summary':
            return 'arena_save_summary'
          case 'arena_comments':
            return 'arena_comments'
          case 'arena_comments_task_number':
            return 'arena_comments_task_number'
          case 'arena_get_meetings':
            return 'arena_get_meetings'
          case 'arena_get_my_tasks':
            return 'arena_get_my_tasks'
          case 'arena_get_my_overdue_tasks':
            return 'arena_get_my_overdue_tasks'
          case 'arena_get_token':
            return 'arena_get_token'
          default:
            throw new Error(`Invalid Arena operation: ${params.operation}`)
        }
      },
      params: (params) => {
        const normalized = { ...params }
        const rawWithinMinutes = params['get-my-tasks-within-minutes']
        if (
          rawWithinMinutes !== undefined &&
          rawWithinMinutes !== null &&
          String(rawWithinMinutes).trim() !== ''
        ) {
          normalized.withinMinutes = Number(rawWithinMinutes)
        }
        return normalized
      },
    },
  },
}
