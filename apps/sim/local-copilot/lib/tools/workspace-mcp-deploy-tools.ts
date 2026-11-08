import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { toArray } from '@sim/utils/object'
import { getBaseUrl } from '@/lib/core/utils/urls'
import {
  createWorkflowMcpDeploymentServer,
  deleteWorkflowMcpDeploymentServer,
  deployWorkflowMcpTool,
  listWorkflowMcpDeployments,
  undeployWorkflowMcpTool,
  updateWorkflowMcpDeploymentServer,
} from '@/lib/mcp/application/workflow-deployments'
import { buildWorkflowMcpApiEndpoint, buildWorkflowMcpServerUrl } from '@/lib/mcp/urls'
import { messageForCopilotApplicationError } from '@/lib/mothership/application/errors'
import { copilotToolCanWrite, copilotWriteDeniedMessage } from '@/lib/mothership/tools/permissions'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import { executeCopilotMcpServerUseCase } from '@/local-copilot/lib/tools/execute-mcp-server-use-case'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotWorkspaceMcpDeployTools')

/**
 * Catalog leaves for publishing workflows *as* MCP servers (deploy.mcp).
 * Distinct from `manage_mcp_connection`, which manages external MCP connections
 * agents call tools through.
 */
export const WORKSPACE_MCP_DEPLOY_TOOL_NAMES = [
  'list_workspace_mcp_servers',
  'create_workspace_mcp_server',
  'update_workspace_mcp_server',
  'delete_workspace_mcp_server',
  'deploy_mcp',
] as const

export type WorkspaceMcpDeployToolName = (typeof WORKSPACE_MCP_DEPLOY_TOOL_NAMES)[number]

export function isWorkspaceMcpDeployToolName(
  toolName: string
): toolName is WorkspaceMcpDeployToolName {
  return (WORKSPACE_MCP_DEPLOY_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface WorkspaceMcpDeployToolResult {
  success: boolean
  output?: unknown
  error?: string
}

/**
 * Arena Local Copilot implementations of Cloud workspace MCP deploy tools.
 * Kept under `local-copilot` so Sim merges do not need to restore
 * `lib/copilot/tools/handlers/deployment/{manage,deploy}.ts`.
 */
export async function executeWorkspaceMcpDeployTool(
  toolName: WorkspaceMcpDeployToolName,
  rawParams: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkspaceMcpDeployToolResult> {
  if (!ctx.workspaceId) {
    return { success: false, error: 'workspaceId is required' }
  }

  if (toolName !== 'list_workspace_mcp_servers' && !copilotToolCanWrite(ctx.userPermission)) {
    return {
      success: false,
      error: copilotWriteDeniedMessage(toolName, 'write', ctx.userPermission),
    }
  }

  try {
    switch (toolName) {
      case 'list_workspace_mcp_servers':
        return await executeListWorkspaceMcpServers(rawParams, ctx)
      case 'create_workspace_mcp_server':
        return await executeCreateWorkspaceMcpServer(rawParams, ctx)
      case 'update_workspace_mcp_server':
        return await executeUpdateWorkspaceMcpServer(rawParams, ctx)
      case 'delete_workspace_mcp_server':
        return await executeDeleteWorkspaceMcpServer(rawParams, ctx)
      case 'deploy_mcp':
        return await executeDeployMcp(rawParams, ctx)
    }
  } catch (error) {
    logger.error(`local ${toolName} failed`, {
      error: toError(error).message,
      workspaceId: ctx.workspaceId,
    })
    return {
      success: false,
      error: messageForCopilotApplicationError(error, getErrorMessage(error, `${toolName} failed`)),
    }
  }
}

async function executeListWorkspaceMcpServers(
  _params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkspaceMcpDeployToolResult> {
  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotMcpServerUseCase(toolContext, listWorkflowMcpDeployments, {
    workspaceId: ctx.workspaceId,
  })

  return {
    success: true,
    output: {
      servers: result.servers.map((server) => ({
        id: server.id,
        name: server.name,
        description: server.description,
        isPublic: server.isPublic,
        toolCount: server.toolCount,
        toolNames: server.toolNames,
        mcpServerUrl: buildWorkflowMcpServerUrl(server.id),
      })),
      count: result.servers.length,
      truncated: result.truncated,
    },
  }
}

async function executeCreateWorkspaceMcpServer(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkspaceMcpDeployToolResult> {
  const name = stringArg(params, 'name')
  if (!name) {
    return { success: false, error: 'name is required' }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotMcpServerUseCase(
    toolContext,
    createWorkflowMcpDeploymentServer,
    {
      workspaceId: ctx.workspaceId,
      name,
      description: stringArg(params, 'description'),
      isPublic: booleanArg(params, 'isPublic'),
      workflowIds: stringArrayArg(params, 'workflowIds'),
    }
  )

  return {
    success: true,
    output: {
      server: {
        id: result.server.id,
        name: result.server.name,
        description: result.server.description,
        isPublic: result.server.isPublic,
        mcpServerUrl: buildWorkflowMcpServerUrl(result.server.id),
      },
      addedTools: result.addedTools.map((tool) => ({
        toolName: tool.toolName,
        workflowId: tool.workflowId,
      })),
    },
  }
}

async function executeUpdateWorkspaceMcpServer(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkspaceMcpDeployToolResult> {
  const serverId = stringArg(params, 'serverId')
  if (!serverId) {
    return { success: false, error: 'serverId is required' }
  }

  const updates: { name?: string; description?: string | null; isPublic?: boolean } = {}
  if (typeof params.name === 'string') {
    const name = params.name.trim()
    if (!name) return { success: false, error: 'name cannot be empty' }
    updates.name = name
  }
  if (typeof params.description === 'string') {
    updates.description = params.description.trim() || null
  }
  if (typeof params.isPublic === 'boolean') {
    updates.isPublic = params.isPublic
  }

  if (Object.keys(updates).length === 0) {
    return { success: false, error: 'At least one of name, description, or isPublic is required' }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  await executeCopilotMcpServerUseCase(toolContext, updateWorkflowMcpDeploymentServer, {
    serverId,
    ...updates,
  })

  return { success: true, output: { serverId, ...updates } }
}

async function executeDeleteWorkspaceMcpServer(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkspaceMcpDeployToolResult> {
  const serverId = stringArg(params, 'serverId')
  if (!serverId) {
    return { success: false, error: 'serverId is required' }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotMcpServerUseCase(
    toolContext,
    deleteWorkflowMcpDeploymentServer,
    { serverId }
  )

  return {
    success: true,
    output: { serverId, name: result.server.name, deleted: true },
  }
}

async function executeDeployMcp(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkspaceMcpDeployToolResult> {
  const workflowId = stringArg(params, 'workflowId') ?? ctx.workflowId
  if (!workflowId) {
    return { success: false, error: 'workflowId is required' }
  }

  const serverId = stringArg(params, 'serverId')
  if (!serverId) {
    return {
      success: false,
      error: 'serverId is required. Use list_workspace_mcp_servers to get available servers.',
    }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const action = stringArg(params, 'action') === 'undeploy' ? 'undeploy' : 'deploy'

  if (action === 'undeploy') {
    const result = await executeCopilotMcpServerUseCase(toolContext, undeployWorkflowMcpTool, {
      serverId,
      workflowId,
    })
    return {
      success: true,
      output: {
        workflowId,
        serverId,
        serverName: result.server.name,
        action: 'undeploy',
        removed: true,
        deploymentType: 'mcp',
        deploymentStatus: {
          mcp: {
            isDeployed: false,
            serverId,
            serverName: result.server.name,
          },
        },
      },
    }
  }

  const result = await executeCopilotMcpServerUseCase(toolContext, deployWorkflowMcpTool, {
    serverId,
    workflowId,
    toolName: stringArg(params, 'toolName'),
    toolDescription: stringArg(params, 'toolDescription'),
    parameterDescriptions: parseParameterDescriptions(params.parameterDescriptions),
  })

  const baseUrl = getBaseUrl()
  const mcpServerUrl = buildWorkflowMcpServerUrl(serverId)
  const apiEndpoint = buildWorkflowMcpApiEndpoint(workflowId)
  const toolId = result.tool.id
  const toolName = result.tool.toolName
  const toolDescription = result.tool.toolDescription

  return {
    success: true,
    output: {
      toolId,
      toolName,
      toolDescription,
      updated: result.updated,
      mcpServerUrl,
      baseUrl,
      serverId,
      serverName: result.server.name,
      deploymentType: 'mcp',
      apiEndpoint,
      deploymentStatus: {
        api: {
          isDeployed: true,
          endpoint: apiEndpoint,
        },
        mcp: {
          isDeployed: true,
          serverId,
          serverName: result.server.name,
          toolId,
          toolName,
          updated: result.updated,
        },
      },
      deploymentConfig: {
        mcp: {
          serverId,
          serverName: result.server.name,
          serverUrl: mcpServerUrl,
          toolId,
          toolName,
          toolDescription,
          parameterSchema: result.parameterSchema,
          authentication: {
            type: 'api_key',
            header: 'X-API-Key: YOUR_API_KEY',
          },
        },
      },
      examples: {
        mcp: buildMcpClientExamples(result.server.name, mcpServerUrl),
      },
    },
  }
}

function buildMcpClientExamples(serverName: string, serverUrl: string) {
  return {
    cursor: {
      mcpServers: {
        [serverName]: {
          url: serverUrl,
          headers: { 'X-API-Key': 'YOUR_API_KEY' },
        },
      },
    },
    claudeCode: `claude mcp add ${serverName} --url "${serverUrl}" --header "X-API-Key: YOUR_API_KEY"`,
    claudeDesktop: {
      mcpServers: {
        [serverName]: {
          command: 'npx',
          args: ['-y', 'mcp-remote', serverUrl, '--header', 'X-API-Key:YOUR_API_KEY'],
        },
      },
    },
    vscode: {
      mcp: {
        servers: {
          [serverName]: {
            type: 'http',
            url: serverUrl,
            headers: { 'X-API-Key': 'YOUR_API_KEY' },
          },
        },
      },
    },
  }
}

function parseParameterDescriptions(
  raw: unknown
): Array<{ name?: string; description?: string }> | undefined {
  const entries = toArray(raw)
  if (entries.length === 0) return undefined
  const parsed: Array<{ name?: string; description?: string }> = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    parsed.push({
      name: typeof record.name === 'string' ? record.name : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
    })
  }
  return parsed.length > 0 ? parsed : undefined
}

function stringArg(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function booleanArg(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}

function stringArrayArg(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (!Array.isArray(value)) return undefined
  const ids = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return ids.length > 0 ? ids : undefined
}
