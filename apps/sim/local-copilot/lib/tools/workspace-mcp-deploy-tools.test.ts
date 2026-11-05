/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - create without name → rejected before use cases
 * - write ops denied without workspace write
 * - update without fields / serverId → rejected
 * - deploy_mcp without serverId → rejected with list guidance
 * - list happy path (regression: must not Tool not found)
 * - executor early intercept for list_workspace_mcp_servers
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listWorkflowMcpDeployments,
  createWorkflowMcpDeploymentServer,
  updateWorkflowMcpDeploymentServer,
  deleteWorkflowMcpDeploymentServer,
  deployWorkflowMcpTool,
  undeployWorkflowMcpTool,
  executeCopilotMcpServerUseCase,
} = vi.hoisted(() => ({
  listWorkflowMcpDeployments: { operation: { id: 'mcp_servers.workflow_deployments.list' } },
  createWorkflowMcpDeploymentServer: {
    operation: { id: 'mcp_servers.workflow_deployments.create_server' },
  },
  updateWorkflowMcpDeploymentServer: {
    operation: { id: 'mcp_servers.workflow_deployments.update_server' },
  },
  deleteWorkflowMcpDeploymentServer: {
    operation: { id: 'mcp_servers.workflow_deployments.delete_server' },
  },
  deployWorkflowMcpTool: { operation: { id: 'mcp_servers.workflow_deployments.deploy_tool' } },
  undeployWorkflowMcpTool: { operation: { id: 'mcp_servers.workflow_deployments.undeploy_tool' } },
  executeCopilotMcpServerUseCase: vi.fn(),
}))

vi.mock('@/lib/mcp/application/workflow-deployments', () => ({
  listWorkflowMcpDeployments,
  createWorkflowMcpDeploymentServer,
  updateWorkflowMcpDeploymentServer,
  deleteWorkflowMcpDeploymentServer,
  deployWorkflowMcpTool,
  undeployWorkflowMcpTool,
}))
vi.mock('@/local-copilot/lib/tools/execute-mcp-server-use-case', () => ({
  executeCopilotMcpServerUseCase,
}))
vi.mock('@/lib/mcp/urls', () => ({
  buildWorkflowMcpServerUrl: (id: string) => `https://example.test/api/mcp/serve/${id}`,
  buildWorkflowMcpApiEndpoint: (id: string) =>
    `https://example.test/api/v2/workflows/${id}/execute`,
}))
vi.mock('@/lib/core/utils/urls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/utils/urls')>()
  return {
    ...actual,
    getBaseUrl: () => 'https://example.test',
  }
})

import {
  executeLocalCopilotTool,
  type ToolExecutionContext,
} from '@/local-copilot/lib/tools/executor'
import { executeWorkspaceMcpDeployTool } from '@/local-copilot/lib/tools/workspace-mcp-deploy-tools'
import type { LocalCopilotStructuredContext } from '@/local-copilot/lib/types'

const workspaceId = 'workspace-1'
const userId = 'user-1'

function toolCtx(permission = 'admin'): ToolExecutionContext {
  const structuredContext: LocalCopilotStructuredContext = {
    workspace: { id: workspaceId, name: 'Workspace', environment: 'self_hosted' },
    connectedIntegrations: [],
    envVariables: [],
    hostedKeysAvailable: false,
    execution: {
      lastRunStatus: 'unknown',
      logs: [],
      failedBlockId: null,
      error: null,
    },
    availableIntegrations: [],
    availableBlocks: [],
  }
  return {
    userId,
    workspaceId,
    userPermission: permission,
    structuredContext,
    workflowId: 'workflow-1',
  }
}

describe('executeWorkspaceMcpDeployTool', () => {
  beforeEach(() => {
    executeCopilotMcpServerUseCase.mockReset()
  })

  it('rejects create without name before use cases', async () => {
    const result = await executeWorkspaceMcpDeployTool('create_workspace_mcp_server', {}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/name/i)
    expect(executeCopilotMcpServerUseCase).not.toHaveBeenCalled()
  })

  it('denies create without workspace write', async () => {
    const result = await executeWorkspaceMcpDeployTool(
      'create_workspace_mcp_server',
      { name: 'Metabase' },
      toolCtx('read')
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/permission|write|denied/i)
    expect(executeCopilotMcpServerUseCase).not.toHaveBeenCalled()
  })

  it('rejects update without serverId or fields', async () => {
    const missingId = await executeWorkspaceMcpDeployTool(
      'update_workspace_mcp_server',
      { name: 'Renamed' },
      toolCtx()
    )
    expect(missingId.success).toBe(false)
    expect(missingId.error).toMatch(/serverId/i)

    const missingFields = await executeWorkspaceMcpDeployTool(
      'update_workspace_mcp_server',
      { serverId: 'srv-1' },
      toolCtx()
    )
    expect(missingFields.success).toBe(false)
    expect(missingFields.error).toMatch(/name|description|isPublic/i)
    expect(executeCopilotMcpServerUseCase).not.toHaveBeenCalled()
  })

  it('rejects deploy_mcp without serverId and points at list', async () => {
    const result = await executeWorkspaceMcpDeployTool('deploy_mcp', {}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/list_workspace_mcp_servers/i)
    expect(executeCopilotMcpServerUseCase).not.toHaveBeenCalled()
  })

  it('lists workspace MCP servers via workflow-deployment use case', async () => {
    executeCopilotMcpServerUseCase.mockResolvedValue({
      servers: [
        {
          id: 'srv-1',
          name: 'Metabase',
          description: null,
          isPublic: false,
          toolCount: 1,
          toolNames: ['query_orders'],
        },
      ],
      truncated: false,
    })

    const result = await executeWorkspaceMcpDeployTool('list_workspace_mcp_servers', {}, toolCtx())
    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      count: 1,
      truncated: false,
      servers: [
        {
          id: 'srv-1',
          name: 'Metabase',
          toolCount: 1,
          toolNames: ['query_orders'],
          mcpServerUrl: 'https://example.test/api/mcp/serve/srv-1',
        },
      ],
    })
    expect(executeCopilotMcpServerUseCase).toHaveBeenCalledWith(
      expect.anything(),
      listWorkflowMcpDeployments,
      { workspaceId }
    )
  })

  it('creates a workspace MCP server', async () => {
    executeCopilotMcpServerUseCase.mockResolvedValue({
      server: {
        id: 'srv-2',
        name: 'Ops',
        description: 'ops tools',
        isPublic: false,
      },
      addedTools: [{ id: 'tool-1', toolName: 'run_orders', workflowId: 'workflow-1' }],
    })

    const result = await executeWorkspaceMcpDeployTool(
      'create_workspace_mcp_server',
      { name: 'Ops', description: 'ops tools', workflowIds: ['workflow-1'] },
      toolCtx()
    )
    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      server: { id: 'srv-2', name: 'Ops' },
      addedTools: [{ toolName: 'run_orders', workflowId: 'workflow-1' }],
    })
    expect(executeCopilotMcpServerUseCase).toHaveBeenCalledWith(
      expect.anything(),
      createWorkflowMcpDeploymentServer,
      expect.objectContaining({
        workspaceId,
        name: 'Ops',
        description: 'ops tools',
        workflowIds: ['workflow-1'],
      })
    )
  })

  it('deploys a workflow tool onto a workspace MCP server', async () => {
    executeCopilotMcpServerUseCase.mockResolvedValue({
      tool: {
        id: 'tool-9',
        toolName: 'query_orders',
        toolDescription: 'Run orders',
      },
      server: { id: 'srv-1', name: 'Metabase' },
      workflow: { id: 'workflow-1', name: 'Orders' },
      updated: false,
      parameterSchema: { type: 'object' },
    })

    const result = await executeWorkspaceMcpDeployTool(
      'deploy_mcp',
      { serverId: 'srv-1', workflowId: 'workflow-1' },
      toolCtx()
    )
    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      toolId: 'tool-9',
      toolName: 'query_orders',
      serverId: 'srv-1',
      deploymentType: 'mcp',
      mcpServerUrl: 'https://example.test/api/mcp/serve/srv-1',
    })
    expect(executeCopilotMcpServerUseCase).toHaveBeenCalledWith(
      expect.anything(),
      deployWorkflowMcpTool,
      expect.objectContaining({ serverId: 'srv-1', workflowId: 'workflow-1' })
    )
  })
})

describe('executeLocalCopilotTool(list_workspace_mcp_servers)', () => {
  beforeEach(() => {
    executeCopilotMcpServerUseCase.mockReset()
    executeCopilotMcpServerUseCase.mockResolvedValue({
      servers: [],
      truncated: false,
    })
  })

  it('executes locally instead of mothership Tool not found', async () => {
    const result = await executeLocalCopilotTool('list_workspace_mcp_servers', {}, toolCtx())
    expect(result.success).toBe(true)
    expect(result.toolName).toBe('list_workspace_mcp_servers')
    expect(result.result).toMatchObject({ count: 0, servers: [] })
    expect(result.error).toBeUndefined()
  })
})
