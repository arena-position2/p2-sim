import { mothershipErrorText } from '@/lib/mothership/chat/error-tag'
import { isExplicitStopReason } from '@/lib/mothership/request/session/abort-reason'
import type { PersistedStreamEventEnvelope } from '@/lib/mothership/request/session/contract'
import type { StreamLoopContext } from '@/app/workspace/[workspaceId]/home/hooks/stream/stream-context'
import { setLocalLiveStatus } from '@/local-copilot/lib/client/local-live-status'

type ErrorEvent = Extract<PersistedStreamEventEnvelope, { type: 'error' }>

/**
 * The inline error tag is folded into the model by `reduceEvent` (scoped to the
 * erroring lane). This handler owns the side effects: flag the stream error and
 * surface the message, then flush the serialized snapshot.
 */
export function handleErrorEvent(ctx: StreamLoopContext, parsed: ErrorEvent): void {
  const { state, ops, deps } = ctx
  const message = parsed.payload.message || parsed.payload.error
  if (isExplicitStopReason(message)) return
  state.sawStreamError = true
  state.liveStatus = undefined
  setLocalLiveStatus(undefined)
  deps.setError(mothershipErrorText(parsed.payload) ?? 'An error occurred')
  ops.flush()
}
