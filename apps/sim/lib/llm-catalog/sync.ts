import { db } from '@sim/db'
import { createLogger } from '@sim/logger'
import { sql } from 'drizzle-orm'
import { llmCatalogProviderRank } from '@/lib/llm-catalog/display-order'
import { PROVIDER_DEFINITIONS } from '@/providers/models'

const logger = createLogger('LlmCatalogSync')

export interface LlmCatalogSyncResult {
  providersUpserted: number
  modelsInserted: number
  modelsUpdated: number
  modelsDeactivatedMissing: number
}

function iconName(icon: unknown): string | null {
  if (!icon) return null
  const fn = icon as { displayName?: string; name?: string }
  return fn.displayName || fn.name || null
}

function patternSources(patterns: RegExp[] | undefined): string[] | null {
  if (!patterns?.length) return null
  return patterns.map((pattern) => pattern.source)
}

function modelStatusFromSunset(
  sunset: { status: 'legacy' | 'deprecated' } | undefined
): 'active' | 'deactive' {
  return sunset?.status === 'deprecated' ? 'deactive' : 'active'
}

function jsonb(value: unknown) {
  if (value === null || value === undefined) return sql`NULL`
  return sql`${JSON.stringify(value)}::jsonb`
}

function textArray(values: string[] | null) {
  if (!values?.length) return sql`NULL`
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `
  )}]::text[]`
}

/**
 * Code → DB sync for the LLM catalog.
 *
 * Reads the in-process {@link PROVIDER_DEFINITIONS} and upserts every provider /
 * model into `llm_provider` / `llm_model`. Call this after deploying model changes
 * (POST /api/v1/admin/llm-catalog/sync). Clients do not write the DB; they only
 * read active rows via GET /api/llm-catalog.
 *
 * Status rules:
 * - `sunset.status === 'deprecated'` → `model_status = 'deactive'`
 * - still in code otherwise → `model_status = 'active'` (insert or update)
 * - present in DB but no longer in code → left in place, set to `deactive`
 */
export async function syncLlmCatalogFromDefinitions(): Promise<LlmCatalogSyncResult> {
  const existingRows = await db.execute<{ id: string }>(sql`SELECT id FROM llm_model`)
  const existingIds = new Set([...existingRows].map((row) => row.id))
  const catalogModelIds = new Set<string>()

  let providersUpserted = 0
  let modelsInserted = 0
  let modelsUpdated = 0

  // Stable picker order: openai → google → anthropic → … (see display-order.ts).
  const providersInDisplayOrder = Object.entries(PROVIDER_DEFINITIONS).sort(
    ([a], [b]) => llmCatalogProviderRank(a) - llmCatalogProviderRank(b)
  )

  for (const [providerId, provider] of providersInDisplayOrder) {
    const providerSort = llmCatalogProviderRank(providerId)
    await db.execute(sql`
      INSERT INTO llm_provider (
        id, name, description, default_model, color, is_reseller,
        context_information_available, icon, model_patterns,
        file_attachment, capabilities, sort_order, updated_at
      ) VALUES (
        ${provider.id},
        ${provider.name},
        ${provider.description},
        ${provider.defaultModel ?? ''},
        ${provider.color ?? null},
        ${provider.isReseller ?? null},
        ${provider.contextInformationAvailable ?? null},
        ${iconName(provider.icon)},
        ${textArray(patternSources(provider.modelPatterns))},
        ${jsonb(provider.fileAttachment ?? null)},
        ${jsonb(provider.capabilities ?? null)},
        ${providerSort},
        now()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        default_model = EXCLUDED.default_model,
        color = EXCLUDED.color,
        is_reseller = EXCLUDED.is_reseller,
        context_information_available = EXCLUDED.context_information_available,
        icon = EXCLUDED.icon,
        model_patterns = EXCLUDED.model_patterns,
        file_attachment = EXCLUDED.file_attachment,
        capabilities = EXCLUDED.capabilities,
        sort_order = EXCLUDED.sort_order,
        updated_at = now()
    `)
    providersUpserted++

    let modelSort = 0
    for (const model of provider.models) {
      catalogModelIds.add(model.id)
      const modelStatus = modelStatusFromSunset(model.sunset)
      const alreadyExists = existingIds.has(model.id)

      await db.execute(sql`
        INSERT INTO llm_model (
          id, provider_id, pricing, capabilities, context_window, release_date,
          featured, recommended, speed_optimized, sunset, model_status, sort_order,
          updated_at
        ) VALUES (
          ${model.id},
          ${providerId},
          ${jsonb(model.pricing)},
          ${jsonb(model.capabilities ?? {})},
          ${model.contextWindow ?? null},
          ${model.releaseDate ?? null},
          ${model.featured ?? null},
          ${model.recommended ?? null},
          ${model.speedOptimized ?? null},
          ${jsonb(model.sunset ?? null)},
          ${modelStatus},
          ${modelSort},
          now()
        )
        ON CONFLICT (id) DO UPDATE SET
          provider_id = EXCLUDED.provider_id,
          pricing = EXCLUDED.pricing,
          capabilities = EXCLUDED.capabilities,
          context_window = EXCLUDED.context_window,
          release_date = EXCLUDED.release_date,
          featured = EXCLUDED.featured,
          recommended = EXCLUDED.recommended,
          speed_optimized = EXCLUDED.speed_optimized,
          sunset = EXCLUDED.sunset,
          model_status = EXCLUDED.model_status,
          sort_order = EXCLUDED.sort_order,
          updated_at = now()
      `)

      if (alreadyExists) modelsUpdated++
      else modelsInserted++
      modelSort++
    }
  }

  const missingIds = [...existingIds].filter((id) => !catalogModelIds.has(id))
  let modelsDeactivatedMissing = 0
  if (missingIds.length > 0) {
    const deactivated = await db.execute<{ id: string }>(sql`
      UPDATE llm_model
      SET model_status = 'deactive', updated_at = now()
      WHERE id IN (${sql.join(
        missingIds.map((id) => sql`${id}`),
        sql`, `
      )})
        AND model_status IS DISTINCT FROM 'deactive'
      RETURNING id
    `)
    modelsDeactivatedMissing = deactivated.length
  }

  const result = {
    providersUpserted,
    modelsInserted,
    modelsUpdated,
    modelsDeactivatedMissing,
  }
  logger.info('LLM catalog sync completed', result)
  return result
}
