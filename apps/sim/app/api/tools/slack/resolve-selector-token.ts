import { createLogger } from '@sim/logger'
import type { NextRequest } from 'next/server'
import { authorizeCredentialUse } from '@/lib/auth/credential-access'
import { getCredential, refreshAccessTokenIfNeeded } from '@/lib/oauth/credential-service'

const logger = createLogger('SlackSelectorToken')

export type SlackSelectorTokenKind = 'bot' | 'user'

export type SlackSelectorTokenResult =
  | {
      ok: true
      accessToken: string
      kind: SlackSelectorTokenKind
      credentialType: 'direct_bot' | 'oauth' | 'service_account'
      resolvedCredentialId?: string
    }
  | {
      ok: false
      status: number
      error: string
      authRequired?: boolean
    }

interface ResolveSlackSelectorTokenParams {
  request: NextRequest
  credential: string
  workflowId?: string
  useUserToken?: boolean
  requestId: string
}

/**
 * Resolves the Slack token a selector should call with.
 *
 * Custom Bot on a connected Slack OAuth account (`useUserToken`) uses the user
 * token (`idToken` / `xoxp-`). Sim Bot, pasted `xoxb-` tokens, and reusable
 * custom-bot service accounts use the bot token — those have no user token, so
 * `useUserToken` is ignored for them.
 */
export async function resolveSlackSelectorToken({
  request,
  credential,
  workflowId,
  useUserToken,
  requestId,
}: ResolveSlackSelectorTokenParams): Promise<SlackSelectorTokenResult> {
  if (credential.startsWith('xoxb-')) {
    logger.info('Using direct bot token for Slack selector')
    return { ok: true, accessToken: credential, kind: 'bot', credentialType: 'direct_bot' }
  }

  const authz = await authorizeCredentialUse(request, {
    credentialId: credential,
    workflowId,
  })
  if (!authz.ok || !authz.credentialOwnerUserId) {
    return { ok: false, status: 403, error: authz.error || 'Unauthorized' }
  }

  const credentialType = authz.credentialType === 'oauth' ? 'oauth' : 'service_account'
  const resolvedCredentialId = authz.resolvedCredentialId

  if (useUserToken && credentialType === 'oauth') {
    const accountRow = await getCredential(
      requestId,
      resolvedCredentialId || credential,
      authz.credentialOwnerUserId
    )
    const userToken = accountRow?.idToken?.trim()
    if (!userToken) {
      logger.warn('Custom Bot selector requested user token but idToken is missing', {
        credentialId: credential,
        userId: authz.credentialOwnerUserId,
      })
      return {
        ok: false,
        status: 401,
        error:
          'No user token found. Reconnect the Slack account with user-token permissions, or choose Arena Bot.',
        authRequired: true,
      }
    }
    logger.info('Using OAuth user token for Slack selector')
    return {
      ok: true,
      accessToken: userToken,
      kind: 'user',
      credentialType,
      resolvedCredentialId,
    }
  }

  const resolvedToken = await refreshAccessTokenIfNeeded(
    credential,
    authz.credentialOwnerUserId,
    requestId
  )
  if (!resolvedToken) {
    logger.error('Failed to get access token for Slack selector', {
      credentialId: credential,
      userId: authz.credentialOwnerUserId,
    })
    return {
      ok: false,
      status: 401,
      error: 'Could not retrieve access token',
      authRequired: true,
    }
  }

  logger.info(
    credentialType === 'oauth'
      ? 'Using OAuth bot token for Slack selector'
      : 'Using custom bot token for Slack selector'
  )
  return {
    ok: true,
    accessToken: resolvedToken,
    kind: 'bot',
    credentialType,
    resolvedCredentialId,
  }
}
