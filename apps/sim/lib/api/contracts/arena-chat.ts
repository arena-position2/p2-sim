import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const optionalString = z.string().optional()

function optionalQueryInt(fallback: number, min: number, max?: number) {
  const numberSchema = z.coerce.number().int().min(min)
  const bounded = max === undefined ? numberSchema : numberSchema.max(max)
  return z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    bounded.default(fallback)
  )
}

const agentListItemSchema = z
  .object({
    title: z.string().nullable().optional(),
    author_email: z.string().nullable().optional(),
    workflow_id: z.string(),
    subdomain: z.string().nullable().optional(),
    workflow_name: z.string().nullable().optional(),
    workflow_description: z.string().nullable().optional(),
    workspace_id: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    created_at: z.string().optional(),
  })
  .passthrough()

const agentListResponseSchema = z.object({
  success: z.literal(true),
  agentList: z.array(agentListItemSchema),
  count: z.number(),
})

export const chatHistoryContract = defineRouteContract({
  method: 'GET',
  path: '/api/chat/:identifier/history',
  params: z.object({
    identifier: requiredFieldSchema('identifier is required'),
  }),
  query: z.object({
    limit: optionalQueryInt(50, 1, 100),
    offset: optionalQueryInt(0, 0),
    startDate: optionalString,
    endDate: optionalString,
    conversationId: optionalString,
    chatId: optionalString,
    level: z.enum(['info', 'error']).optional(),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      logs: z.array(z.record(z.string(), z.unknown())),
      pagination: z.object({
        limit: z.number(),
        offset: z.number(),
        total: z.number(),
        hasMore: z.boolean(),
      }),
    }),
  },
})

export const chatAllHistoryContract = defineRouteContract({
  method: 'GET',
  path: '/api/chat/:identifier/all-history',
  params: z.object({
    identifier: requiredFieldSchema('identifier is required'),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      records: z.array(z.record(z.string(), z.unknown())),
      total: z.number(),
    }),
  },
})

export const chatAgentsContract = defineRouteContract({
  method: 'GET',
  path: '/api/chat/agents',
  query: z.object({
    emailId: requiredFieldSchema('emailId parameter is required'),
  }),
  response: { mode: 'json', schema: agentListResponseSchema },
})

export const chatAgentsListContract = defineRouteContract({
  method: 'GET',
  path: '/api/chat/agentsList',
  query: z.object({
    tabName: z.enum(['myagents', 'sharedwithme', 'global']).optional(),
    emailId: optionalString,
    departmentName: optionalString,
    onlyAgentAccess: optionalString,
    GENERIC_AGENTS_WORKSPACE_ID: optionalString,
  }),
  response: { mode: 'json', schema: agentListResponseSchema },
})

export const chatAgentDetailContract = defineRouteContract({
  method: 'GET',
  path: '/api/chat/agentsList/:id',
  params: z.object({
    id: requiredFieldSchema('id is required'),
  }),
  query: z.object({
    emailId: optionalString,
  }),
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      agent: z.record(z.string(), z.unknown()),
    }),
  },
})

export const chatWorkflowFeedbackContract = defineRouteContract({
  method: 'GET',
  path: '/api/chat/feedback/workflow/:id',
  params: z.object({
    id: requiredFieldSchema('workflowId is required'),
  }),
  query: z.object({
    pageSize: optionalQueryInt(20, 1, 100),
    page: optionalQueryInt(1, 1),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      feedback: z.array(z.record(z.string(), z.unknown())),
      pagination: z.object({
        count: z.number(),
        pageSize: z.number(),
        pageNumber: z.number(),
        totalCount: z.number(),
        totalPages: z.number(),
      }),
    }),
  },
})
