import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { isRecordLike } from '@sim/utils/object'
import { managementToolContracts } from '@/lib/api/contracts/mothership-management-tools'
import { openResourceOutputSchema } from '@/lib/api/contracts/mothership-resource-tools'
import { messageForCopilotApplicationError } from '@/lib/mothership/application/error'
import { projectToolErrorMessageForCopilot } from '@/lib/mothership/request/tools/resolved-secret-result'
import { searchResourceFromToolResult } from '@/lib/mothership/resources/search-tool-result'
import type { ToolExecutionResult, ToolHandler } from '@/lib/mothership/tool-executor/types'
import { normalizeGenerateImageArgs } from '@/lib/mothership/tools/server/image/normalize-args'
import { routeExecution } from '@/lib/mothership/tools/server/router'
import { normalizeEditWorkflowArgs } from '@/lib/mothership/tools/server/workflow/edit-workflow/normalize-args'

const logger = createLogger('ServerToolAdapter')

const MISSING_EDIT_OPERATIONS_ERROR =
  'operations are required and must be a non-empty array — pass { operations: [{ block_id, operation_type, params }] }'

const MISSING_GENERATE_IMAGE_PROMPT_ERROR =
  'prompt is required — pass { prompt: "detailed image description" }'

export function createServerToolHandler(toolId: string): ToolHandler {
  return async (params, context): Promise<ToolExecutionResult> => {
    let enrichedParams = { ...params }
    if (toolId !== 'open_resource' && !managementToolContracts.some((tool) => tool.id === toolId)) {
      if (!enrichedParams.workflowId && context.workflowId)
        enrichedParams.workflowId = context.workflowId
      if (context.workspaceId) enrichedParams.workspaceId = context.workspaceId
    }

    if (toolId === 'edit_workflow') {
      enrichedParams = normalizeEditWorkflowArgs(enrichedParams)
      if (!Array.isArray(enrichedParams.operations) || enrichedParams.operations.length === 0) {
        return {
          success: false,
          error: MISSING_EDIT_OPERATIONS_ERROR,
          output: { success: false, error: MISSING_EDIT_OPERATIONS_ERROR },
        }
      }
    }

    if (toolId === 'generate_image') {
      enrichedParams = normalizeGenerateImageArgs(enrichedParams)
      if (typeof enrichedParams.prompt !== 'string' || !enrichedParams.prompt.trim()) {
        return {
          success: false,
          error: MISSING_GENERATE_IMAGE_PROMPT_ERROR,
          output: { success: false, error: MISSING_GENERATE_IMAGE_PROMPT_ERROR },
        }
      }
    }

    try {
      const result = await routeExecution(toolId, enrichedParams, {
        userId: context.userId,
        workspaceId: context.workspaceId,
        organizationId: context.organizationId,
        chatOrganizationId: context.chatOrganizationId,
        executionId: context.executionId,
        toolCallId: context.toolCallId,
        copilotToolExecution: context.copilotToolExecution,
        requestMode: context.requestMode,
        searchSurface: context.searchSurface,
        assistantSearch: context.assistantSearch,
        billingAttribution: context.billingAttribution,
        userPermission: context.userPermission ?? undefined,
        chatId: context.chatId,
        messageId: context.messageId,
        parentToolCallId: context.parentToolCallId,
        abortSignal: context.abortSignal,
        resolvedSecretTraceRegistry: context.resolvedSecretTraceRegistry,
      })

      const rec = isRecordLike(result) ? (result as Record<string, unknown>) : null
      if (rec?.success === false) {
        const message =
          (typeof rec.error === 'string' && rec.error) ||
          (typeof rec.message === 'string' && rec.message) ||
          `${toolId} failed`
        return { success: false, error: message, output: result }
      }
      const searchResource =
        toolId === 'search_workspace'
          ? searchResourceFromToolResult(enrichedParams, result, context)
          : undefined
      return {
        success: true,
        output: result,
        ...(searchResource ? { resources: [searchResource] } : {}),
        ...(toolId === 'open_resource'
          ? { resources: openResourceOutputSchema.parse(result).resources }
          : {}),
      }
    } catch (error) {
      const caughtError = toError(error)
      // The generic projection below records the swallowed cause on the active
      // span itself (messageForCopilotApplicationError) so Tempo carries it.
      logger.error(
        'Server tool execution failed',
        {
          toolId,
          abortSignalAborted: context.abortSignal?.aborted ?? false,
        },
        caughtError
      )
      const safeMessage = projectToolErrorMessageForCopilot(
        messageForCopilotApplicationError(error),
        context.resolvedSecretTraceRegistry,
        toolId
      )
      return {
        success: false,
        error: `[${toolId}] ${safeMessage}`,
      }
    }
  }
}
