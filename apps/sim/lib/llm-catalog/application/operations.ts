import { defineOperation } from '@/lib/core/application'

/** Application operations for the LLM catalog (session-readable, not workspace-scoped). */
export const llmCatalogOperations = {
  // permission-group-exempt: global model catalog is readable by any signed-in user
  getActive: defineOperation({
    id: 'llm_catalog.get_active',
    principalKinds: ['session'],
    capability: 'none',
  }),
} as const
