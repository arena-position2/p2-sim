import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const adminSyncLlmCatalogContract = defineRouteContract({
  method: 'POST',
  path: '/api/v1/admin/llm-catalog/sync',
  response: {
    mode: 'json',
    schema: z.object({
      data: z.object({
        providersUpserted: z.number().int().nonnegative(),
        modelsInserted: z.number().int().nonnegative(),
        modelsUpdated: z.number().int().nonnegative(),
        modelsDeactivatedMissing: z.number().int().nonnegative(),
        embeddingsUpserted: z.number().int().nonnegative(),
        rerankUpserted: z.number().int().nonnegative(),
      }),
    }),
  },
})
