import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { isRecordLike } from '@sim/utils/object'
import { asOrchestrationError } from '@/lib/core/orchestration/types'
import {
  deleteMcpServerUseCase,
  listMcpServersUseCase,
  reconfigureMcpServerUseCase,
  registerMcpServerUseCase,
} from '@/lib/mcp/application/use-cases'
import { copilotToolCanWrite, copilotWriteDeniedMessage } from '@/lib/mothership/tools/permissions'
import { captureServerEvent } from '@/lib/posthog/server'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import { executeCopilotMcpServerUseCase } from '@/local-copilot/lib/tools/execute-mcp-server-use-case'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotManageMcpConnection')

/** Catalog id — Cloud renamed `manage_mcp_tool` → `manage_mcp_connection`. */
export const MANAGE_MCP_CONNECTION_TOOL_NAME = 'manage_mcp_connection'

type ManageMcpOperation = 'add' | 'edit' | 'delete' | 'list'

const MCP_TRANSPORTS = new Set(['streamable-http', 'sse'])

/**
 * Lists / adds / edits / deletes workspace MCP server connections for Arena
 * Local Copilot. Mirrors the historical Cloud `executeManageMcpTool` handler
 * (ops + PostHog), kept under `local-copilot` so Sim merges do not need to
 * restore `lib/mothership/tools/handlers/management/manage-mcp-tool`.
 */
export async function executeManageMcpConnection(
  rawParams: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  const operation = String(rawParams.operation ?? '')
    .trim()
    .toLowerCase() as ManageMcpOperation
  const workspaceId = ctx.workspaceId
  const serverId = stringArg(rawParams, 'serverId')
  const config = parseConfig(rawParams.config)

  if (!operation) {
    return { success: false, error: "Missing required 'operation' argument" }
  }

  if (!workspaceId) {
    return { success: false, error: 'workspaceId is required' }
  }

  if (operation !== 'list' && !copilotToolCanWrite(ctx.userPermission)) {
    return {
      success: false,
      error: copilotWriteDeniedMessage(
        MANAGE_MCP_CONNECTION_TOOL_NAME,
        operation,
        ctx.userPermission
      ),
    }
  }

  const toolContext = toCopilotServerToolContext(ctx)

  try {
    if (operation === 'list') {
      const { servers } = await executeCopilotMcpServerUseCase(toolContext, listMcpServersUseCase, {
        workspaceId,
      })

      return {
        success: true,
        output: {
          success: true,
          operation,
          servers: servers.map((server) => ({
            id: server.id,
            name: server.name,
            url: server.url,
            transport: server.transport,
            enabled: server.enabled,
            connectionStatus: server.connectionStatus,
          })),
          count: servers.length,
        },
      }
    }

    if (operation === 'add') {
      if (!config?.name || !config.url) {
        return { success: false, error: "config.name and config.url are required for 'add'" }
      }

      const result = await executeCopilotMcpServerUseCase(toolContext, registerMcpServerUseCase, {
        workspaceId,
        name: config.name,
        description: '',
        transport: config.transport ?? 'streamable-http',
        url: config.url,
        headers: config.headers,
        timeout: config.timeout,
        retries: 3,
        enabled: config.enabled,
        source: 'tool_input',
      })

      if (!result.updated) {
        captureServerEvent(
          ctx.userId,
          'mcp_server_connected',
          {
            workspace_id: workspaceId,
            server_name: result.server.name,
            transport: result.server.transport,
            source: 'tool_input',
          },
          {
            groups: { workspace: workspaceId },
            setOnce: { first_mcp_connected_at: new Date().toISOString() },
          }
        )
      }

      return {
        success: true,
        output: {
          success: true,
          operation,
          serverId: result.server.id,
          name: config.name,
          message: result.updated
            ? `Updated existing MCP server "${config.name}"`
            : `Added MCP server "${config.name}"`,
        },
      }
    }

    if (operation === 'edit') {
      if (!serverId) {
        return { success: false, error: "'serverId' is required for 'edit'" }
      }
      if (!config) {
        return { success: false, error: "'config' is required for 'edit'" }
      }

      const result = await executeCopilotMcpServerUseCase(
        toolContext,
        reconfigureMcpServerUseCase,
        {
          workspaceId,
          serverId,
          name: config.name,
          transport: config.transport,
          url: config.url,
          headers: config.headers,
          timeout: config.timeout,
          enabled: config.enabled,
          source: 'tool_input',
        }
      )

      return {
        success: true,
        output: {
          success: true,
          operation,
          serverId,
          name: result.server.name,
          message: `Updated MCP server "${result.server.name}"`,
        },
      }
    }

    if (operation === 'delete') {
      if (!serverId) {
        return { success: false, error: "'serverId' is required for 'delete'" }
      }

      const result = await executeCopilotMcpServerUseCase(toolContext, deleteMcpServerUseCase, {
        workspaceId,
        serverId,
        source: 'tool_input',
      })
      captureServerEvent(
        ctx.userId,
        'mcp_server_disconnected',
        {
          workspace_id: workspaceId,
          server_name: result.server.name,
          source: 'tool_input',
        },
        { groups: { workspace: workspaceId } }
      )

      return {
        success: true,
        output: {
          success: true,
          operation,
          serverId,
          message: `Deleted MCP server "${result.server.name}"`,
        },
      }
    }

    return {
      success: false,
      error: `Unsupported operation for manage_mcp_connection: ${operation}`,
    }
  } catch (error) {
    logger.error(
      ctx.messageId
        ? `manage_mcp_connection execution failed [messageId:${ctx.messageId}]`
        : 'manage_mcp_connection execution failed',
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
              `The ${operation || 'MCP server'} operation failed. Run operation "list" to check current state before retrying.`
            ),
    }
  }
}

function stringArg(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

interface ManageMcpConfig {
  name?: string
  transport?: 'streamable-http' | 'sse'
  url?: string
  headers?: Record<string, string>
  timeout?: number
  enabled?: boolean
}

function parseConfig(raw: unknown): ManageMcpConfig | undefined {
  if (!isRecordLike(raw)) return undefined

  const name = typeof raw.name === 'string' ? raw.name.trim() : undefined
  const url = typeof raw.url === 'string' ? raw.url.trim() : undefined
  const transportRaw = typeof raw.transport === 'string' ? raw.transport.trim() : undefined
  const transport =
    transportRaw && MCP_TRANSPORTS.has(transportRaw)
      ? (transportRaw as 'streamable-http' | 'sse')
      : undefined

  let headers: Record<string, string> | undefined
  if (isRecordLike(raw.headers)) {
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value === 'string') next[key] = value
    }
    headers = next
  }

  const timeout =
    typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) ? raw.timeout : undefined
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined

  if (!name && !url && !transport && !headers && timeout === undefined && enabled === undefined) {
    return undefined
  }

  return {
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
    ...(transport ? { transport } : {}),
    ...(headers ? { headers } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  }
}
