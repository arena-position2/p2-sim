import { assertOperationPrincipal, type OperationUseCase } from '@/lib/core/application'
import { llmCatalogOperations } from '@/lib/llm-catalog/application/operations'
import { getActiveLlmCatalog, type LlmCatalogDefinitions } from '@/lib/llm-catalog/get-active'

/** Authorized use case behind GET /api/llm-catalog — any signed-in session. */
export const getActiveLlmCatalogUseCase: OperationUseCase<
  typeof llmCatalogOperations.getActive,
  Record<string, never>,
  LlmCatalogDefinitions
> = {
  operation: llmCatalogOperations.getActive,
  async execute({ principal }) {
    assertOperationPrincipal(principal, llmCatalogOperations.getActive)
    return getActiveLlmCatalog()
  },
}
