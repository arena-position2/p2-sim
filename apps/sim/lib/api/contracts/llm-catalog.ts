/**
 * Route contracts for the LLM provider catalog (all under /api/v1/admin/llm-catalog).
 *
 * Auth for every route below: signed-in session cookie OR x-admin-key: $CRON_SECRET.
 *
 * - GET   /api/v1/admin/llm-catalog                 — active models for UI hydrate
 * - POST  /api/v1/admin/llm-catalog/sync            — code → DB upsert
 * - PATCH /api/v1/admin/llm-catalog/models/status   — flip one model_status
 */
import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'

const llmCatalogModelSchema = z.object({
  id: z.string(),
  pricing: z.record(z.string(), z.unknown()),
  capabilities: z.record(z.string(), z.unknown()),
  contextWindow: z.number().int().positive().optional(),
  releaseDate: z.string().optional(),
  featured: z.boolean().optional(),
  recommended: z.boolean().optional(),
  speedOptimized: z.boolean().optional(),
  sunset: z.record(z.string(), z.unknown()).optional(),
})

const llmCatalogProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  defaultModel: z.string(),
  color: z.string().optional(),
  isReseller: z.boolean().optional(),
  contextInformationAvailable: z.boolean().optional(),
  icon: z.string().optional(),
  modelPatterns: z.array(z.string()).optional(),
  fileAttachment: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  models: z.array(llmCatalogModelSchema),
})

/** PROVIDER_DEFINITIONS-shaped catalog keyed by provider id. */
const llmCatalogDefinitionsSchema = z.record(z.string(), llmCatalogProviderSchema)

const llmCatalogDataResponseSchema = z.object({
  data: llmCatalogDefinitionsSchema,
})

export const adminGetLlmCatalogContract = defineRouteContract({
  method: 'GET',
  path: '/api/v1/admin/llm-catalog',
  response: {
    mode: 'json',
    schema: llmCatalogDataResponseSchema,
  },
})

export const adminSyncLlmCatalogContract = defineRouteContract({
  method: 'POST',
  path: '/api/v1/admin/llm-catalog/sync',
  response: {
    mode: 'json',
    schema: z.object({
      data: z.object({
        providersUpserted: z.number().int().nonnegative(),
        modelsInserted: z.number().int().nonnegative(),
        modelsUpdated: z.number().int().nonnegative(),
        modelsSkippedDeactive: z.number().int().nonnegative(),
        modelsDeactivatedMissing: z.number().int().nonnegative(),
      }),
    }),
  },
})

const llmModelStatusSchema = z.enum(['active', 'deactive'])

export const adminUpdateLlmModelStatusContract = defineRouteContract({
  method: 'PATCH',
  path: '/api/v1/admin/llm-catalog/models/status',
  body: z.object({
    id: z.string().min(1),
    modelStatus: llmModelStatusSchema,
  }),
  response: {
    mode: 'json',
    schema: z.object({
      data: z.object({
        id: z.string(),
        modelStatus: llmModelStatusSchema,
        previousStatus: llmModelStatusSchema,
      }),
    }),
  },
})
