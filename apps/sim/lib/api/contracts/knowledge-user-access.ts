import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const knowledgeUserAccessContract = defineRouteContract({
  method: 'GET',
  path: '/api/knowledge/user-access',
  query: z.object({
    workspaceId: z.string().optional(),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      data: z.array(z.record(z.string(), z.unknown())),
    }),
  },
})
