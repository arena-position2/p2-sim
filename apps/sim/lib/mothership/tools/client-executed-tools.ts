import { toRecordOrNull } from '@sim/utils/object'
import { MothershipStreamV1ToolExecutor } from '@/lib/mothership/generated/mothership-stream-v1'
import { isDesktopToolCall } from '@/lib/mothership/tools/desktop-tools'

const WORKFLOW_TOOL_NAMES = new Set<string>([
  'run_workflow',
  'run_workflow_until_block',
  'run_block',
  'run_from_block',
])

export function isWorkflowToolName(name: string): boolean {
  return WORKFLOW_TOOL_NAMES.has(name)
}

/**
 * Tool calls the browser starts from the call frame's own arguments: workflow
 * runs, local file access, browser actions, and terminal commands. The stream
 * must deliver those arguments exactly as the model sent them.
 */
export function isClientExecutedToolCall(
  name: string,
  args: Record<string, unknown> | undefined
): boolean {
  return isWorkflowToolName(name) || isDesktopToolCall(name, args)
}

/**
 * Whether this call frame is asking the browser to run the tool.
 *
 * Name alone is not enough: Arena Local Copilot already runs workflow tools
 * server-side and re-emits them with `executor: go` so the chat UI can render the
 * call. Those frames must not trigger `executeRunToolOnClient` — no
 * `copilot_async_tool_calls` row was persisted, so the execute route answers with
 * `COPILOT_WORKFLOW_TOOL_BINDING_UNKNOWN`.
 */
export function streamFrameRequestsClientExecution(frame: {
  executor?: string
  ui?: unknown
}): boolean {
  if (frame.executor === MothershipStreamV1ToolExecutor.client) return true
  return toRecordOrNull(frame.ui)?.clientExecutable === true
}
