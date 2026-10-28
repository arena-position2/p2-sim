import { createLogger } from '@sim/logger'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/lib/api/client/request'
import {
  type ConnectedAccount,
  disconnectOAuthContract,
  listOAuthConnectionsContract,
  type OAuthAccountSummary,
  type OAuthConnection,
} from '@/lib/api/contracts/oauth-connections'
import { client } from '@/lib/auth/auth-client'
import { readOAuthReturnContext } from '@/lib/credentials/client-state'
import { OAUTH_CREDENTIAL_DRAFT_CALLBACK_PARAM } from '@/lib/credentials/draft-constants'
import { OAUTH_PROVIDERS, type OAuthServiceConfig } from '@/lib/oauth'
import { requiresCustomOAuthApp } from '@/lib/oauth/custom-app-config'
import { getPerRequestOAuthLinkScopes } from '@/lib/oauth/utils'
import { environmentKeys } from '@/hooks/queries/environment'
import { workspaceCredentialKeys } from '@/hooks/queries/utils/credential-keys'

const OAUTH_CREDENTIALS_KEY = ['oauthCredentials'] as const

const logger = createLogger('OAuthConnectionsQuery')

export const OAUTH_CONNECTIONS_STALE_TIME = 30 * 1000

/**
 * `postMessage` `data.type` when Sim is embedded in Arena (`?from=arena_v3`) and the user starts OAuth.
 * The parent should set `window.location.href = data.url` (top-level navigation) so the provider can redirect back to Sim.
 */
export const ARENA_V3_PARENT_OAUTH_NAVIGATE_MESSAGE_TYPE = 'sim:arena-v3-oauth-navigate' as const

/**
 * Query key the Arena parent app sets on the integrations iframe URL (with `from=arena_v3`).
 * Sim uses its value as OAuth `callbackURL` so Better Auth returns the user to the parent page after linking.
 *
 * Must stay in sync with the Arena embed (`ARENA_V3_IFRAME_CALLBACK_URL_QUERY_PARAM`).
 */
export const ARENA_V3_IFRAME_CALLBACK_URL_QUERY_PARAM = 'callbackURL' as const

const ARENA_V3_FROM_QUERY_VALUE = 'arena_v3' as const

/**
 * Payload posted to {@linkcode window.parent} for Arena v3 iframe OAuth handoff.
 */
export interface ArenaV3ParentOAuthNavigateMessage {
  type: typeof ARENA_V3_PARENT_OAUTH_NAVIGATE_MESSAGE_TYPE
  url: string
}

/**
 * When `from=arena_v3` and {@linkcode ARENA_V3_IFRAME_CALLBACK_URL_QUERY_PARAM} is present with a valid `http:` / `https:` URL,
 * returns that URL for OAuth `callbackURL`. Otherwise returns `fallbackCallbackURL` unchanged.
 *
 * The resolved origin must appear in Better Auth `trustedOrigins` (see `ARENA_V3_OAUTH_CALLBACK_ORIGINS` / dev defaults in `lib/auth/auth.ts`) or the `/api/auth/oauth2/link` request returns 403.
 */
export function resolveOAuthCallbackURLForArenaV3Embed(fallbackCallbackURL: string): string {
  if (typeof window === 'undefined') return fallbackCallbackURL
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('from') !== ARENA_V3_FROM_QUERY_VALUE) return fallbackCallbackURL
    const raw = params.get(ARENA_V3_IFRAME_CALLBACK_URL_QUERY_PARAM)?.trim()
    if (!raw) return fallbackCallbackURL
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallbackCallbackURL
    return parsed.href
  } catch {
    return fallbackCallbackURL
  }
}

function isArenaV3OAuthParentDelegation(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (window.parent === window) return false
    return new URLSearchParams(window.location.search).get('from') === ARENA_V3_FROM_QUERY_VALUE
  } catch {
    return false
  }
}

function postArenaV3OAuthNavigateToParent(url: string): void {
  const payload: ArenaV3ParentOAuthNavigateMessage = {
    type: ARENA_V3_PARENT_OAUTH_NAVIGATE_MESSAGE_TYPE,
    url,
  }
  window.parent.postMessage(payload, '*')
}

async function fetchOAuth2LinkAuthorizeUrl(
  providerId: string,
  callbackURL: string
): Promise<string> {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const response = await fetch(`${origin}/api/auth/oauth2/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ providerId, callbackURL }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Failed to start OAuth link (${response.status})`)
  }

  const data = (await response.json()) as { url?: string }
  if (!data.url || typeof data.url !== 'string') {
    throw new Error('OAuth link response missing authorization URL')
  }
  return data.url
}

/**
 * Query key factory for OAuth connection queries.
 * Provides hierarchical cache keys for connections and provider-specific accounts.
 */
export const oauthConnectionsKeys = {
  all: ['oauthConnections'] as const,
  connections: () => [...oauthConnectionsKeys.all, 'connections'] as const,
  accounts: () => [...oauthConnectionsKeys.all, 'accounts'] as const,
  account: (provider: string) => [...oauthConnectionsKeys.accounts(), provider] as const,
}

/** OAuth service with connection status and linked accounts. */
export interface ServiceInfo extends OAuthServiceConfig {
  id: string
  isConnected: boolean
  lastConnected?: string
  accounts?: OAuthAccountSummary[]
}

type OAuthConnectionResponse = OAuthConnection

function defineServices(): ServiceInfo[] {
  const servicesList: ServiceInfo[] = []

  Object.entries(OAUTH_PROVIDERS).forEach(([_providerKey, provider]) => {
    Object.entries(provider.services).forEach(([serviceKey, service]) => {
      servicesList.push({
        ...service,
        id: serviceKey,
        isConnected: false,
        scopes: service.scopes || [],
      })
    })
  })

  return servicesList
}

/**
 * Resolves the service catalog merged with the caller's connections.
 *
 * A failed request resolves with the bare catalog rather than rejecting, so
 * consumers keep correct service names and ids when the merge data is
 * unavailable. The cost is that `isConnected`/`accounts` then report *unknown*
 * as *disconnected*, which the result cannot distinguish. Read connection
 * state from the workspace credentials query (`useWorkspaceCredentials`), which
 * surfaces its own errors; a consumer that must branch on `isConnected` here
 * needs this fallback removed first, or it will tell a connected user they are
 * not.
 */
async function fetchOAuthConnections(signal?: AbortSignal): Promise<ServiceInfo[]> {
  try {
    const serviceDefinitions = defineServices()

    const data = await requestJson(listOAuthConnectionsContract, { signal })
    const connections = data.connections || []

    const updatedServices = serviceDefinitions.map((service) => {
      const connection = connections.find(
        (conn: OAuthConnectionResponse) => conn.provider === service.providerId
      )

      if (connection) {
        return {
          ...service,
          isConnected: (connection.accounts?.length ?? 0) > 0,
          accounts: connection.accounts || [],
          lastConnected: connection.lastConnected,
        }
      }

      const connectionWithScopes = connections.find((conn: OAuthConnectionResponse) => {
        if (!conn.baseProvider || !service.providerId.startsWith(conn.baseProvider)) {
          return false
        }

        if (conn.scopes && service.scopes) {
          const connScopes = conn.scopes
          return service.scopes.every((scope) => connScopes.includes(scope))
        }

        return false
      })

      if (connectionWithScopes) {
        return {
          ...service,
          isConnected: (connectionWithScopes.accounts?.length ?? 0) > 0,
          accounts: connectionWithScopes.accounts || [],
          lastConnected: connectionWithScopes.lastConnected,
        }
      }

      return service
    })

    return updatedServices
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return defineServices()
    }
    logger.error('Error fetching OAuth connections:', error)
    return defineServices()
  }
}

/**
 * Fetches all OAuth service connections with their status.
 * Returns service definitions merged with connection data.
 */
export function useOAuthConnections() {
  return useQuery({
    queryKey: oauthConnectionsKeys.connections(),
    queryFn: ({ signal }) => fetchOAuthConnections(signal),
    staleTime: OAUTH_CONNECTIONS_STALE_TIME,
    retry: false,
  })
}

interface ConnectServiceParams {
  providerId: string
  callbackURL: string
  draftId?: string
}

/**
 * Initiates OAuth connection flow for a service.
 * Redirects the user to the provider's authorization page.
 */
export function useConnectOAuthService() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      providerId,
      callbackURL: callerCallbackURL,
      draftId,
    }: ConnectServiceParams) => {
      const callbackURL = resolveOAuthCallbackURLForArenaV3Embed(callerCallbackURL)
      const delegateToParent = isArenaV3OAuthParentDelegation()
      const origin = typeof window !== 'undefined' ? window.location.origin : ''

      if (providerId === 'trello') {
        const returnUrl = encodeURIComponent(callbackURL)
        const draftQuery = draftId ? `&draftId=${encodeURIComponent(draftId)}` : ''
        const url = `${origin}/api/auth/trello/authorize?returnUrl=${returnUrl}${draftQuery}`
        if (delegateToParent) {
          postArenaV3OAuthNavigateToParent(url)
        } else {
          window.location.href = url
        }
        return { success: true }
      }

      if (providerId === 'instagram') {
        const returnUrl = encodeURIComponent(callbackURL)
        const draftQuery = draftId ? `&draftId=${encodeURIComponent(draftId)}` : ''
        window.location.href = `/api/auth/instagram/authorize?returnUrl=${returnUrl}${draftQuery}`
        return { success: true }
      }

      if (providerId === 'shopify') {
        const returnUrl = encodeURIComponent(callbackURL)
        const draftQuery = draftId ? `&draftId=${encodeURIComponent(draftId)}` : ''
        const url = `${origin}/api/auth/shopify/authorize?returnUrl=${returnUrl}${draftQuery}`
        if (delegateToParent) {
          postArenaV3OAuthNavigateToParent(url)
        } else {
          window.location.href = url
        }
        return { success: true }
      }

      if (requiresCustomOAuthApp(providerId)) {
        const returnCtx = readOAuthReturnContext()
        const workspaceId = returnCtx?.workspaceId
        if (!workspaceId) {
          throw new Error('Workspace context is required to connect this integration')
        }
        const url = new URL(`${origin}/api/auth/oauth2/custom/${providerId}/authorize`)
        url.searchParams.set('workspaceId', workspaceId)
        url.searchParams.set('returnUrl', callbackURL)
        if (delegateToParent) {
          postArenaV3OAuthNavigateToParent(url.toString())
        } else {
          window.location.href = url.toString()
        }
        return { success: true }
      }

      if (providerId === 'unipile_linkedin') {
        const returnCtx = readOAuthReturnContext()
        // boundary-raw-fetch: Unipile hosted auth returns a redirect URL, not JSON-API data
        const response = await fetch(`${origin}/api/auth/unipile/hosted/link`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callbackURL,
            workspaceId: returnCtx?.workspaceId,
            credentialId:
              returnCtx?.reconnect && returnCtx.credentialId ? returnCtx.credentialId : undefined,
          }),
        })
        const data = (await response.json().catch(() => ({}))) as {
          url?: string
          error?: string
        }
        if (!response.ok || !data.url) {
          throw new Error(data.error || 'Failed to start LinkedIn (Unipile) connection')
        }
        if (delegateToParent) {
          postArenaV3OAuthNavigateToParent(data.url)
        } else {
          window.location.href = data.url
        }
        return { success: true }
      }

      if (delegateToParent) {
        const url = await fetchOAuth2LinkAuthorizeUrl(providerId, callbackURL)
        postArenaV3OAuthNavigateToParent(url)
        logger.info('Delegated OAuth navigation to parent (Arena v3 iframe)', { providerId })
        return { success: true }
      }

      if (providerId === 'quickbooks') {
        if (!draftId) {
          throw new Error('QuickBooks authorization requires a credential connection draft.')
        }
        const authorizeUrl = new URL('/api/auth/oauth2/authorize', window.location.origin)
        authorizeUrl.searchParams.set('draftId', draftId)
        authorizeUrl.searchParams.set('callbackURL', callbackURL)
        window.location.href = authorizeUrl.toString()
        return { success: true }
      }

      const stateCallbackUrl = new URL(callbackURL)
      if (draftId) {
        stateCallbackUrl.searchParams.set(OAUTH_CREDENTIAL_DRAFT_CALLBACK_PARAM, draftId)
      }

      const scopes = getPerRequestOAuthLinkScopes(providerId)
      await client.oauth2.link({
        providerId,
        callbackURL: stateCallbackUrl.toString(),
        ...(scopes && { scopes }),
      })

      return { success: true }
    },
    onError: (error) => {
      logger.error('OAuth connection error:', error)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: oauthConnectionsKeys.connections() })
    },
  })
}

interface DisconnectServiceParams {
  provider: string
  providerId?: string
  serviceId: string
  accountId?: string
}

/**
 * Disconnects an OAuth service account.
 * Performs optimistic update and rolls back on failure.
 */
export function useDisconnectOAuthService() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ provider, providerId, accountId }: DisconnectServiceParams) => {
      return requestJson(disconnectOAuthContract, {
        body: {
          provider,
          providerId,
          accountId,
        },
      })
    },
    onMutate: async ({ serviceId, accountId }) => {
      await queryClient.cancelQueries({ queryKey: oauthConnectionsKeys.connections() })

      const previousServices = queryClient.getQueryData<ServiceInfo[]>(
        oauthConnectionsKeys.connections()
      )

      if (previousServices) {
        queryClient.setQueryData<ServiceInfo[]>(
          oauthConnectionsKeys.connections(),
          previousServices.map((svc) => {
            if (svc.id === serviceId) {
              const updatedAccounts =
                accountId && svc.accounts ? svc.accounts.filter((acc) => acc.id !== accountId) : []
              return {
                ...svc,
                accounts: updatedAccounts,
                isConnected: updatedAccounts.length > 0,
              }
            }
            return svc
          })
        )
      }

      return { previousServices }
    },
    onError: (_err, _variables, context) => {
      if (context?.previousServices) {
        queryClient.setQueryData(oauthConnectionsKeys.connections(), context.previousServices)
      }
      logger.error('Failed to disconnect service')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: oauthConnectionsKeys.connections() })
      queryClient.invalidateQueries({ queryKey: workspaceCredentialKeys.lists() })
      queryClient.invalidateQueries({ queryKey: workspaceCredentialKeys.details() })
      queryClient.invalidateQueries({ queryKey: OAUTH_CREDENTIALS_KEY })
      queryClient.invalidateQueries({ queryKey: environmentKeys.all })
    },
  })
}

/** Connected OAuth account for a specific provider. */
export type { ConnectedAccount }
