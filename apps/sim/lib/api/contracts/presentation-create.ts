import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const presentationCreateContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/presentation/create',
  body: z
    .object({
      operation: requiredFieldSchema('Missing required field: operation'),
      numberOfSlides: z.union([z.string(), z.number()]).optional(),
      tone: requiredFieldSchema('Missing required field: tone'),
      verbosity: requiredFieldSchema('Missing required field: verbosity'),
      template: z.string().optional(),
      content: z.string().optional(),
      slides_markdown: z.array(z.unknown()).optional(),
      instructions: z.string().optional(),
    })
    .passthrough(),
  response: {
    mode: 'json',
    schema: z.object({
      presentationFile: z.object({
        data: z.string(),
        filename: z.string(),
        mimetype: z.string(),
      }),
      presentationId: z.string(),
      message: z.string(),
    }),
  },
})
