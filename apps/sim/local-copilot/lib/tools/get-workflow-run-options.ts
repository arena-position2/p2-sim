import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import {
  executeCopilotWorkflowUseCase,
  messageForCopilotWorkflowError,
} from '@/lib/mothership/application/execute-workflow-use-case'
import { readCopilotWorkflowRunOptions } from '@/lib/workflows/application/read-workflow-copilot-metadata'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import type { ToolExecutionContext, ToolExecutionResult } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotGetWorkflowRunOptions')

/** Catalog id — Cloud implements this as a sim-route Go tool; Arena runs it locally. */
export const GET_WORKFLOW_RUN_OPTIONS_TOOL_NAME = 'get_workflow_run_options' as const

/**
 * Describes draft trigger entrypoints and `workflow_input` shapes for `run_workflow`.
 *
 * Kept under `local-copilot` so Sim merges do not need a mothership handler for
 * this leaf — Cloud still serves it from the worker.
 */
export async function executeGetWorkflowRunOptions(
  _args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  workflowId: string
): Promise<ToolExecutionResult> {
  try {
    const result = await executeCopilotWorkflowUseCase(
      toCopilotServerToolContext(ctx, workflowId),
      readCopilotWorkflowRunOptions,
      {
        workflowId,
        assertedWorkspaceId: ctx.workspaceId,
      }
    )
    return {
      toolName: GET_WORKFLOW_RUN_OPTIONS_TOOL_NAME,
      success: true,
      result: {
        workflowId,
        version: 'draft',
        ...result,
      },
    }
  } catch (error) {
    logger.error('local get_workflow_run_options failed', {
      error: toError(error).message,
      workflowId,
      workspaceId: ctx.workspaceId,
    })
    const message = messageForCopilotWorkflowError(
      error,
      getErrorMessage(error, 'Failed to load workflow run options')
    )
    return {
      toolName: GET_WORKFLOW_RUN_OPTIONS_TOOL_NAME,
      success: false,
      error: message,
      result: { error: message },
    }
  }
}
