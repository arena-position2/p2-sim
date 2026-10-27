import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { sleep } from '@sim/utils/helpers'
import { env } from '@/lib/core/config/env'
import { SimChannelBatch } from '@/lib/mothership/generated/sim-transport'
import { fetchGo } from '@/lib/mothership/request/go/fetch'
import { mothershipRequestHeaders } from '@/lib/mothership/request/headers'
import { getMothershipBaseURL } from '@/lib/mothership/server/agent-url'
import { getSimConnection } from '@/lib/mothership/transport/connection'
import { executeSimControl } from '@/lib/mothership/transport/control'

const logger = createLogger('MothershipTransportReceiver')
const receivers = new Map<string, AbortController>()
/** Resolves once this base URL's first poll request is in flight (or was already). */
const receiverReady = new Map<string, Promise<void>>()
let stopHandlersInstalled = false

/**
 * Idle channels long-poll for up to 30s, so readiness cannot wait for the first
 * poll body. Waiting this long after starting the poll fetch is enough for the
 * request to be registered on the worker before chat stamps `simConnection`.
 */
const POLL_REGISTER_GRACE_MS = 750

export async function receiveSimControls(
  baseURL: string,
  channelId: string,
  signal: AbortSignal,
  options?: { onFirstPollStarted?: () => void }
): Promise<void> {
  let announcedFirstPoll = false
  while (!signal.aborted) {
    try {
      const responsePromise = fetchGo(`${baseURL}/api/sim-transport/poll`, {
        method: 'POST',
        headers: mothershipRequestHeaders(),
        body: JSON.stringify({ channelId }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: 'error',
        spanName: 'sim → worker transport poll',
        operation: 'sim_transport_poll',
      })
      if (!announcedFirstPoll) {
        announcedFirstPoll = true
        options?.onFirstPollStarted?.()
      }
      const response = await responsePromise
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Transport poll refused (HTTP ${response.status})`)
      }
      const batch = SimChannelBatch.parse(await response.json())
      const replies = await Promise.allSettled(
        batch.requests.map(async (request) => {
          signal.throwIfAborted()
          const result = await executeSimControl(request)
          const reply = await fetchGo(`${baseURL}/api/sim-transport/reply`, {
            method: 'POST',
            headers: mothershipRequestHeaders(),
            body: JSON.stringify({ channelId, id: request.id, result }),
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            spanName: 'sim → worker transport reply',
            operation: 'sim_transport_reply',
          })
          await reply.body?.cancel()
          if (!reply.ok && reply.status !== 410)
            throw new Error(`Transport reply refused (HTTP ${reply.status})`)
        })
      )
      const failed = replies.find((reply) => reply.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    } catch (error) {
      if (signal.aborted) return
      logger.warn('Sim transport disconnected; reconnecting', { error: getErrorMessage(error) })
      await sleep(1000)
    }
  }
}

function installStopHandlers(): void {
  if (stopHandlersInstalled) return
  stopHandlersInstalled = true
  const stop = () => {
    for (const active of receivers.values()) active.abort()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

/**
 * Starts the outbound poller for this worker if needed, then waits until the
 * first poll is in flight long enough for the worker to register the channel.
 * Chat must not stamp `checkpoint` before that — otherwise Go 500s, Sim retries
 * as a reattach/resume, and the user sees "Run not found".
 */
export async function ensureSimReceiverForBaseURL(baseURL: string): Promise<void> {
  const connection = getSimConnection()
  if (connection.mode !== 'checkpoint' || !env.COPILOT_API_KEY) return

  const existingReady = receiverReady.get(baseURL)
  if (existingReady) {
    await existingReady
    return
  }

  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  receiverReady.set(baseURL, ready)

  const controller = new AbortController()
  receivers.set(baseURL, controller)
  logger.info('Starting outbound Sim transport receiver', { baseURL })
  installStopHandlers()

  let firstPollStarted = false
  void receiveSimControls(baseURL, connection.channelId, controller.signal, {
    onFirstPollStarted: () => {
      firstPollStarted = true
      void sleep(POLL_REGISTER_GRACE_MS).then(resolveReady)
    },
  }).finally(() => {
    // A permanent exit (abort) drops readiness so a later chat can restart.
    if (controller.signal.aborted) {
      receivers.delete(baseURL)
      receiverReady.delete(baseURL)
    }
  })

  // If the loop errors before the first poll is scheduled, do not block chat forever.
  void sleep(5_000).then(() => {
    if (!firstPollStarted) {
      logger.warn('Outbound Sim transport poll did not start in time; continuing', { baseURL })
      resolveReady()
    }
  })

  await ready
}

export async function startSimReceivers(): Promise<void> {
  if (!env.COPILOT_API_KEY || getSimConnection().mode !== 'checkpoint') return
  const endpoints = [
    await getMothershipBaseURL(),
    env.COPILOT_DEV_URL,
    env.COPILOT_STAGING_URL,
    env.COPILOT_PROD_URL,
  ]
  await Promise.all(
    endpoints
      .filter((endpoint): endpoint is string => Boolean(endpoint))
      .map((endpoint) => ensureSimReceiverForBaseURL(endpoint))
  )
}
