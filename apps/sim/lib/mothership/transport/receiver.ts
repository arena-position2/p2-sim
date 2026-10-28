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

/**
 * One outbound poller. Readiness is not a one-shot promise: the worker only
 * treats the channel as registered while a poll request is actually in flight.
 * A resolved promise from the first turn stays true through reconnect sleeps
 * and dead sockets, and the next chat then stamps `checkpoint` against a
 * channel the worker has already dropped.
 */
interface OutboundReceiver {
  controller: AbortController
  pollInFlight: boolean
  pollStartedAt: number
  generation: number
  /** Generation whose register grace elapsed while that poll was still in flight. */
  registeredGeneration: number
  waiters: Array<() => void>
}

const receivers = new Map<string, OutboundReceiver>()
let stopHandlersInstalled = false

/**
 * Idle channels long-poll for up to 30s, so readiness cannot wait for the first
 * poll body. Waiting this long after starting the poll fetch is enough for the
 * request to be registered on the worker before chat stamps `simConnection`.
 */
const POLL_REGISTER_GRACE_MS = 750
/** Matches the poll fetch timeout, plus slack so a live long-poll is still trusted. */
const POLL_TRUST_MS = 32_000
const POLL_READY_TIMEOUT_MS = 5_000

export async function receiveSimControls(
  baseURL: string,
  channelId: string,
  signal: AbortSignal,
  options?: { onPollStarted?: () => void; onPollSettled?: () => void }
): Promise<void> {
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
      options?.onPollStarted?.()
      let response: Response
      try {
        response = await responsePromise
      } finally {
        options?.onPollSettled?.()
      }
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
    for (const active of receivers.values()) active.controller.abort()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

function pollIsRegistered(state: OutboundReceiver): boolean {
  return (
    state.pollInFlight &&
    state.registeredGeneration === state.generation &&
    Date.now() - state.pollStartedAt < POLL_TRUST_MS
  )
}

function waitForRegisteredPoll(state: OutboundReceiver): Promise<void> {
  if (pollIsRegistered(state)) return Promise.resolve()
  return new Promise((resolve) => {
    state.waiters.push(resolve)
  })
}

/** True once a poll has been in flight through the register grace. False on timeout. */
async function waitForLivePoll(state: OutboundReceiver): Promise<boolean> {
  if (pollIsRegistered(state)) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      waitForRegisteredPoll(state).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), POLL_READY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function startReceiver(baseURL: string, channelId: string): OutboundReceiver {
  const controller = new AbortController()
  const state: OutboundReceiver = {
    controller,
    pollInFlight: false,
    pollStartedAt: 0,
    generation: 0,
    registeredGeneration: 0,
    waiters: [],
  }
  receivers.set(baseURL, state)
  logger.info('Starting outbound Sim transport receiver', { baseURL })
  installStopHandlers()
  void receiveSimControls(baseURL, channelId, controller.signal, {
    onPollStarted: () => {
      state.pollInFlight = true
      state.pollStartedAt = Date.now()
      state.generation += 1
      const generation = state.generation
      void sleep(POLL_REGISTER_GRACE_MS).then(() => {
        if (!state.pollInFlight || state.generation !== generation) return
        state.registeredGeneration = generation
        const pending = state.waiters.splice(0)
        for (const resolve of pending) resolve()
      })
    },
    onPollSettled: () => {
      state.pollInFlight = false
    },
  }).finally(() => {
    // A permanent exit drops this poller only. A replacement may already own the slot.
    if (controller.signal.aborted && receivers.get(baseURL) === state) {
      receivers.delete(baseURL)
    }
  })
  return state
}

/**
 * Starts the outbound poller for this worker if needed, then waits until a poll
 * is in flight long enough for the worker to register the channel. Every turn
 * waits, including after a disconnect: a sticky ready flag from the first poll
 * lets a later chat stamp `checkpoint` while the worker has dropped the channel.
 * Go then 500s, Sim retries as a reattach/resume, and the user sees "Run not found".
 */
export async function ensureSimReceiverForBaseURL(baseURL: string): Promise<void> {
  const connection = getSimConnection()
  if (connection.mode !== 'checkpoint' || !env.COPILOT_API_KEY) return

  let state = receivers.get(baseURL)
  if (
    state &&
    !state.controller.signal.aborted &&
    state.pollInFlight &&
    state.pollStartedAt > 0 &&
    Date.now() - state.pollStartedAt >= POLL_TRUST_MS
  ) {
    state.controller.abort()
    if (receivers.get(baseURL) === state) receivers.delete(baseURL)
    state = undefined
  }
  if (!state || state.controller.signal.aborted) {
    state = startReceiver(baseURL, connection.channelId)
  }

  const live = await waitForLivePoll(state)
  if (!live) {
    logger.warn('Outbound Sim transport poll did not start in time; continuing', { baseURL })
  }
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
    endpoints.filter((endpoint): endpoint is string => Boolean(endpoint)).map((endpoint) =>
      ensureSimReceiverForBaseURL(endpoint)
    )
  )
}
