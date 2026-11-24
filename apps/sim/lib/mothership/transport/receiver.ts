import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { interruptibleSleep, sleep } from '@sim/utils/helpers'
import { type BackoffOptions, backoffWithJitter } from '@sim/utils/retry'
import { truncate } from '@sim/utils/string'
import { env } from '@/lib/core/config/env'
import { isMothershipBenchmarkEnabled } from '@/lib/core/config/env-flags'
import {
  SIM_CONTROL_KINDS,
  SIM_CONTROL_UNSUPPORTED,
  SimChannelBatchEnvelope,
  type SimConnection,
  SimControlRequest,
  SimControlRequestHeader,
  type SimControlResult,
} from '@/lib/mothership/generated/sim-transport'
import { mothershipRequestHeaders } from '@/lib/mothership/request/headers'
import { fetchWorker } from '@/lib/mothership/request/worker/fetch'
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
  channelId: string
  pollInFlight: boolean
  pollStartedAt: number
  generation: number
  /** Generation whose register grace elapsed while that poll was still in flight. */
  registeredGeneration: number
  waiters: Array<() => void>
}

interface EnsureSimReceiverOptions {
  /**
   * A fresh chat turn needs this much of the long-poll left. A poll inside the
   * last few seconds still looks registered, then aborts, and the worker answers
   * the retry as a reattach with "Run not found".
   */
  minRemainingMs?: number
  /** Forces a transport mode. Benchmark receivers stay on checkpoint when Cloud uses direct. */
  mode?: SimConnection['mode']
}

const receivers = new Map<string, OutboundReceiver>()
let stopHandlersInstalled = false

/**
 * Idle channels long-poll for up to 30s, so readiness cannot wait for the first
 * poll body. Waiting this long after starting the poll fetch is enough for the
 * request to be registered on the worker before chat stamps `simConnection`.
 */
const POLL_REGISTER_GRACE_MS = 750
/** Idle channels long-poll for this long. The fetch timeout must match. */
const POLL_TIMEOUT_MS = 30_000
/** Matches the poll fetch timeout, plus slack so a live long-poll is still trusted. */
const POLL_TRUST_MS = POLL_TIMEOUT_MS + 2_000
const POLL_READY_TIMEOUT_MS = 5_000

/**
 * A lost connection or a worker deploy: retry within a second, slowing to 4 s, so with jitter a
 * healthy deployment is back inside the worker's 5 s run-control deadline.
 */
const TRANSIENT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 4000 }
/**
 * The worker rejected this deployment's key, which only an operator can fix: start at 30 s and
 * slow to 10 minutes, so a misconfigured deployment polls a few hundred times a day, not every
 * second, and still reconnects on its own once the key is accepted.
 */
const REFUSED_BACKOFF: BackoffOptions = { baseMs: 30_000, maxMs: 600_000 }

/** The worker refused this deployment's key (401/403), as opposed to failing to answer. */
class TransportKeyRefused extends Error {
  constructor(readonly status: number) {
    super(`Transport key refused (HTTP ${status})`)
  }
}

interface ReceivedControl {
  id: string
  answer: () => Promise<SimControlResult>
}

/** Each request parses alone, so one unknown or malformed request never costs its batch-mates. */
function receiveControl(raw: unknown): ReceivedControl | null {
  const request = SimControlRequest.safeParse(raw)
  if (request.success) return { id: request.data.id, answer: () => executeSimControl(request.data) }
  const header = SimControlRequestHeader.safeParse(raw)
  if (!header.success) {
    logger.warn('Unreadable Sim control request dropped')
    return null
  }
  const { id, operation } = header.data
  const kind = operation && truncate(operation.kind, 64)
  if (operation && !SIM_CONTROL_KINDS.some((known) => known === operation.kind)) {
    logger.warn('Unsupported Sim control kind', { kind })
    const body = JSON.stringify({ error: SIM_CONTROL_UNSUPPORTED, kind })
    return { id, answer: async () => ({ status: 501, body }) }
  }
  logger.warn('Invalid Sim control request', {
    kind,
    issues: request.error.issues.map((issue) => issue.path.join('.')),
  })
  return {
    id,
    answer: async () => ({
      status: 400,
      body: JSON.stringify({ error: 'Invalid Sim control request' }),
    }),
  }
}

export async function receiveSimControls(
  baseURL: string,
  channelId: string,
  signal: AbortSignal,
  options?: { onPollStarted?: () => void; onPollSettled?: () => void }
): Promise<void> {
  let failures = 0
  let outage: 'disconnected' | 'key_refused' | undefined
  while (!signal.aborted) {
    let phase: 'poll' | 'parse' | 'reply' = 'poll'
    try {
      const responsePromise = fetchWorker(`${baseURL}/api/sim-transport/poll`, {
        method: 'POST',
        headers: mothershipRequestHeaders(),
        body: JSON.stringify({ channelId, accepts: SIM_CONTROL_KINDS }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
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
        if (response.status === 401 || response.status === 403) {
          throw new TransportKeyRefused(response.status)
        }
        throw new Error(`Transport poll refused (HTTP ${response.status})`)
      }
      phase = 'parse'
      const batch = SimChannelBatchEnvelope.parse(await response.json())
      const controls = batch.requests.flatMap((raw) => receiveControl(raw) ?? [])
      phase = 'reply'
      const replies = await Promise.allSettled(
        controls.map(async (control) => {
          signal.throwIfAborted()
          const result = await control.answer()
          const reply = await fetchWorker(`${baseURL}/api/sim-transport/reply`, {
            method: 'POST',
            headers: mothershipRequestHeaders(),
            body: JSON.stringify({ channelId, id: control.id, result }),
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
      // Only a whole iteration (poll, batch, replies) ends an outage.
      if (outage) {
        logger.info('Sim transport reconnected')
        outage = undefined
      }
    } catch (error) {
      if (signal.aborted) return
      const keyRefused = error instanceof TransportKeyRefused
      const kind = keyRefused ? 'key_refused' : 'disconnected'
      // One line per outage, and again only when it changes kind, not one per retry.
      if (outage !== kind) {
        outage = kind
        failures = 0
        if (keyRefused) {
          logger.warn('Sim transport key refused by the worker; check COPILOT_API_KEY', {
            status: error.status,
          })
        } else {
          logger.warn('Sim transport disconnected; reconnecting', {
            phase,
            error: getErrorMessage(error),
          })
        }
      }
      failures++
      await interruptibleSleep(
        backoffWithJitter(failures, null, keyRefused ? REFUSED_BACKOFF : TRANSIENT_BACKOFF),
        signal
      )
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

function pollAgeMs(state: OutboundReceiver): number {
  if (state.pollStartedAt <= 0) return Number.POSITIVE_INFINITY
  return Date.now() - state.pollStartedAt
}

function pollHasRemainingLife(state: OutboundReceiver, minRemainingMs: number): boolean {
  return state.pollInFlight && pollAgeMs(state) < POLL_TIMEOUT_MS - minRemainingMs
}

function pollIsRegistered(state: OutboundReceiver, minRemainingMs = 0): boolean {
  return (
    state.pollInFlight &&
    state.registeredGeneration === state.generation &&
    pollAgeMs(state) < POLL_TRUST_MS &&
    (minRemainingMs <= 0 || pollHasRemainingLife(state, minRemainingMs))
  )
}

function waitForRegisteredPoll(state: OutboundReceiver, minRemainingMs: number): Promise<void> {
  if (pollIsRegistered(state, minRemainingMs)) return Promise.resolve()
  return new Promise((resolve) => {
    state.waiters.push(resolve)
  })
}

/** True once a poll has been in flight through the register grace. False on timeout. */
async function waitForLivePoll(state: OutboundReceiver, minRemainingMs = 0): Promise<boolean> {
  if (pollIsRegistered(state, minRemainingMs)) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      waitForRegisteredPoll(state, minRemainingMs).then(() =>
        pollIsRegistered(state, minRemainingMs)
      ),
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
    channelId,
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

function dropReceiver(baseURL: string, state: OutboundReceiver): void {
  state.controller.abort()
  if (receivers.get(baseURL) === state) receivers.delete(baseURL)
}

/**
 * Starts the outbound poller for this worker if needed, then waits until a poll
 * is in flight long enough for the worker to register the channel. Every turn
 * waits, including after a disconnect: a sticky ready flag from the first poll
 * lets a later chat stamp `checkpoint` while the worker has dropped the channel.
 * Go then 500s, Sim retries as a reattach, and the user sees "Run not found".
 *
 * Returns false when no poll registered in time. Callers must not send the chat
 * until this is true — continuing against a dead channel is what burns the turn.
 */
export async function ensureSimReceiverForBaseURL(
  baseURL: string,
  options?: EnsureSimReceiverOptions
): Promise<boolean> {
  const connection = getSimConnection(options?.mode)
  if (connection.mode !== 'checkpoint' || !env.COPILOT_API_KEY) return true

  const minRemainingMs = options?.minRemainingMs ?? 0
  let state = receivers.get(baseURL)
  const channelMismatch = Boolean(state && state.channelId !== connection.channelId)
  const expiring = Boolean(
    state &&
      minRemainingMs > 0 &&
      !state.controller.signal.aborted &&
      state.pollInFlight &&
      !pollHasRemainingLife(state, minRemainingMs)
  )
  const stale = Boolean(
    state &&
      !state.controller.signal.aborted &&
      state.pollInFlight &&
      pollAgeMs(state) >= POLL_TRUST_MS
  )
  if (state && (channelMismatch || expiring || stale)) {
    dropReceiver(baseURL, state)
    state = undefined
  }
  if (!state || state.controller.signal.aborted) {
    state = startReceiver(baseURL, connection.channelId)
  }

  const live = await waitForLivePoll(state, minRemainingMs)
  if (!live) {
    logger.warn('Outbound Sim transport poll did not register in time', { baseURL })
  }
  return live
}

export async function startSimReceivers(): Promise<void> {
  if (!env.COPILOT_API_KEY) return
  if (getSimConnection().mode === 'checkpoint') {
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
  const benchmarkUrl = env.MOTHERSHIP_BENCHMARK_URL ?? env.COPILOT_DEV_URL
  if (isMothershipBenchmarkEnabled && benchmarkUrl) {
    await ensureSimReceiverForBaseURL(benchmarkUrl, { mode: 'checkpoint' })
  }
}
