import { db } from '@sim/db'
import { userArenaDetails } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { eq } from 'drizzle-orm'
import { env, getEnv } from '@/lib/core/config/env'
import { decryptSecret, encryptSecret } from '@/lib/core/security/encryption'

const logger = createLogger('ArenaTokens')

/** In-flight refresh coalescing per Sim user id. */
const refreshInFlight = new Map<string, Promise<string | null>>()

export function arenaBackendBaseUrl(): string {
  const fromServer = env.ARENA_BACKEND_BASE_URL?.trim()
  const fromPublic = getEnv('NEXT_PUBLIC_ARENA_BACKEND_BASE_URL')?.trim()
  const base = fromServer || fromPublic
  if (!base) {
    throw new Error('ARENA_BACKEND_BASE_URL is not configured')
  }
  return base.replace(/\/$/, '')
}

export type ArenaTokenPair = {
  accessToken: string
  refreshToken: string
}

/**
 * Normalizes Arena SSO redeem / refresh payloads that may use `token` or `accessToken`.
 */
export function parseArenaTokenPair(payload: unknown): ArenaTokenPair | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const accessToken =
    typeof record.accessToken === 'string'
      ? record.accessToken.trim()
      : typeof record.token === 'string'
        ? record.token.trim()
        : ''
  const refreshToken = typeof record.refreshToken === 'string' ? record.refreshToken.trim() : ''
  if (!accessToken || !refreshToken) return null
  return { accessToken, refreshToken }
}

export type PersistArenaSsoOptions = {
  accessToken: string
  refreshToken: string
  /** Arena user sysId from redeem — stored as arena_user_id_ref for automation acting-user. */
  arenaSysId?: string | null
}

/**
 * Persists interactive SSO access + encrypted refresh, and optionally the Arena sysId link.
 */
export async function persistArenaSsoTokens(
  userId: string,
  options: PersistArenaSsoOptions
): Promise<void> {
  const encryptedRefresh = (await encryptSecret(options.refreshToken)).encrypted
  const arenaSysId = options.arenaSysId?.trim() || undefined
  const patch: {
    arenaToken: string
    arenaRefreshToken: string
    arenaUserIdRef?: string
  } = {
    arenaToken: options.accessToken,
    arenaRefreshToken: encryptedRefresh,
  }
  if (arenaSysId) {
    patch.arenaUserIdRef = arenaSysId
  }

  const updated = await db
    .update(userArenaDetails)
    .set(patch)
    .where(eq(userArenaDetails.userIdRef, userId))
    .returning({ userIdRef: userArenaDetails.userIdRef })

  if (updated.length === 0) {
    await db.insert(userArenaDetails).values({
      userIdRef: userId,
      arenaToken: options.accessToken,
      arenaRefreshToken: encryptedRefresh,
      ...(arenaSysId ? { arenaUserIdRef: arenaSysId } : {}),
    })
  }

  logger.info('Persisted Arena SSO tokens', { userId, hasSysId: Boolean(arenaSysId) })
}

/** Links Sim user → Arena sysId for automation X-Acting-User-Id (does not touch tokens). */
export async function persistArenaSysId(userId: string, arenaSysId: string): Promise<void> {
  const sysId = arenaSysId.trim()
  if (!sysId) return

  const updated = await db
    .update(userArenaDetails)
    .set({ arenaUserIdRef: sysId })
    .where(eq(userArenaDetails.userIdRef, userId))
    .returning({ userIdRef: userArenaDetails.userIdRef })

  if (updated.length === 0) {
    await db.insert(userArenaDetails).values({
      userIdRef: userId,
      arenaUserIdRef: sysId,
    })
  }
  logger.info('Persisted Arena sysId link', { userId })
}

/** Clears interactive Arena SSO tokens (not arena_user_id_ref). */
export async function clearArenaSsoTokens(userId: string): Promise<void> {
  await db
    .update(userArenaDetails)
    .set({
      arenaToken: null,
      arenaRefreshToken: null,
    })
    .where(eq(userArenaDetails.userIdRef, userId))
  logger.info('Cleared Arena SSO tokens', { userId })
}

type StoredArenaCreds = {
  accessToken: string | null
  encryptedRefresh: string | null
  arenaSysId: string | null
}

async function loadStoredArenaCreds(userId: string): Promise<StoredArenaCreds | null> {
  const rows = await db
    .select({
      accessToken: userArenaDetails.arenaToken,
      encryptedRefresh: userArenaDetails.arenaRefreshToken,
      arenaSysId: userArenaDetails.arenaUserIdRef,
    })
    .from(userArenaDetails)
    .where(eq(userArenaDetails.userIdRef, userId))
    .limit(1)

  if (rows.length === 0) return null
  return {
    accessToken: rows[0].accessToken ?? null,
    encryptedRefresh: rows[0].encryptedRefresh ?? null,
    arenaSysId: rows[0].arenaSysId ?? null,
  }
}

/** Arena sysId for X-Acting-User-Id (must be set via SSO redeem). */
export async function getArenaSysIdForUser(userId: string): Promise<string | null> {
  const stored = await loadStoredArenaCreds(userId)
  const sysId = stored?.arenaSysId?.trim()
  return sysId || null
}

/**
 * Returns a usable Arena access JWT for interactive calls.
 * Refreshes via encrypted refresh when access is missing.
 */
export async function getHumanArenaAccessToken(userId: string): Promise<string | null> {
  const stored = await loadStoredArenaCreds(userId)
  if (!stored) return null
  if (stored.accessToken) return stored.accessToken
  if (stored.encryptedRefresh) return refreshHumanArenaAccessToken(userId)
  return null
}

export async function refreshHumanArenaAccessToken(userId: string): Promise<string | null> {
  const existing = refreshInFlight.get(userId)
  if (existing) return existing

  const promise = doRefreshHumanArenaAccessToken(userId).finally(() => {
    refreshInFlight.delete(userId)
  })
  refreshInFlight.set(userId, promise)
  return promise
}

async function doRefreshHumanArenaAccessToken(userId: string): Promise<string | null> {
  const stored = await loadStoredArenaCreds(userId)
  if (!stored?.encryptedRefresh) {
    logger.warn('Arena human refresh skipped: no refresh token', { userId })
    return null
  }

  let refreshToken: string
  try {
    refreshToken = (await decryptSecret(stored.encryptedRefresh)).decrypted
  } catch {
    logger.error('Arena refresh token decrypt failed', { userId })
    await clearArenaSsoTokens(userId)
    return null
  }

  try {
    const response = await fetch(`${arenaBackendBaseUrl()}/sol/v2/users/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    })

    if (!response.ok) {
      logger.warn('Arena refresh-token request failed', { userId, status: response.status })
      if (response.status === 401 || response.status === 403) {
        await clearArenaSsoTokens(userId)
      }
      return null
    }

    const pair = parseArenaTokenPair(await response.json())
    if (!pair) {
      logger.warn('Arena refresh-token returned incomplete payload', { userId })
      return null
    }

    await persistArenaSsoTokens(userId, {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      arenaSysId: stored.arenaSysId,
    })
    return pair.accessToken
  } catch (error) {
    logger.error('Arena refresh-token request errored', { userId, error })
    return null
  }
}
