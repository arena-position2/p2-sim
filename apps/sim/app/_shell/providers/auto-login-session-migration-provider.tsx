'use client'

import { type ReactNode, useEffect, useState } from 'react'
import { createLogger } from '@sim/logger'
import {
  ARENA_SSO_SESSION_REQUIRED_PATH,
  buildArenaSimResumeUrl,
} from '@/lib/auth/arena-sim-resume'
import { isLocalLoginEnabled } from '@/lib/core/config/env-flags'
import { AUTH_SESSION_COOKIE_SCOPE_MIGRATION_KEY } from '@/stores'

const logger = createLogger('AutoLoginSessionMigrationProvider')

/**
 * One-time clear of leftover Better Auth session cookies across host-only,
 * `Domain=<agent host>`, and parent `Domain=thearena.ai` scopes. Needed when
 * older deploys mixed cross-subdomain and host-only `__Secure-better-auth.*`
 * cookies (same name, two Domain scopes → redirect / logout loops).
 *
 * When the migration key is missing: clear cookies, mark the key (before any
 * redirect — otherwise SSO return would clear again), then re-authenticate via
 * Arena `/sso/sim-resume` (or `/login` when local login is enabled).
 *
 * Children mount only after migration is done when we stay on-page (already
 * migrated, or auth surface / failed resume). A successful resume navigates away.
 *
 * The key lives in {@link AUTH_SESSION_COOKIE_SCOPE_MIGRATION_KEY} so
 * `clearUserData` can preserve it across identity boundaries. Bump the key
 * suffix when a new clear pass is required in production.
 */

interface AutoLoginSessionMigrationProviderProps {
  children: ReactNode
}

function markMigrationDone(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(AUTH_SESSION_COOKIE_SCOPE_MIGRATION_KEY, '1')
  }
}

function isAuthSurfacePath(pathname: string): boolean {
  return (
    pathname.startsWith('/auth/arena-sso') ||
    pathname === '/session-required' ||
    pathname === '/login' ||
    pathname === '/signup'
  )
}

/**
 * Gates children until the one-time cookie-scope clear has completed (or was
 * already done). After a clear, redirects to Arena SSO resume, or `/login` when
 * local login is enabled, to mint a fresh session.
 */
export function AutoLoginSessionMigrationProvider({
  children,
}: AutoLoginSessionMigrationProviderProps) {
  const [ready, setReady] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(AUTH_SESSION_COOKIE_SCOPE_MIGRATION_KEY) === '1'
  })

  useEffect(() => {
    if (ready) return

    const run = async () => {
      try {
        // boundary-raw-fetch: Set-Cookie clear must hit same-origin; not a JSON contract
        const res = await fetch('/api/auth/clear-domain-session-cookies', {
          method: 'POST',
          credentials: 'include',
        })
        if (!res.ok) {
          logger.error('Session cookie scope migration clear failed', { status: res.status })
        }
      } catch (error) {
        logger.error('Session cookie scope migration clear failed', { error })
      }

      // Mark before re-auth so the post-SSO load does not wipe the new cookies.
      markMigrationDone()

      if (typeof window === 'undefined') {
        setReady(true)
        return
      }

      if (isAuthSurfacePath(window.location.pathname)) {
        setReady(true)
        return
      }

      if (isLocalLoginEnabled) {
        window.location.assign('/login')
        return
      }

      const resume = buildArenaSimResumeUrl(window.location.href, window.location.hostname)
      if (resume) {
        window.location.assign(resume.href)
        return
      }

      logger.warn('Arena SSO resume URL unavailable after cookie migration clear')
      window.location.assign(ARENA_SSO_SESSION_REQUIRED_PATH)
    }

    void run()
  }, [ready])

  if (!ready) {
    return null
  }

  return <>{children}</>
}
