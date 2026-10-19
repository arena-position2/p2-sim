import { createLogger } from '@sim/logger'
import { generateShortId } from '@sim/utils/id'
import { auth } from '@/lib/auth'
import { normalizeAud } from '@/lib/auth/arena-sso-path'
import { env, getEnv } from '@/lib/core/config/env'
import { getBaseUrl, getInternalApiBaseUrl } from '@/lib/core/utils/urls'

export { normalizeAud, sanitizeReturnPath } from '@/lib/auth/arena-sso-path'

const logger = createLogger('ArenaSso')

const ONE_TIME_TOKEN_IDENTIFIER_PREFIX = 'one-time-token:'
const HANDOFF_TOKEN_LENGTH = 32
/** Short TTL — redeem → verify happens in the same request. */
const HANDOFF_TOKEN_TTL_MS = 60 * 1000
const ARENA_SSO_SESSION_USER_AGENT = 'Arena Redirect SSO'

export type ArenaSsoRedeemResult = {
  email: string
  sysId?: string
  id?: string
  /** Short-lived Arena access JWT (redeem field name: `token`). */
  token?: string
  accessToken?: string
  /** Opaque rotating refresh token — persist encrypted at rest. */
  refreshToken?: string
}

function solBackendBaseUrl(): string {
  const fromServer = env.ARENA_BACKEND_BASE_URL?.trim()
  const fromPublic = getEnv('NEXT_PUBLIC_ARENA_BACKEND_BASE_URL')?.trim()
  const base = fromServer || fromPublic
  if (!base) {
    throw new Error('ARENA_BACKEND_BASE_URL is not configured')
  }
  return base.replace(/\/$/, '')
}

function simApiSecret(): string {
  const secret = env.SIM_APIS_SECRET_KEY?.trim() || getEnv('SIM_APIS_SECRET_KEY')?.trim()
  if (!secret) {
    throw new Error('SIM_APIS_SECRET_KEY is not configured')
  }
  return secret
}

/**
 * Redeems an opaque Arena SSO code against sol. Never logs the raw code.
 */
export async function redeemArenaSsoCode(code: string, aud: string): Promise<ArenaSsoRedeemResult> {
  const response = await fetch(`${solBackendBaseUrl()}/sol/v2/sso/redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sim-Api-Key': simApiSecret(),
    },
    body: JSON.stringify({ code, aud: normalizeAud(aud) }),
    cache: 'no-store',
  })

  if (!response.ok) {
    logger.warn('SSO redeem failed', { status: response.status })
    throw new Error(`SSO redeem failed with status ${response.status}`)
  }

  const payload = (await response.json()) as ArenaSsoRedeemResult
  if (!payload?.email) {
    throw new Error('SSO redeem returned no email')
  }
  if (!payload.token && !payload.accessToken) {
    logger.warn('SSO redeem returned no access token')
  }
  if (!payload.refreshToken) {
    logger.warn('SSO redeem returned no refresh token')
  }
  if (!payload.sysId && !payload.id) {
    logger.warn(
      'SSO redeem returned no Arena sysId — automation acting-user will fail until linked'
    )
  }
  return payload
}

/**
 * Creates a Better Auth session for the user and a one-time token that verify
 * will exchange for signed session cookies (same pattern as desktop handoff).
 */
export async function createArenaSsoHandoffToken(userId: string): Promise<string> {
  const ctx = await auth.$context
  const session = await ctx.internalAdapter.createSession(userId, false, {
    userAgent: ARENA_SSO_SESSION_USER_AGENT,
  })

  const token = generateShortId(HANDOFF_TOKEN_LENGTH)
  await ctx.internalAdapter.createVerificationValue({
    value: session.token,
    identifier: `${ONE_TIME_TOKEN_IDENTIFIER_PREFIX}${token}`,
    expiresAt: new Date(Date.now() + HANDOFF_TOKEN_TTL_MS),
  })

  logger.info('Minted Arena SSO handoff token', { userId, sessionId: session.id })
  return token
}

/**
 * Looks up an existing Sim user by email. Does not create users.
 */
export async function findSimUserIdByEmail(email: string): Promise<string | null> {
  const ctx = await auth.$context
  const found = await ctx.internalAdapter.findUserByEmail(email.trim().toLowerCase())
  if (!found) return null
  // better-auth may return { user } or the user row directly depending on version
  const user = 'user' in found ? found.user : found
  if (!user || typeof user !== 'object' || !('id' in user)) return null
  return String((user as { id: string }).id)
}

/**
 * Verifies a one-time token via Better Auth and returns Set-Cookie header values.
 */
export async function exchangeHandoffTokenForSetCookies(token: string): Promise<string[]> {
  const verifyUrl = `${getInternalApiBaseUrl()}/api/auth/one-time-token/verify`
  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    cache: 'no-store',
  })

  if (!response.ok) {
    logger.warn('SSO handoff verify failed', { status: response.status })
    throw new Error(`SSO handoff verify failed with status ${response.status}`)
  }

  const getSetCookie = response.headers.getSetCookie?.bind(response.headers)
  if (typeof getSetCookie === 'function') {
    return getSetCookie()
  }

  const single = response.headers.get('set-cookie')
  return single ? [single] : []
}

export function arenaSsoAudience(): string {
  return normalizeAud(getBaseUrl())
}
