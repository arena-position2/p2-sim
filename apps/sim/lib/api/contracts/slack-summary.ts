import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const summaryQuerySchema = z.object({
  cid: requiredFieldSchema('cid parameter is required'),
  type: requiredFieldSchema('type parameter is required'),
})

const summaryListResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    client_id: z.string(),
    message: z.string().optional(),
    run_date: z.string().optional(),
    total_records: z.number().optional(),
    summaries: z.array(z.record(z.string(), z.unknown())),
  }),
})

const slackSummaryBodySchema = z
  .object({
    client_id: requiredFieldSchema('client_id is required'),
    client_name: z.string().optional(),
    channel_id: requiredFieldSchema('channel_id is required'),
    channel_name: z.string().optional(),
    channel_type: z.string().optional(),
    type: z.string().optional(),
    one_day_summary: z.string().optional(),
    seven_day_summary: z.string().optional(),
    fourteen_day_summary: z.string().optional(),
  })
  .passthrough()
  .refine(
    (body) => Boolean(body.one_day_summary || body.seven_day_summary || body.fourteen_day_summary),
    {
      error:
        'At least one summary field is required (one_day_summary, seven_day_summary, or fourteen_day_summary)',
    }
  )

export const slackSummaryQueryContract = defineRouteContract({
  method: 'GET',
  path: '/api/slack/summary',
  query: summaryQuerySchema,
  response: { mode: 'json', schema: summaryListResponseSchema },
})

export const slackSummaryBodyContract = defineRouteContract({
  method: 'POST',
  path: '/api/slack/summary',
  body: slackSummaryBodySchema,
  response: {
    mode: 'json',
    status: [200, 201],
    schema: z.object({
      success: z.literal(true),
      data: z.object({
        id: z.string(),
        message: z.string(),
        action: z.enum(['created', 'updated']),
      }),
    }),
  },
})
