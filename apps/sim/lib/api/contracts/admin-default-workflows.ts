import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const adminSyncDefaultWorkflowsContract = defineRouteContract({
  method: 'POST',
  path: '/api/v1/admin/default-workflows/sync',
  body: z
    .object({
      sourceWorkflowId: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        requiredFieldSchema('sourceWorkflowId is required.')
      ),
      deploy: z.boolean().optional(),
      deployAsChat: z.boolean().optional(),
      chat: z.unknown().optional(),
      postgres: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  response: {
    mode: 'json',
    schema: z.object({
      data: z.record(z.string(), z.unknown()),
    }),
  },
})
