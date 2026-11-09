import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const optionalString = z.string().optional()

const adsAccountsQuerySchema = z.object({
  workspaceId: optionalString,
  userId: optionalString,
})

const adsAccountsResponseSchema = z.object({
  success: z.literal(true),
  accounts: z.record(z.string(), z.unknown()),
  count: z.number(),
})

/** Query tool results vary by report. The route returns that JSON unchanged. */
const adsQueryResponse = {
  mode: 'json' as const,
  // untyped-response: ads query returns the report JSON built for that request
  schema: z.record(z.string(), z.unknown()),
}

export const googleAdsAccountsContract = defineRouteContract({
  method: 'GET',
  path: '/api/google-ads/accounts',
  query: adsAccountsQuerySchema,
  response: { mode: 'json', schema: adsAccountsResponseSchema },
})

export const bingAdsAccountsContract = defineRouteContract({
  method: 'GET',
  path: '/api/bing-ads/accounts',
  query: z.object({ workspaceId: optionalString }),
  response: { mode: 'json', schema: adsAccountsResponseSchema },
})

export const facebookAdsAccountsContract = defineRouteContract({
  method: 'GET',
  path: '/api/facebook-ads/accounts',
  query: z.object({ workspaceId: optionalString }),
  response: { mode: 'json', schema: adsAccountsResponseSchema },
})

const adsWorkspaceQuerySchema = z.object({
  workspaceId: optionalString,
  userId: optionalString,
})

export const googleAdsQueryContract = defineRouteContract({
  method: 'POST',
  path: '/api/google-ads/query',
  query: adsWorkspaceQuerySchema,
  body: z
    .object({
      query: requiredFieldSchema('No query provided'),
      accounts: z.string().optional(),
      workspaceId: optionalString,
      period_type: optionalString,
      output_format: optionalString,
      sort_by: optionalString,
      custom_start_date: optionalString,
      custom_end_date: optionalString,
    })
    .passthrough(),
  response: adsQueryResponse,
})

export const bingAdsQueryContract = defineRouteContract({
  method: 'POST',
  path: '/api/bing-ads/query',
  query: z.object({ workspaceId: optionalString }),
  body: z
    .object({
      query: z.string().optional(),
      account: z.string().optional(),
      workspaceId: optionalString,
    })
    .passthrough(),
  response: adsQueryResponse,
})

export const facebookAdsQueryContract = defineRouteContract({
  method: 'POST',
  path: '/api/facebook-ads/query',
  query: z.object({ workspaceId: optionalString }),
  body: z
    .object({
      query: z.string().optional(),
      account: optionalString,
      workspaceId: optionalString,
      accessToken: optionalString,
      accountId: optionalString,
      adAccountId: optionalString,
      date_preset: optionalString,
      time_range: z.object({ since: z.string(), until: z.string() }).optional(),
      fields: z.array(z.string()).optional(),
      level: optionalString,
    })
    .passthrough(),
  response: adsQueryResponse,
})

export const googleAdsV1QueryContract = defineRouteContract({
  method: 'POST',
  path: '/api/google-ads-v1/query',
  query: adsWorkspaceQuerySchema,
  body: z
    .object({
      query: z.string().optional(),
      accounts: optionalString,
      workspaceId: optionalString,
      accessToken: optionalString,
      accountId: optionalString,
      customerId: optionalString,
      developerToken: optionalString,
      managerCustomerId: optionalString,
    })
    .passthrough(),
  response: adsQueryResponse,
})

const nanoBananaImageSchema = z.union([
  z.string(),
  z.object({ path: z.string(), type: z.string().optional() }).passthrough(),
])

export const googleImageContract = defineRouteContract({
  method: 'POST',
  path: '/api/google',
  query: z.object({
    workflowId: optionalString,
    userId: optionalString,
  }),
  body: z
    .object({
      model: requiredFieldSchema(
        'model is required - Gemini image model (gemini-2.5-flash-image or gemini-3-pro-image-preview)'
      ),
      prompt: requiredFieldSchema('prompt is required - Text description for the image'),
      aspectRatio: optionalString,
      imageSize: optionalString,
      apiKey: optionalString,
      inputImage: nanoBananaImageSchema.optional(),
      inputImageMimeType: optionalString,
      inputImages: z.array(nanoBananaImageSchema).optional(),
    })
    .passthrough(),
  response: adsQueryResponse,
})

export const googleImageDocsContract = defineRouteContract({
  method: 'GET',
  path: '/api/google',
  response: {
    mode: 'json',
    schema: z.object({
      endpoint: z.string(),
      method: z.string(),
      description: z.string(),
      contentType: z.string(),
      requiredFields: z.record(z.string(), z.string()),
      optionalFields: z.record(z.string(), z.string()),
      response: z.record(z.string(), z.string()),
    }),
  },
})
