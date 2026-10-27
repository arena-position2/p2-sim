/**
 * Infer integration provider IDs from workspace env credential keys (`credential.type`
 * `env_workspace` / `env_personal`). Used so mothership/copilot "Connected Integrations"
 * matches runtime reality when tokens live in env vars instead of OAuth rows.
 */

import { listHubSpotSharedAccountAliases } from '@/lib/hubspot/env-aliases'

/**
 * HubSpot shared portal aliases from `account_tokens` (see `list-account-options.ts`).
 * Mothership treats HubSpot as available when these exist, even without per-user OAuth rows.
 */
export function getHubSpotSharedAccountOptionIds(): string[] {
  return listHubSpotSharedAccountAliases()
}

/**
 * Returns extra provider IDs implied by env *credential* keys (not encrypted env var blobs).
 */
export function inferProviderIdsFromEnvCredentialKeys(envKeys: string[]): string[] {
  const out = new Set<string>()
  for (const key of envKeys) {
    if (!key || typeof key !== 'string') continue
    const upper = key.toUpperCase()
    if (upper.startsWith('HUBSPOT_')) {
      out.add('hubspot')
    }
  }
  return [...out]
}

export interface OAuthIntegrationPresence {
  id: string
  providerId: string
  displayName?: string | null
  role?: string | null
  /** True when this OAuth connection belongs to the signed-in user. */
  isOwn?: boolean
}

/**
 * Merges OAuth/service-account connected credentials with providers inferred from env credentials.
 * Env-only providers get a synthetic row so WORKSPACE.md still lists them as available.
 */
export function mergeOAuthIntegrationPresence(
  fromOAuthRows: OAuthIntegrationPresence[],
  envCredentialKeys: string[],
  hubspotSharedAccountIds?: string[]
): OAuthIntegrationPresence[] {
  const result: OAuthIntegrationPresence[] = [...fromOAuthRows]
  const presentProviders = new Set(fromOAuthRows.map((r) => r.providerId))

  for (const providerId of inferProviderIdsFromEnvCredentialKeys(envCredentialKeys)) {
    if (presentProviders.has(providerId)) continue
    presentProviders.add(providerId)
    result.push({
      id: `__env__:${providerId}`,
      providerId,
      displayName: 'via environment credential',
    })
  }

  if (
    hubspotSharedAccountIds &&
    hubspotSharedAccountIds.length > 0 &&
    !presentProviders.has('hubspot')
  ) {
    result.push({
      id: '__hubspot_accounts__',
      providerId: 'hubspot',
      displayName: 'via shared accounts subblock',
    })
  }

  return result.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id))
}
