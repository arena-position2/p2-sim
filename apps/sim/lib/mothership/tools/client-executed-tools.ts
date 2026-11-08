import { toRecordOrNull } from '@sim/utils/object'
import { MothershipStreamV1ToolExecutor } from '@/lib/mothership/generated/mothership-stream-v1'
import { isDesktopToolCall } from '@/lib/mothership/tools/desktop-tools'

/** The tools that run a workflow, in the browser or on the server. */
export const WORKFLOW_TOOL_NAMES = [
  'run_workflow',
  'run_workflow_until_block',
  'run_block',
  'run_from_block',
] as const

export function isWorkflowToolName(name: string): boolean {
  return (WORKFLOW_TOOL_NAMES as readonly string[]).includes(name)
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
 * Name alone is not enough: Local Copilot re-emits finished *server-side* tools
 * with `executor: go` for chat UI only. Those frames must not trigger
 * `executeRunToolOnClient`. Workflow tools use `executor: client` (and persist
 * an async tool row) so the browser can fill canvas Logs live, same as Cloud.
 */
export function streamFrameRequestsClientExecution(frame: {
  executor?: string
  ui?: unknown
}): boolean {
  if (frame.executor === MothershipStreamV1ToolExecutor.client) return true
  return toRecordOrNull(frame.ui)?.clientExecutable === true
}
