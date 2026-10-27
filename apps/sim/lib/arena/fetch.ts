import { createLogger } from '@sim/logger'
import {
  type ArenaAuthMode,
  getAutomationArenaHeaders,
  getHumanArenaHeaders,
} from '@/lib/arena/auth'
import {
  arenaBackendBaseUrl,
  getArenaSysIdForUser,
  getHumanArenaAccessToken,
  refreshHumanArenaAccessToken,
} from '@/lib/arena/tokens'

const logger = createLogger('ArenaFetch')

export class ArenaAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArenaAuthError'
  }
}

function resolveArenaUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  const base = arenaBackendBaseUrl()
  return pathOrUrl.startsWith('/') ? `${base}${pathOrUrl}` : `${base}/${pathOrUrl}`
}

export type ArenaSolFetchOptions = {
  mode: ArenaAuthMode
  /** Sim user id — human SSO owner, or workflow owner for automation sysId lookup. */
  userId: string
  pathOrUrl: string
  init?: RequestInit
  workflowId?: string
  executionId?: string
}

/**
 * Fetch Arena (sol) with either human SSO Authorisation or automation service headers.
 * Automation never falls back to human JWTs. Human path refreshes once on 401.
 */
export async function arenaSolFetch(options: ArenaSolFetchOptions): Promise<Response> {
  const url = resolveArenaUrl(options.pathOrUrl)
  const init = options.init ?? {}

  if (options.mode === 'automation') {
    const arenaSysId = await getArenaSysIdForUser(options.userId)
    if (!arenaSysId) {
      throw new ArenaAuthError(
        'Workflow owner has no Arena sysId — owner must sign in via Arena SSO once'
      )
    }

    let headers: Record<string, string>
    try {
      headers = getAutomationArenaHeaders({
        actingUserSysId: arenaSysId,
        workflowId: options.workflowId,
        executionId: options.executionId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ArenaAuthError(message)
    }

    const requestHeaders = new Headers(init.headers)
    for (const [key, value] of Object.entries(headers)) {
      requestHeaders.set(key, value)
    }
    // Never send human Authorisation on automation runs
    requestHeaders.delete('authorisation')
    requestHeaders.delete('authorization')
    requestHeaders.delete('Authorization')

    const response = await fetch(url, {
      ...init,
      headers: requestHeaders,
      cache: init.cache ?? 'no-store',
    })

    if (response.status === 401 || response.status === 403) {
      logger.error('Arena automation call unauthorized', {
        status: response.status,
        userId: options.userId,
        workflowId: options.workflowId,
      })
      throw new ArenaAuthError(
        `Arena automation rejected the request (${response.status}) — check ARENA_SERVICE_KEY and acting user link`
      )
    }

    return response
  }

  let accessToken = await getHumanArenaAccessToken(options.userId)
  if (!accessToken) {
    throw new ArenaAuthError('Arena token not found for user — reconnect via Arena SSO')
  }

  const headers = new Headers(init.headers)
  for (const [key, value] of Object.entries(getHumanArenaHeaders(accessToken))) {
    headers.set(key, value)
  }

  let response = await fetch(url, { ...init, headers, cache: init.cache ?? 'no-store' })
  if (response.status !== 401) {
    return response
  }

  logger.info('Arena human request returned 401; refreshing access token', {
    userId: options.userId,
  })
  accessToken = await refreshHumanArenaAccessToken(options.userId)
  if (!accessToken) {
    throw new ArenaAuthError('Arena session expired — reconnect via Arena SSO')
  }

  for (const [key, value] of Object.entries(getHumanArenaHeaders(accessToken))) {
    headers.set(key, value)
  }
  response = await fetch(url, { ...init, headers, cache: init.cache ?? 'no-store' })
  return response
}
