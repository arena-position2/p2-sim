import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

/**
 * Arena service JSON. The route returns that body unchanged, including fields
 * the service adds later.
 */
const arenaUpstreamJsonResponse = {
  mode: 'json' as const,
  // untyped-response: Arena returns the upstream service JSON body unchanged
  schema: z.record(z.string(), z.unknown()),
}

const optionalString = z.string().optional()

/** Blank query values are omitted. `z.coerce.number()` would turn `''` into `0`. */
function optionalPositiveQueryNumber(message: string) {
  return z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.coerce
      .number()
      .refine((value) => Number.isFinite(value) && value > 0, { error: message })
      .optional()
  )
}

function queryPositiveInt(message: string, fallback: number) {
  return z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.coerce
      .number()
      .refine((value) => Number.isInteger(value) && value > 0, { error: message })
      .default(fallback)
  )
}

const requiredQueryField = (name: string) => requiredFieldSchema(`Missing required field: ${name}`)

/**
 * Body the create-task tools post. Both the selector payload and the
 * name/email payload hit the same routes, and the handler forwards every
 * other key to Arena.
 */
const arenaCreateTaskBodySchema = z
  .object({
    workflowId: optionalString,
    name: optionalString,
    taskHtmlDescription: optionalString,
    taskDescription: optionalString,
    plannedStartDate: z.unknown().optional(),
    plannedEndDate: z.unknown().optional(),
    taskType: optionalString,
    clientId: optionalString,
    projectId: optionalString,
    assignedToId: optionalString,
    epicId: optionalString,
    epicName: optionalString,
    deliverableId: optionalString,
    clientName: optionalString,
    projectName: optionalString,
    assignee: optionalString,
    taskNumber: optionalString,
    createdBy: optionalString,
  })
  .passthrough()

const arenaCommentBodySchema = z
  .object({
    workflowId: optionalString,
    elementId: optionalString,
    value: optionalString,
    projectName: optionalString,
    internal: z.boolean().optional(),
    showToClient: z.boolean().optional(),
    userMentionedIds: z.array(z.string()).optional(),
    name: optionalString,
    chatFor: optionalString,
    parentId: optionalString,
    element: optionalString,
    createdBy: optionalString,
  })
  .passthrough()

const arenaCommentUpdatedBodySchema = z
  .object({
    workflowId: optionalString,
    taskNumber: optionalString,
    comment: optionalString,
    userMentionedIds: z.array(z.string()).optional(),
    showToClient: z.boolean().optional(),
    to: optionalString,
    cc: optionalString,
    createdBy: optionalString,
  })
  .passthrough()

const arenaSaveSummaryBodySchema = z
  .object({
    workflowId: optionalString,
    clientId: optionalString,
    summary: optionalString,
  })
  .passthrough()

const arenaSearchedTasksBodySchema = z.object({
  workflowId: requiredFieldSchema('Missing required field: workflowId'),
  clientName: optionalString,
  projectName: optionalString,
  assigneeName: optionalString,
  state: optionalString,
})

export const arenaCreateTaskContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/arena/tasks',
  body: arenaCreateTaskBodySchema,
  response: arenaUpstreamJsonResponse,
})

export const arenaCreateTaskUpdatedContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/arena/tasks-updated',
  body: arenaCreateTaskBodySchema,
  response: arenaUpstreamJsonResponse,
})

export const arenaAddCommentContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/arena/comments',
  body: arenaCommentBodySchema,
  response: arenaUpstreamJsonResponse,
})

export const arenaAddCommentUpdatedContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/arena/comments-updated',
  body: arenaCommentUpdatedBodySchema,
  response: arenaUpstreamJsonResponse,
})

export const arenaSaveSummaryContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/arena/save-summary',
  body: arenaSaveSummaryBodySchema,
  response: arenaUpstreamJsonResponse,
})

export const arenaGetSearchedTasksContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/arena/get-searched-tasks',
  body: arenaSearchedTasksBodySchema,
  response: arenaUpstreamJsonResponse,
})

export const arenaGetMyTasksContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/arena/get-my-tasks',
  query: z.object({
    workflowId: requiredQueryField('workflowId'),
    withinMinutes: optionalPositiveQueryNumber('Invalid withinMinutes: must be a positive number'),
  }),
  response: arenaUpstreamJsonResponse,
})

export const arenaGetMyOverdueTasksContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/arena/get-my-overdue-tasks',
  query: z.object({
    workflowId: requiredQueryField('workflowId'),
  }),
  response: arenaUpstreamJsonResponse,
})

export const arenaGetMeetingsContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/arena/get-meetings',
  query: z.object({
    workflowId: requiredQueryField('workflowId'),
    clientId: requiredQueryField('clientId'),
    period: requiredQueryField('period'),
  }),
  response: arenaUpstreamJsonResponse,
})

export const arenaGetTokenContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/arena/get-token',
  query: z.object({
    userId: optionalString,
    email: optionalString,
  }),
  response: {
    mode: 'json',
    schema: z.object({
      found: z.literal(true),
      userId: z.string(),
      name: z.string().nullable(),
      email: z.string(),
      arenaToken: z.string(),
      timezone: z.string().nullable(),
      persona: z.string().nullable(),
    }),
  },
})

export const arenaClientUpdatedTasksContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/arena/client-updated-tasks',
  query: z.object({
    workflowId: requiredQueryField('workflowId'),
    cid: requiredQueryField('cid'),
    period: requiredQueryField('period'),
    pageNumber: queryPositiveInt('Invalid pageNumber', 1),
    pageSize: queryPositiveInt('Invalid pageSize', 10),
  }),
  response: arenaUpstreamJsonResponse,
})

export const arenaProjectSummaryContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/arena/project-summary',
  query: z.object({
    workflowId: optionalString,
    cid: requiredQueryField('cid'),
  }),
  response: arenaUpstreamJsonResponse,
})

export const arenaConversationSummaryContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/arena/conversation-summary',
  query: z.object({
    workflowId: optionalString,
    taskId: requiredQueryField('taskId'),
  }),
  response: arenaUpstreamJsonResponse,
})

const overallClientSummaryFields = {
  client_id: requiredFieldSchema('client_id is required'),
  client_name: optionalString,
  type: optionalString,
  one_day_summary: optionalString,
  seven_day_summary: optionalString,
  fourteen_day_summary: optionalString,
  daily_summary_changes: optionalString,
  weekly_sentiment: optionalString,
  status: optionalString,
}

export const arenaOverallClientSummaryQueryContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/arena/overall-client-summary',
  query: z.object({
    cid: requiredFieldSchema('cid parameter is required'),
    type: requiredFieldSchema('type parameter is required'),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      data: z.object({
        client_id: z.string(),
        message: z.string().optional(),
        run_date: z.string().optional(),
        total_records: z.number().optional(),
        summaries: z.array(z.record(z.string(), z.unknown())),
      }),
    }),
  },
})

export const arenaOverallClientSummaryBodyContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/arena/overall-client-summary',
  body: z.object(overallClientSummaryFields),
  response: {
    mode: 'json',
    status: [200, 201],
    schema: z.object({
      success: z.literal(true),
      data: z.object({
        id: z.string(),
        message: z.string(),
        action: z.enum(['created', 'updated']),
      }),
    }),
  },
})
