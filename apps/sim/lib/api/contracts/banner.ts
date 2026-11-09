import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const appBannerContract = defineRouteContract({
  method: 'GET',
  path: '/api/app/banner',
  response: {
    mode: 'json',
    schema: z.object({
      data: z.object({
        message: z.string(),
      }),
    }),
  },
})
