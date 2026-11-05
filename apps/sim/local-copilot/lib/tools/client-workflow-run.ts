import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { isRecordLike, toArray } from '@sim/utils/object'
import { ASYNC_TOOL_STATUS } from '@/lib/mothership/async-runs/lifecycle'
import { upsertAsyncToolCall } from '@/lib/mothership/async-runs/repository'
import { CLIENT_TOOL_RESULT_TIMEOUT_MS } from '@/lib/mothership/constants'
import {
  MothershipStreamV1ToolExecutor,
  MothershipStreamV1ToolMode,
  MothershipStreamV1ToolOutcome,
  MothershipStreamV1ToolStatus,
} from '@/lib/mothership/generated/mothership-stream-v1'
import { waitForWorkflowToolCompletion } from '@/lib/mothership/request/tools/client'
import { sealClientToolContext } from '@/lib/mothership/request/tools/client-completion-seal.server'
import { isWorkflowToolName } from '@/lib/mothership/tools/client-executed-tools'
import { resolveWorkflowToolTargetId } from '@/lib/mothership/tools/workflow-tools'
import type { ToolExecutionContext, ToolExecutionResult } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotClientWorkflowRun')

/**
 * Stream-frame shape for Local workflow tools that the browser must execute
 * (Cloud parity: live canvas Logs / Output via `executeRunToolOnClient`).
 */
export function localClientWorkflowToolCallFrame(params: {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  thoughtSignature?: string
}): {
  executor: typeof MothershipStreamV1ToolExecutor.client
  mode: typeof MothershipStreamV1ToolMode.async
  status: typeof MothershipStreamV1ToolStatus.executing
  ui: { clientExecutable: true }
  arguments: Record<string, unknown>
  toolCallId: string
  toolName: string
  thoughtSignature?: string
} {
  return {
    executor: MothershipStreamV1ToolExecutor.client,
    mode: MothershipStreamV1ToolMode.async,
    status: MothershipStreamV1ToolStatus.executing,
    ui: { clientExecutable: true },
    arguments: params.args,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    ...(params.thoughtSignature ? { thoughtSignature: params.thoughtSignature } : {}),
  }
}

/** Whether Local should hand this tool to the browser instead of running headless. */
export function shouldRunLocalWorkflowToolOnClient(toolName: string): boolean {
  return isWorkflowToolName(toolName)
}

/**
 * Persists the async tool row before the client frame is forwarded so
 * `/api/copilot/tools/execute` can bind the browser run.
 *
 * Skips Cloud's permission gate on purpose: Local already owns approval via
 * `classifyLocalToolConfirmation`, and wiring Sim's gated re-emit would hang
 * the Local agent loop with no `runGatedToolExecution` waiter.
 */
export async function persistLocalClientWorkflowToolCall(params: {
  runId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  userId: string
  workflowId?: string | null
  registry?: ToolExecutionContext['resolvedSecretTraceRegistry']
}): Promise<Record<string, unknown>> {
  const pinnedArgs = { ...params.args }
  const targetWorkflowId = resolveWorkflowToolTargetId(pinnedArgs, params.workflowId)
  if (targetWorkflowId) {
    pinnedArgs.workflowId = targetWorkflowId
  }

  let sealedContext: Awaited<ReturnType<typeof sealClientToolContext>> | undefined
  if (params.registry) {
    try {
      sealedContext = await sealClientToolContext({
        toolCallId: params.toolCallId,
        runId: params.runId,
        userId: params.userId,
        registry: params.registry,
        toolInput: pinnedArgs,
      })
    } catch (error) {
      params.registry.markIncomplete('client-tool-seal-failed')
      logger.warn('Failed to seal Local client workflow tool provenance', {
        toolCallId: params.toolCallId,
        error: getErrorMessage(error),
      })
    }
  }

  await upsertAsyncToolCall({
    runId: params.runId,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    args: pinnedArgs,
    sealedContext,
    status: ASYNC_TOOL_STATUS.running,
  })

  return pinnedArgs
}

/**
 * Waits for the browser to finish a Local-delegated workflow tool and maps the
 * completion into the Local tool-result shape the agent loop already consumes.
 */
export async function waitForLocalClientWorkflowTool(params: {
  toolName: string
  args: Record<string, unknown>
  ctx: ToolExecutionContext
}): Promise<ToolExecutionResult> {
  const { toolName, args, ctx } = params
  const toolCallId = ctx.activeToolCallId?.trim()
  const runId = ctx.runId?.trim()

  if (!toolCallId || !runId) {
    const message =
      'Workflow run could not be started in the browser (missing run or tool call id). Retry the run.'
    return {
      toolName,
      success: false,
      error: message,
      result: { success: false, message },
    }
  }

  const workflowId = resolveWorkflowToolTargetId(args, ctx.workflowId)
  if (!workflowId) {
    const message =
      'workflowId is required to run a workflow from chat. Pass it explicitly from workspaceWorkflows.'
    return {
      toolName,
      success: false,
      error: message,
      result: { success: false, message },
    }
  }

  const select = toArray(args.select).every((value) => typeof value === 'string')
    ? (args.select as string[])
    : undefined

  try {
    const completion = await waitForWorkflowToolCompletion({
      toolCallId,
      workflowId,
      timeoutMs: CLIENT_TOOL_RESULT_TIMEOUT_MS,
      abortSignal: ctx.abortSignal,
      registry: ctx.resolvedSecretTraceRegistry,
      ...(select ? { select } : {}),
    })

    if (!completion) {
      const message =
        'Timed out waiting for the browser to finish the workflow run. Keep this chat open on the workflow and retry.'
      return {
        toolName,
        success: false,
        error: message,
        result: { success: false, message },
      }
    }

    const success = completion.status === MothershipStreamV1ToolOutcome.success
    const data = isRecordLike(completion.data) ? completion.data : { success }
    return {
      toolName,
      success,
      result: data,
      ...(success ? {} : { error: completion.message || 'Workflow run failed' }),
    }
  } catch (error) {
    const message = getErrorMessage(error, 'Workflow run failed')
    logger.warn('Local client workflow wait failed', {
      toolName,
      toolCallId,
      runId,
      error: message,
    })
    return {
      toolName,
      success: false,
      error: message,
      result: { success: false, message },
    }
  }
}
