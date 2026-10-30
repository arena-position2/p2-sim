'use client'

import { useEffect } from 'react'
import { createLogger } from '@sim/logger'
import { normalizeEmail } from '@sim/utils/string'
import { useSession } from '@/lib/auth/client'
import { useTheme } from '@/app/_shell/providers/theme-provider'

const logger = createLogger('ArenaThemeSync')

/**
 * Applies arena-driven theme updates for the signed-in user only.
 *
 * Isolated from general settings: does not refetch, invalidate, or mutate
 * React Query settings state — only updates the document theme (`sim-theme`).
 */
export function ArenaThemeSync() {
  const { data: session } = useSession()
  const { setTheme } = useTheme()
  const sessionEmail = session?.user?.email

  useEffect(() => {
    if (!sessionEmail) return

    const eventSource = new EventSource('/api/users/me/settings/arena/events')

    eventSource.addEventListener('theme_changed', (event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return

      try {
        const payload = JSON.parse(event.data) as {
          emailId?: string
          theme?: 'system' | 'light' | 'dark'
        }

        if (!payload.emailId || !payload.theme) return
        if (normalizeEmail(payload.emailId) !== normalizeEmail(sessionEmail)) return

        setTheme(payload.theme)
      } catch (error) {
        logger.warn('Failed to apply arena theme event', { error })
      }
    })

    eventSource.onerror = () => {
      logger.warn('Arena theme SSE connection error')
    }

    return () => {
      eventSource.close()
    }
  }, [sessionEmail, setTheme])

  return null
}
