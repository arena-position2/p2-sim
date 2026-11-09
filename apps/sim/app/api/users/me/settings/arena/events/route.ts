/**
 * SSE endpoint for arena theme updates.
 *
 * Pushes `theme_changed` to the authenticated user's open tabs when the
 * cron-authenticated PATCH `/api/users/me/settings/arena` updates their theme.
 * Auth is via session cookies (EventSource sends cookies automatically).
 */

import { createLogger } from '@sim/logger'
import type { NextRequest } from 'next/server'
import { arenaThemeEventsContract } from '@/lib/api/contracts/arena-events'
import { parseRequest } from '@/lib/api/server'
import { getSession } from '@/lib/auth'
import { SSE_HEADERS } from '@/lib/core/utils/sse'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { arenaThemePubSub } from '@/lib/users/arena-theme-pubsub'

export const dynamic = 'force-dynamic'

const logger = createLogger('ArenaThemeEventsSSE')
const HEARTBEAT_INTERVAL_MS = 30_000

export const GET = withRouteHandler(async (request: NextRequest) => {
  const session = await getSession()
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const parsed = await parseRequest(arenaThemeEventsContract, request, {})
  if (!parsed.success) return parsed.response

  const userId = session.user.id
  const encoder = new TextEncoder()
  const unsubscribers: Array<() => void> = []
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    for (const unsub of unsubscribers) {
      unsub()
    }
    logger.info('SSE connection closed', { userId })
  }

  const stream = new ReadableStream({
    start(controller) {
      const send = (eventName: string, data: Record<string, unknown>) => {
        if (cleaned) return
        try {
          controller.enqueue(
            encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
          )
        } catch {
          // Stream already closed
        }
      }

      if (arenaThemePubSub) {
        unsubscribers.push(
          arenaThemePubSub.onThemeChanged((event) => {
            if (event.userId !== userId) return
            send('theme_changed', {
              emailId: event.emailId,
              theme: event.theme,
            })
          })
        )
      }

      const heartbeat = setInterval(() => {
        if (cleaned) {
          clearInterval(heartbeat)
          return
        }
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, HEARTBEAT_INTERVAL_MS)
      unsubscribers.push(() => clearInterval(heartbeat))

      request.signal.addEventListener(
        'abort',
        () => {
          cleanup()
          try {
            controller.close()
          } catch {
            // Already closed
          }
        },
        { once: true }
      )

      logger.info('SSE connection opened', { userId })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
})
