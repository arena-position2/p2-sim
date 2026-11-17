import { getSession } from '@/lib/auth'
import { authenticateCronSecretRequest } from '@/app/api/v1/admin/cron-secret-auth'

/**
 * Auth for LLM catalog HTTP surfaces: signed-in session OR cron admin key.
 *
 * Accepts either:
 * - a Better Auth session cookie, or
 * - `x-admin-key: $CRON_SECRET` (same as other llm-catalog admin routes)
 *
 * Returns `null` when authorized, otherwise the error `Response` to return.
 */
export async function authenticateLlmCatalogRequest(request: Request): Promise<Response | null> {
  const session = await getSession()
  if (session?.user?.id) return null

  return authenticateCronSecretRequest(request)
}
