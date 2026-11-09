import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const imageGenerationBodySchema = z.object({
  baseToolId: z.enum(['openai_image', 'google_imagen', 'google_nano_banana', 'image_generate']),
  params: z.record(z.string(), z.unknown()),
})

export const imageGenerationContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/image-generation',
  body: imageGenerationBodySchema,
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      output: z.record(z.string(), z.unknown()),
    }),
  },
})
