import {
  LOCAL_STATUS_PHASE,
  type PersistedStreamEventEnvelope,
} from '@/lib/mothership/request/session/contract'
import type { StreamLoopContext } from '@/app/workspace/[workspaceId]/home/hooks/stream/stream-context'
import { setLocalLiveStatus } from '@/local-copilot/lib/client/local-live-status'

type LocalStatusEvent = Extract<PersistedStreamEventEnvelope, { type: 'run' }> & {
  payload: { statusPhase: typeof LOCAL_STATUS_PHASE; message: string }
}

/**
 * Applies a Local Copilot synthetic status envelope to the in-flight turn.
 * Does not fold into the turn model / content blocks.
 */
export function handleLocalStatusEvent(ctx: StreamLoopContext, parsed: LocalStatusEvent): void {
  const message = parsed.payload.message.trim()
  if (!message) return
  ctx.state.liveStatus = message
  setLocalLiveStatus(message)
  ctx.ops.flush()
}

export function isLocalStatusEvent(
  parsed: PersistedStreamEventEnvelope
): parsed is LocalStatusEvent {
  return (
    parsed.type === 'run' &&
    typeof parsed.payload === 'object' &&
    parsed.payload !== null &&
    'statusPhase' in parsed.payload &&
    (parsed.payload as { statusPhase?: string }).statusPhase === LOCAL_STATUS_PHASE &&
    typeof (parsed.payload as { message?: unknown }).message === 'string'
  )
}
