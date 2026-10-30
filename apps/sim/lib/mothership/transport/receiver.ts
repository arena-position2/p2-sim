import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { sleep } from '@sim/utils/helpers'
import { truncate } from '@sim/utils/string'
import { env } from '@/lib/core/config/env'
import { isMothershipBenchmarkEnabled } from '@/lib/core/config/env-flags'
import {
  SIM_CONTROL_KINDS,
  SIM_CONTROL_UNSUPPORTED,
  SimChannelBatchEnvelope,
  SimControlRequest,
  SimControlRequestHeader,
  type SimControlResult,
} from '@/lib/mothership/generated/sim-transport'
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
  while (!signal.aborted) {
    let phase: 'poll' | 'parse' | 'reply' = 'poll'
    try {
      const responsePromise = fetchGo(`${baseURL}/api/sim-transport/poll`, {
        method: 'POST',
        headers: mothershipRequestHeaders(),
        body: JSON.stringify({ channelId, accepts: SIM_CONTROL_KINDS }),
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
      phase = 'parse'
      const batch = SimChannelBatchEnvelope.parse(await response.json())
      const controls = batch.requests.flatMap((raw) => receiveControl(raw) ?? [])
      phase = 'reply'
      const replies = await Promise.allSettled(
        controls.map(async (control) => {
          signal.throwIfAborted()
          const result = await control.answer()
          const reply = await fetchGo(`${baseURL}/api/sim-transport/reply`, {
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
    } catch (error) {
      if (signal.aborted) return
      logger.warn('Sim transport disconnected; reconnecting', {
        phase,
        error: getErrorMessage(error),
      })
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
 * is in flight long enough for the worker to register the channel. A fresh turn
 * passes `minRemainingMs` so a poll about to abort is replaced before the POST.
 *
 * Returns false when no poll registered in time. Callers must not send the chat
 * until this is true.
 */
export async function ensureSimReceiverForBaseURL(
  baseURL: string,
  options?: EnsureSimReceiverOptions
): Promise<boolean> {
  const connection = getSimConnection()
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
  if (
    isMothershipBenchmarkEnabled &&
    benchmarkUrl &&
    getSimConnection('checkpoint').mode === 'checkpoint'
  ) {
    const connection = getSimConnection('checkpoint')
    if (connection.mode === 'checkpoint' && !receivers.has(benchmarkUrl)) {
      startReceiver(benchmarkUrl, connection.channelId)
    }
  }
}
