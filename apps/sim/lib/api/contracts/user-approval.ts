import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const userApprovalContract = defineRouteContract({
  method: 'GET',
  path: '/api/users/approval',
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      users: z.array(z.record(z.string(), z.unknown())),
    }),
  },
})
