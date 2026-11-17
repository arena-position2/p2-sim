/**
 * React Query keys for the LLM provider catalog.
 * Kept in a non-`'use client'` module so server code can import safely.
 */
export const llmCatalogKeys = {
  all: ['llm-catalog'] as const,
  /** Active models from GET /api/v1/admin/llm-catalog (used to hydrate PROVIDER_DEFINITIONS). */
  active: () => [...llmCatalogKeys.all, 'active'] as const,
}
