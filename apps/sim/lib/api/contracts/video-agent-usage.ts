import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const requiredUsageField = requiredFieldSchema('email, endpointId, and requestId are required.')

export const videoAgentUsageQueryContract = defineRouteContract({
  method: 'GET',
  path: '/api/usage/video-agent',
  query: z.object({
    email: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
      requiredFieldSchema('email is required.').refine((value) => value.includes('@'), {
        error: 'email is required.',
      })
    ),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      allowed: z.boolean(),
      found: z.boolean(),
    }),
  },
})

export const videoAgentUsageBodyContract = defineRouteContract({
  method: 'POST',
  path: '/api/usage/video-agent',
  body: z.object({
    email: requiredUsageField.refine((value) => value.toLowerCase().includes('@'), {
      error: 'email, endpointId, and requestId are required.',
    }),
    endpointId: requiredUsageField,
    requestId: requiredUsageField,
    workspaceId: z.string().optional(),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      ok: z.literal(true),
      userId: z.string(),
      rawCost: z.number(),
      cost: z.number(),
    }),
  },
})
