import { ASYNC_TOOL_CONFIRMATION_STATUS } from '@/lib/mothership/async-runs/lifecycle'
import { upsertAsyncToolCall } from '@/lib/mothership/async-runs/repository'
import { waitForToolConfirmation } from '@/lib/mothership/persistence/tool-confirm'

export type LocalToolConfirmationDecision =
  | 'approved'
  | 'rejected'
  | 'timeout'
  | 'unavailable'
  | 'aborted'

const LOCAL_TOOL_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000

interface RequestLocalToolConfirmationParams {
  runId?: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  abortSignal?: AbortSignal
}

/**
 * Persists a pending tool call before its confirmation UI is emitted.
 */
export async function prepareLocalToolConfirmation(
  params: RequestLocalToolConfirmationParams
): Promise<boolean> {
  if (!params.runId || params.abortSignal?.aborted) return false
  try {
    const pending = await upsertAsyncToolCall({
      runId: params.runId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      args: params.args,
      status: 'pending',
    })
    return Boolean(pending)
  } catch {
    return false
  }
}

/**
 * Waits for the authenticated UI decision for a prepared tool call.
 */
export async function waitForLocalToolConfirmation(
  params: Pick<RequestLocalToolConfirmationParams, 'toolCallId' | 'abortSignal'>
): Promise<LocalToolConfirmationDecision> {
  if (params.abortSignal?.aborted) return 'aborted'
  try {
    const decision = await waitForToolConfirmation(
      params.toolCallId,
      LOCAL_TOOL_CONFIRMATION_TIMEOUT_MS,
      params.abortSignal,
      {
        acceptStatus: (status) =>
          status === ASYNC_TOOL_CONFIRMATION_STATUS.success ||
          status === ASYNC_TOOL_CONFIRMATION_STATUS.error ||
          status === ASYNC_TOOL_CONFIRMATION_STATUS.cancelled,
      }
    )

    if (params.abortSignal?.aborted) return 'aborted'
    if (!decision) return 'timeout'
    if (decision.status === ASYNC_TOOL_CONFIRMATION_STATUS.success) return 'approved'
    if (decision.status === ASYNC_TOOL_CONFIRMATION_STATUS.cancelled) return 'rejected'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}
