import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const optionalString = z.string().optional()

const semrushApiKey = requiredFieldSchema(
  'Semrush API key is required. Configure it on the Semrush block.'
)

export const semrushQueryContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/semrush/query',
  query: z.object({
    apiKey: semrushApiKey,
    domain: optionalString,
    url: optionalString,
    type: optionalString,
    database: optionalString,
    display_limit: optionalString,
    export_columns: optionalString,
    additionalParams: optionalString,
  }),
  response: { mode: 'text' },
})

export const semrushPositionTrackingOrganicContract = defineRouteContract({
  method: 'GET',
  path: '/api/tools/semrush/position-tracking-organic',
  query: z.object({
    apiKey: semrushApiKey,
    campaignId: requiredFieldSchema(
      'campaignId and url are required for Organic Positions Report.'
    ),
    url: requiredFieldSchema('campaignId and url are required for Organic Positions Report.'),
    date_begin: optionalString,
    date_end: optionalString,
    linktype_filter: optionalString,
    display_tags: optionalString,
    display_tags_condition: optionalString,
    display_sort: optionalString,
    display_limit: optionalString,
    display_offset: optionalString,
    display_filter: optionalString,
    top_filter: optionalString,
    use_volume: optionalString,
    business_name: optionalString,
    serp_feature_filter: optionalString,
  }),
  response: {
    mode: 'json',
    // untyped-response: Semrush returns the position-tracking report JSON unchanged
    schema: z.record(z.string(), z.unknown()),
  },
})
