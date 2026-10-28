import type { ToolExecutionContext as CopilotToolExecutionContext } from '@/lib/mothership/tool-executor/types'
import { getLocalCopilotSandboxProfile } from '@/local-copilot/lib/context/e2b-capabilities'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

/** Maps local copilot context to the Mothership/copilot server tool handler shape. */
export function toCopilotServerToolContext(
  ctx: ToolExecutionContext,
  workflowId?: string
): CopilotToolExecutionContext {
  const sandboxProfile = getLocalCopilotSandboxProfile()
  return {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workflowId: workflowId ?? ctx.workflowId ?? ctx.structuredContext.workflow?.id ?? '',
    // Arena chat admission always sets read/write/admin. Empty/missing must not
    // fail-closed as "no write" — that makes create_file look "unavailable" and
    // pushes the model into the stuck python-pptx sandbox loop.
    userPermission: ctx.userPermission?.trim() || 'write',
    chatId: ctx.chatId,
    messageId: ctx.messageId,
    abortSignal: ctx.abortSignal,
    copilotToolExecution: true,
    ...(sandboxProfile ? { sandboxProfile } : {}),
    ...(ctx.activeToolCallId?.trim() ? { toolCallId: ctx.activeToolCallId.trim() } : {}),
    ...(ctx.fileIntentChannelId?.trim()
      ? { parentToolCallId: ctx.fileIntentChannelId.trim() }
      : {}),
    ...(ctx.billingAttribution ? { billingAttribution: ctx.billingAttribution } : {}),
    ...(ctx.resolvedSecretTraceRegistry
      ? { resolvedSecretTraceRegistry: ctx.resolvedSecretTraceRegistry }
      : {}),
  }
}
