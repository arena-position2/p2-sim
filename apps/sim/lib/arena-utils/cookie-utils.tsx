'use client'
import Cookies from 'js-cookie'

const COOKIE_NAME = 'arena_token'

/**
 * Fetches a short-lived Arena access token for browser-side Arena API calls.
 * Does not persist the JWT in a cookie (legacy cookies are cleared if present).
 */
export async function getArenaToken(): Promise<string | null> {
  if (Cookies.get(COOKIE_NAME)) {
    Cookies.remove(COOKIE_NAME)
  }

  try {
    // boundary-raw-fetch: short-lived Arena access JWT for browser selectors; not a contract JSON shape
    const res = await fetch('/api/arena/token', { method: 'GET', cache: 'no-store' })
    if (!res.ok) {
      return null
    }

    const data = (await res.json()) as { found?: boolean; arenaToken?: string }
    if (data.found && data.arenaToken) {
      return data.arenaToken
    }

    return null
  } catch {
    return null
  }
}
