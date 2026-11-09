import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const proxyImageContract = defineRouteContract({
  method: 'GET',
  path: '/api/files/proxy-image',
  query: z.object({
    url: requiredFieldSchema('Missing url parameter'),
  }),
  response: { mode: 'binary' },
})
