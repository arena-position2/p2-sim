import type { ToolExecutionResult } from '@/local-copilot/lib/tools/executor'
import { isHtmlSandboxInspectCall } from '@/local-copilot/lib/writes/html-edit-intent'

export const HTML_INSPECT_VIA_SANDBOX_ERROR =
  'Do not use function_execute to open/print/inspect HTML. Use read or grep on files/…/content, then workspace_file (patch or update) + edit_content to change it.'

/**
 * Blocks sandbox line-dumps of workspace HTML. Models thrash on
 * function_execute print/splitlines loops instead of VFS read/grep + write —
 * the same class of mistake as building office docs via python-pptx.
 */
export function rejectHtmlInspectViaSandbox(
  toolName: string,
  args: Record<string, unknown>
): ToolExecutionResult | null {
  if (toolName !== 'function_execute' && toolName !== 'run_function') return null
  if (!isHtmlSandboxInspectCall({ name: toolName, args })) return null
  return {
    toolName,
    success: false,
    error: HTML_INSPECT_VIA_SANDBOX_ERROR,
    result: { success: false, message: HTML_INSPECT_VIA_SANDBOX_ERROR },
  }
}
