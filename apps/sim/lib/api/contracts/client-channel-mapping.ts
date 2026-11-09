import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const clientChannelMappingContract = defineRouteContract({
  method: 'GET',
  path: '/api/client-channel-mapping/:clientId/channels',
  params: z.object({
    clientId: requiredFieldSchema('clientId is required'),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      channels: z.array(
        z.object({
          channel_id: z.string(),
          channel_name: z.string(),
        })
      ),
    }),
  },
})
