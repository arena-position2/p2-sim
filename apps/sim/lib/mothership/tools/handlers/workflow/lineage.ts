import type { ToolExecutionContext } from '@/lib/mothership/tool-executor/types'
import type { ExecuteWorkflowOptions } from '@/lib/workflows/executor/execute-workflow'

/**
 * Builds workflow lineage options for copilot-triggered runs.
 * Parent execution is set only for in-workflow mothership runs (hosting
 * executionId without a copilot runId); standalone chat runs only pass
 * triggering chat/run ids for rollup attribution.
 */
export function buildCopilotWorkflowLineageOptions(
  context: ToolExecutionContext
): Pick<
  ExecuteWorkflowOptions,
  'parentExecutionId' | 'parentRootExecutionId' | 'triggeringChatId' | 'triggeringRunId'
> {
  const options: Pick<
    ExecuteWorkflowOptions,
    'parentExecutionId' | 'parentRootExecutionId' | 'triggeringChatId' | 'triggeringRunId'
  > = {}

  if (context.chatId) {
    options.triggeringChatId = context.chatId
  }
  if (context.runId) {
    options.triggeringRunId = context.runId
  }
  if (context.executionId && !context.runId) {
    options.parentExecutionId = context.executionId
  }

  return options
}
