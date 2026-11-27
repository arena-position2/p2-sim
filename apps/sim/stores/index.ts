'use client'

import { createLogger } from '@sim/logger'
import { stopAllDesktopTools } from '@/app/workspace/[workspaceId]/home/hooks/desktop-tool-lifetimes'
import { useSettingsDirtyStore } from '@/stores/settings/dirty/store'

const logger = createLogger('Stores')

export const RECENT_IMPERSONATIONS_STORAGE_KEY = 'recent-impersonations'

/**
 * Device-scoped flag for the one-time Better Auth cookie Domain migration.
 * Survives identity boundaries (`clearUserData`): wiping it re-runs the Arena
 * session cookie-scope migration, which clears session cookies and SSO-resumes
 * as the hub user — undoing admin impersonation.
 * Bump the suffix when a new clear pass is required in production.
 */
export const AUTH_SESSION_COOKIE_SCOPE_MIGRATION_KEY = 'sim_auth_session_cookie_scope_migration_v3'

/** Why desktop tools still running for the previous identity were cancelled. */
const SIGNED_OUT_ABORT_REASON = 'identity_boundary:clearUserData'

interface ClearUserDataOptions {
  preserveRecentImpersonations?: boolean
}

/**
 * Clears browser and in-memory data at an authenticated identity boundary.
 * Returns whether the in-memory reset completed, so SPA callers can fall back
 * to a full document navigation when the reset chunk is unavailable.
 */
export async function clearUserData(options: ClearUserDataOptions = {}): Promise<boolean> {
  if (typeof window === 'undefined') return true

  let cleanupFailed = false
  let inMemoryResetSucceeded = true

  stopAllDesktopTools(SIGNED_OUT_ABORT_REASON)

  try {
    const keysToKeep = [
      'next-favicon',
      'sim-theme',
      'sim-landing-theme',
      AUTH_SESSION_COOKIE_SCOPE_MIGRATION_KEY,
      ...(options.preserveRecentImpersonations ? [RECENT_IMPERSONATIONS_STORAGE_KEY] : []),
    ]
    const keysToRemove = Object.keys(localStorage).filter((key) => !keysToKeep.includes(key))
    keysToRemove.forEach((key) => localStorage.removeItem(key))
  } catch (error) {
    cleanupFailed = true
    logger.error('Error clearing local user data:', { error })
  }

  try {
    sessionStorage.clear()
  } catch (error) {
    cleanupFailed = true
    logger.error('Error clearing tab-scoped user data:', { error })
  }

  try {
    const { resetAllStores } = await import('@/stores/reset-all-stores')
    await resetAllStores()
  } catch (error) {
    cleanupFailed = true
    inMemoryResetSucceeded = false
    logger.error('Error resetting in-memory user data:', { error })
  }

  if (!cleanupFailed) logger.info('User data cleared successfully')
  useSettingsDirtyStore.getState().reset()
  return inMemoryResetSucceeded
}
