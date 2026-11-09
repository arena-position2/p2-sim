import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const developmentReposContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/development/repos',
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      repos: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          source: z.enum(['local', 'github', 'both']),
          description: z.string().optional(),
          htmlUrl: z.string().optional(),
          updatedAt: z.string().optional(),
        })
      ),
    }),
  },
})
