import { sleep } from '@sim/utils/helpers'

async function sleepUntilAbort(ms: number, abortSignal?: AbortSignal): Promise<'ok' | 'aborted'> {
  if (abortSignal?.aborted) return 'aborted'
  if (ms <= 0) return abortSignal?.aborted ? 'aborted' : 'ok'

  if (!abortSignal) {
    await sleep(ms)
    return 'ok'
  }

  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        onAbort = () => resolve()
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) {
      abortSignal.removeEventListener('abort', onAbort)
    }
  }

  return abortSignal.aborted ? 'aborted' : 'ok'
}

export type IdleStatusMergeEvent<T> =
  | { type: 'status'; message: string }
  | { type: 'item'; item: T }

/**
 * Interleaves rotating status messages with an async source.
 *
 * Does **not** emit an immediate status — callers publish phase copy first
 * (e.g. Proposing…). Fallback lines only appear after a quiet gap. Optional
 * `enrichMessages` can swap in a batch later (tool engagement when enabled).
 * Model-wait status prefers provider thinking deltas from the orchestrator.
 */
export async function* iterateWithIdleStatus<T>(options: {
  source: AsyncIterable<T>
  abortSignal?: AbortSignal
  messages: readonly string[]
  /** Delay before the first idle fallback status. Defaults to `intervalMs`. */
  idleMs?: number
  /** Delay between status lines while the source is quiet. */
  intervalMs?: number
  enrichMessages?: (abortSignal: AbortSignal) => Promise<readonly string[] | null>
}): AsyncGenerator<IdleStatusMergeEvent<T>, void, undefined> {
  const { abortSignal } = options
  const intervalMs = options.intervalMs ?? 4000
  const firstIdleMs = options.idleMs ?? intervalMs

  let messages = options.messages.filter((message) => message.trim().length > 0)
  if (messages.length === 0) {
    for await (const item of options.source) {
      if (abortSignal?.aborted) return
      yield { type: 'item', item }
    }
    return
  }

  const enrichController = new AbortController()
  const onParentAbort = () => enrichController.abort()
  abortSignal?.addEventListener('abort', onParentAbort, { once: true })

  let index = 0
  let pendingAiBatch: string[] | null = null
  let aiReadyResolve: (() => void) | undefined
  const aiReady = new Promise<void>((resolve) => {
    aiReadyResolve = resolve
  })
  let aiConsumed = !options.enrichMessages

  if (options.enrichMessages) {
    void options
      .enrichMessages(enrichController.signal)
      .then((next) => {
        if (next && next.length > 0) {
          pendingAiBatch = [...next]
        }
        aiReadyResolve?.()
      })
      .catch(() => {
        aiReadyResolve?.()
      })
  } else {
    aiReadyResolve?.()
  }

  const sourceIter = options.source[Symbol.asyncIterator]()
  let nextItem = sourceIter.next()
  let gapController = new AbortController()

  const restartGap = (delayMs: number) => {
    gapController.abort()
    gapController = new AbortController()
    const onAbort = () => gapController.abort()
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    const signal = gapController.signal
    const clearParent = () => abortSignal?.removeEventListener('abort', onAbort)
    return sleepUntilAbort(delayMs, signal).finally(clearParent)
  }

  // Wait for a quiet gap before any fallback — preserves phase status
  // (Proposing…) until thinking arrives or the model stays silent.
  let nextGap = restartGap(firstIdleMs)

  try {
    while (!abortSignal?.aborted) {
      const winner = await Promise.race([
        nextItem.then((result) => ({ side: 'source' as const, result })),
        nextGap.then((result) => ({ side: 'idle' as const, result })),
        !aiConsumed ? aiReady.then(() => ({ side: 'ai' as const })) : new Promise<never>(() => {}),
      ])

      if (winner.side === 'ai') {
        aiConsumed = true
        const aiMessages = (pendingAiBatch as string[] | null) ?? []
        if (aiMessages.length === 0) continue
        messages = aiMessages
        index = 0
        gapController.abort()
        yield { type: 'status', message: messages[index % messages.length]! }
        index += 1
        nextGap = restartGap(intervalMs)
        continue
      }

      if (winner.side === 'idle') {
        if (winner.result === 'aborted' || abortSignal?.aborted) {
          if (abortSignal?.aborted) return
          continue
        }
        const nextMessage = messages[index % messages.length]!
        // Single-line fallbacks (Thinking…) only need one pulse — repeating
        // the same string every interval flooded SSE/logs at the old 100ms rate.
        if (messages.length > 1 || index === 0) {
          yield { type: 'status', message: nextMessage }
        }
        index += 1
        nextGap = restartGap(intervalMs)
        continue
      }

      gapController.abort()

      if (winner.result.done) return

      yield { type: 'item', item: winner.result.value }
      nextItem = sourceIter.next()
      nextGap = restartGap(intervalMs)
    }
  } finally {
    gapController.abort()
    enrichController.abort()
    abortSignal?.removeEventListener('abort', onParentAbort)
  }
}
