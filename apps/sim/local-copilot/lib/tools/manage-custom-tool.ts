import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { isRecordLike } from '@sim/utils/object'
import { asOrchestrationError } from '@/lib/core/orchestration/types'
import {
  createWorkspaceCustomToolUseCase,
  deleteWorkspaceCustomToolUseCase,
  listAvailableCustomToolsUseCase,
  updateWorkspaceCustomToolUseCase,
} from '@/lib/custom-tools/application/use-cases'
import { executeCopilotCustomToolUseCase } from '@/lib/mothership/application/execute-custom-tool-use-case'
import { copilotToolCanWrite, copilotWriteDeniedMessage } from '@/lib/mothership/tools/permissions'
import { captureServerEvent } from '@/lib/posthog/server'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotManageCustomTool')

export const MANAGE_CUSTOM_TOOL_NAME = 'manage_custom_tool'

type ManageCustomToolOperation = 'add' | 'edit' | 'delete' | 'list'

interface ManageCustomToolSchema {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

/**
 * Arena Local Copilot `manage_custom_tool`. Cloud deleted the mothership
 * handler; keep under local-copilot against custom-tool use cases.
 */
export async function executeManageCustomTool(
  rawParams: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  const operation = String(rawParams.operation ?? '')
    .trim()
    .toLowerCase() as ManageCustomToolOperation
  const workspaceId = ctx.workspaceId

  if (!operation) {
    return { success: false, error: "Missing required 'operation' argument" }
  }

  if (!workspaceId) {
    return { success: false, error: 'workspaceId is required' }
  }

  if (operation !== 'list' && !copilotToolCanWrite(ctx.userPermission)) {
    return {
      success: false,
      error: copilotWriteDeniedMessage(MANAGE_CUSTOM_TOOL_NAME, operation, ctx.userPermission),
    }
  }

  const toolContext = toCopilotServerToolContext(ctx)

  try {
    if (operation === 'list') {
      const { tools } = await executeCopilotCustomToolUseCase(
        toolContext,
        listAvailableCustomToolsUseCase,
        { workspaceId }
      )
      return {
        success: true,
        output: {
          success: true,
          operation,
          tools,
          count: tools.length,
        },
      }
    }

    if (operation === 'add') {
      const schema = parseSchema(rawParams.schema)
      const code = stringArg(rawParams, 'code')
      if (!schema || !code) {
        return {
          success: false,
          error: "Both 'schema' and 'code' are required for operation 'add'",
        }
      }
      const title = stringArg(rawParams, 'title') || schema.function.name
      if (!title) {
        return { success: false, error: "Missing tool title or schema.function.name for 'add'" }
      }

      const { tool: created } = await executeCopilotCustomToolUseCase(
        toolContext,
        createWorkspaceCustomToolUseCase,
        {
          title,
          schema,
          code,
          source: 'tool_input',
          workspaceId,
        }
      )
      captureServerEvent(
        ctx.userId,
        'custom_tool_saved',
        {
          tool_id: created.id,
          workspace_id: workspaceId,
          tool_name: created.title,
          source: 'tool_input',
        },
        { groups: { workspace: workspaceId } }
      )

      return {
        success: true,
        output: {
          success: true,
          operation,
          toolId: created.id,
          title: created.title,
          message: `Created custom tool "${created.title}"`,
        },
      }
    }

    if (operation === 'edit') {
      const toolId = stringArg(rawParams, 'toolId')
      if (!toolId) {
        return { success: false, error: "'toolId' is required for operation 'edit'" }
      }
      const schema = parseSchema(rawParams.schema)
      const code = stringArg(rawParams, 'code')
      if (!schema && !code) {
        return {
          success: false,
          error: "At least one of 'schema' or 'code' is required for operation 'edit'",
        }
      }

      const { tool } = await executeCopilotCustomToolUseCase(
        toolContext,
        updateWorkspaceCustomToolUseCase,
        {
          workspaceId,
          toolId,
          title: stringArg(rawParams, 'title') || schema?.function.name,
          schema,
          code,
          source: 'tool_input',
        }
      )
      captureServerEvent(
        ctx.userId,
        'custom_tool_saved',
        {
          tool_id: tool.id,
          workspace_id: workspaceId,
          tool_name: tool.title,
          source: 'tool_input',
        },
        { groups: { workspace: workspaceId } }
      )

      return {
        success: true,
        output: {
          success: true,
          operation,
          toolId: tool.id,
          title: tool.title,
          message: `Updated custom tool "${tool.title}"`,
        },
      }
    }

    if (operation === 'delete') {
      const toolIds = resolveToolIds(rawParams)
      if (toolIds.length === 0) {
        return { success: false, error: "'toolId' or 'toolIds' is required for operation 'delete'" }
      }

      const deleted: string[] = []
      const notFound: string[] = []
      for (const toolId of toolIds) {
        try {
          await executeCopilotCustomToolUseCase(toolContext, deleteWorkspaceCustomToolUseCase, {
            toolId,
            workspaceId,
            source: 'tool_input',
          })
          deleted.push(toolId)
        } catch (error) {
          const classified = asOrchestrationError(error)
          if (classified?.code === 'not_found') {
            notFound.push(toolId)
            continue
          }
          throw error
        }
      }

      for (const toolId of deleted) {
        captureServerEvent(
          ctx.userId,
          'custom_tool_deleted',
          { tool_id: toolId, workspace_id: workspaceId, source: 'tool_input' },
          { groups: { workspace: workspaceId } }
        )
      }

      return {
        success: deleted.length > 0,
        output: {
          success: deleted.length > 0,
          operation,
          deleted,
          notFound,
          message: `Deleted ${deleted.length} custom tool(s)`,
        },
        ...(deleted.length === 0 ? { error: 'No custom tools were deleted (none matched)' } : {}),
      }
    }

    return {
      success: false,
      error: `Unsupported operation for manage_custom_tool: ${operation}`,
    }
  } catch (error) {
    logger.error(
      ctx.messageId
        ? `manage_custom_tool execution failed [messageId:${ctx.messageId}]`
        : 'manage_custom_tool execution failed',
      {
        operation,
        workspaceId,
        error: toError(error).message,
      }
    )
    const classified = asOrchestrationError(error)
    return {
      success: false,
      error:
        classified && classified.code !== 'internal'
          ? classified.message
          : getErrorMessage(
              error,
              `The ${operation || 'custom tool'} operation failed. Run operation "list" to check current state before retrying.`
            ),
    }
  }
}

function parseSchema(raw: unknown): ManageCustomToolSchema | undefined {
  if (!isRecordLike(raw)) return undefined
  if (raw.type !== 'function' || !isRecordLike(raw.function)) return undefined
  const name = typeof raw.function.name === 'string' ? raw.function.name.trim() : ''
  if (!name) return undefined
  const parameters = isRecordLike(raw.function.parameters) ? raw.function.parameters : {}
  return {
    type: 'function',
    function: {
      name,
      ...(typeof raw.function.description === 'string'
        ? { description: raw.function.description }
        : {}),
      parameters,
    },
  }
}

function resolveToolIds(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.toolIds)) {
    return params.toolIds
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  const single = stringArg(params, 'toolId')
  return single ? [single] : []
}

function stringArg(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
