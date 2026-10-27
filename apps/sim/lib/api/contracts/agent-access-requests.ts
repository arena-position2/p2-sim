import { z } from 'zod'
import { workspaceIdSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const agentAccessRequestRowSchema = z
  .object({
    id: z.string(),
    agent_name: z.string(),
    requested_user_email: z.string(),
    workflow_id: z.string(),
    requested_user_name: z.string().nullable(),
    workspace_id: z.string().nullable(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    approved_by: z.string().nullable(),
  })
  .passthrough()

export const listAgentAccessRequestsQuerySchema = z
  .object({
    /** When omitted, the platform-admin inbox lists requests across workspaces. */
    workspaceId: workspaceIdSchema.optional(),
  })
  .strict()

export const listAgentAccessRequestsResponseSchema = z
  .object({
    success: z.literal(true),
    rows: z.array(agentAccessRequestRowSchema),
    rowCount: z.number().int().nonnegative(),
  })
  .strict()

export const listAgentAccessRequestsContract = defineRouteContract({
  method: 'GET',
  path: '/api/admin/agent-access-requests',
  query: listAgentAccessRequestsQuerySchema,
  response: {
    mode: 'json',
    schema: listAgentAccessRequestsResponseSchema,
  },
})

export const agentAccessRequestDecisionStatusSchema = z.enum(['done', 'cancelled'])

export const approveAgentAccessRequestsBodySchema = z
  .object({
    giveAccessList: z
      .array(
        z
          .object({
            accessId: z.string().min(1, 'accessId is required'),
            status: agentAccessRequestDecisionStatusSchema,
          })
          .strict()
      )
      .min(1, 'Select at least one access request')
      .max(200),
    approvedBy: z
      .string()
      .email('approvedBy must be a valid email')
      .min(1, 'approvedBy is required'),
  })
  .strict()

export const approveAgentAccessRequestsResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .strict()

export const approveAgentAccessRequestsContract = defineRouteContract({
  method: 'POST',
  path: '/api/admin/agent-access-requests',
  body: approveAgentAccessRequestsBodySchema,
  response: {
    mode: 'json',
    schema: approveAgentAccessRequestsResponseSchema,
  },
})

export type AgentAccessRequestRow = z.output<typeof agentAccessRequestRowSchema>
export type ListAgentAccessRequestsQuery = z.input<typeof listAgentAccessRequestsQuerySchema>
export type ListAgentAccessRequestsResponse = z.output<typeof listAgentAccessRequestsResponseSchema>
export type AgentAccessRequestDecisionStatus = z.output<
  typeof agentAccessRequestDecisionStatusSchema
>
export type ApproveAgentAccessRequestsBody = z.input<typeof approveAgentAccessRequestsBodySchema>
export type ApproveAgentAccessRequestsResponse = z.output<
  typeof approveAgentAccessRequestsResponseSchema
>
