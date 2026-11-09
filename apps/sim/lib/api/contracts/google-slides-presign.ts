import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const googleSlidesPresignContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/google_slides/presign-image',
  body: z.object({
    imageUrl: requiredFieldSchema('imageUrl is required'),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      url: z.string(),
    }),
  },
})
