import { db } from '@sim/db'
import { createLogger } from '@sim/logger'
import { sql } from 'drizzle-orm'
import { clearLlmCatalogCache, setLlmCatalogCache } from '@/lib/llm-catalog/cache'
import { loadLlmCatalogFromDb } from '@/lib/llm-catalog/get-active'

const logger = createLogger('LlmCatalogUpdateModelStatus')

export type LlmModelStatus = 'active' | 'deactive'

export interface UpdateLlmModelStatusResult {
  id: string
  modelStatus: LlmModelStatus
  previousStatus: LlmModelStatus
}

export class LlmModelNotFoundError extends Error {
  readonly code = 'LLM_MODEL_NOT_FOUND' as const

  constructor(modelId: string) {
    super(`LLM model not found: ${modelId}`)
    this.name = 'LlmModelNotFoundError'
  }
}

/**
 * Ops flip for a single catalog row's `model_status`.
 *
 * Cache flow (same shape as sync):
 * 1. Clear the catalog cache
 * 2. Update `llm_model.model_status` by id
 * 3. Reload the full catalog from DB and push it into the cache
 */
export async function updateLlmModelStatus(
  modelId: string,
  modelStatus: LlmModelStatus
): Promise<UpdateLlmModelStatusResult> {
  await clearLlmCatalogCache()

  const updated = await db.execute<{
    id: string
    model_status: LlmModelStatus
    previous_status: LlmModelStatus
  }>(sql`
    WITH before AS (
      SELECT id, model_status AS previous_status
      FROM llm_model
      WHERE id = ${modelId}
    ),
    updated AS (
      UPDATE llm_model AS m
      SET model_status = ${modelStatus}::llm_model_status, updated_at = now()
      FROM before
      WHERE m.id = before.id
      RETURNING m.id, m.model_status, before.previous_status
    )
    SELECT id, model_status, previous_status FROM updated
  `)

  const catalog = await loadLlmCatalogFromDb()
  await setLlmCatalogCache(catalog)

  const row = [...updated][0]
  if (!row) {
    throw new LlmModelNotFoundError(modelId)
  }

  const result: UpdateLlmModelStatusResult = {
    id: row.id,
    modelStatus: row.model_status,
    previousStatus: row.previous_status,
  }
  logger.info('Updated LLM model status', result)
  return result
}
