import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const figmaDesignBodySchema = z.object({
  projectId: requiredFieldSchema(
    'Missing required fields: projectId, fileName, and prompt are required'
  ),
  fileName: requiredFieldSchema(
    'Missing required fields: projectId, fileName, and prompt are required'
  ),
  prompt: requiredFieldSchema(
    'Missing required fields: projectId, fileName, and prompt are required'
  ),
  brandGuidelinesFile: z.string().optional(),
  wireframesFile: z.string().optional(),
  additionalDataFile: z.string().optional(),
  additionalInfo: z.string().optional(),
  description: z.string().optional(),
  designTargets: z.union([z.string(), z.array(z.string())]).optional(),
})

export const figmaGenerateDesignContract = defineRouteContract({
  method: 'POST',
  path: '/api/figma/generate-design-json',
  body: figmaDesignBodySchema,
  response: {
    mode: 'json',
    // untyped-response: generateFigmaDesign returns its own success payload
    schema: z.record(z.string(), z.unknown()),
  },
})

export const figmaGenerateDesignDocsContract = defineRouteContract({
  method: 'GET',
  path: '/api/figma/generate-design-json',
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
