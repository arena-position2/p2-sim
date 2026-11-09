import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const adminImportDeployWorkflowsContract = defineRouteContract({
  method: 'POST',
  path: '/api/v1/admin/users/import-deploy-workflows',
  body: z
    .object({
      emailId: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
        requiredFieldSchema('emailId is required.')
      ),
      sourceWorkflowId: z.unknown().optional(),
      sourceWorkflowIds: z.unknown().optional(),
      apiKeyName: z.string().optional(),
      workflows: z.array(z.record(z.string(), z.unknown())).optional(),
      postgres: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  response: {
    mode: 'json',
    schema: z.object({
      data: z.object({
        userId: z.string(),
        emailId: z.string(),
        workspace: z.object({
          id: z.string(),
          created: z.boolean(),
        }),
        apiKey: z.record(z.string(), z.unknown()),
        imported: z.number(),
        deployed: z.number(),
        failed: z.number(),
        results: z.array(z.record(z.string(), z.unknown())),
      }),
    }),
  },
})
