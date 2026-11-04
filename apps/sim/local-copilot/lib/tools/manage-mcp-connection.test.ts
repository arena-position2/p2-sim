/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - missing operation / add config → rejected before use cases
 * - write ops denied without workspace write
 * - list happy path via copilot MCP adapter
 * - legacy `manage_mcp_tool` alias executes as manage_mcp_connection
 */
import { posthogServerMock } from '@sim/testing/mocks/posthog-server.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listMcpServersUseCase,
  registerMcpServerUseCase,
  reconfigureMcpServerUseCase,
  deleteMcpServerUseCase,
  executeCopilotMcpServerUseCase,
} = vi.hoisted(() => ({
  listMcpServersUseCase: { operation: { id: 'mcp_servers.list' }, execute: vi.fn() },
  registerMcpServerUseCase: { operation: { id: 'mcp_servers.register' }, execute: vi.fn() },
  reconfigureMcpServerUseCase: { operation: { id: 'mcp_servers.reconfigure' }, execute: vi.fn() },
  deleteMcpServerUseCase: { operation: { id: 'mcp_servers.delete' }, execute: vi.fn() },
  executeCopilotMcpServerUseCase: vi.fn(),
}))

vi.mock('@/lib/posthog/server', () => posthogServerMock)
vi.mock('@/lib/mcp/application/use-cases', () => ({
  listMcpServersUseCase,
  registerMcpServerUseCase,
  reconfigureMcpServerUseCase,
  deleteMcpServerUseCase,
}))
vi.mock('@/local-copilot/lib/tools/execute-mcp-server-use-case', () => ({
  executeCopilotMcpServerUseCase,
}))

import {
  executeLocalCopilotTool,
  type ToolExecutionContext,
} from '@/local-copilot/lib/tools/executor'
import { executeManageMcpConnection } from '@/local-copilot/lib/tools/manage-mcp-connection'
import { resolveLocalCopilotToolName } from '@/local-copilot/lib/tools/resolve-tool-name-alias'
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
  }
}

describe('resolveLocalCopilotToolName aliases', () => {
  it('maps stale names onto working Arena leaves', () => {
    expect(resolveLocalCopilotToolName('manage_mcp_tool')).toEqual({
      kind: 'ok',
      name: 'manage_mcp_connection',
    })
    expect(resolveLocalCopilotToolName('list_user_workspaces')).toEqual({
      kind: 'ok',
      name: 'list_workspaces',
    })
    expect(resolveLocalCopilotToolName('search_documentation')).toEqual({
      kind: 'ok',
      name: 'search_docs',
    })
  })
})

describe('executeManageMcpConnection', () => {
  beforeEach(() => {
    executeCopilotMcpServerUseCase.mockReset()
  })

  it('rejects a missing operation before touching MCP use cases', async () => {
    const result = await executeManageMcpConnection({}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/operation/i)
    expect(executeCopilotMcpServerUseCase).not.toHaveBeenCalled()
  })

  it('denies add when the caller lacks workspace write', async () => {
    const result = await executeManageMcpConnection(
      {
        operation: 'add',
        config: { name: 'Metabase', url: 'https://mcp.example/metabase' },
      },
      toolCtx('read')
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/requires write access/i)
    expect(executeCopilotMcpServerUseCase).not.toHaveBeenCalled()
  })

  it('lists MCP servers for a read-only caller', async () => {
    executeCopilotMcpServerUseCase.mockResolvedValue({
      servers: [
        {
          id: 'srv-1',
          name: 'Metabase',
          url: 'https://mcp.example/metabase',
          transport: 'streamable-http',
          enabled: true,
          connectionStatus: 'connected',
        },
      ],
    })

    const result = await executeManageMcpConnection({ operation: 'list' }, toolCtx('read'))

    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      success: true,
      operation: 'list',
      count: 1,
      servers: [{ id: 'srv-1', name: 'Metabase' }],
    })
    expect(executeCopilotMcpServerUseCase).toHaveBeenCalledWith(
      expect.objectContaining({ userId, workspaceId }),
      listMcpServersUseCase,
      { workspaceId }
    )
  })

  it('requires config.name and config.url for add', async () => {
    const result = await executeManageMcpConnection(
      { operation: 'add', config: { name: 'Metabase' } },
      toolCtx()
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/config\.name and config\.url/i)
    expect(executeCopilotMcpServerUseCase).not.toHaveBeenCalled()
  })
})

describe('executeLocalCopilotTool(manage_mcp_connection)', () => {
  beforeEach(() => {
    executeCopilotMcpServerUseCase.mockReset()
    executeCopilotMcpServerUseCase.mockResolvedValue({ servers: [] })
  })

  it('runs locally instead of mothership fallthrough', async () => {
    const result = await executeLocalCopilotTool(
      'manage_mcp_connection',
      { operation: 'list' },
      toolCtx()
    )

    expect(result.success).toBe(true)
    expect(String(result.error ?? '')).not.toMatch(/tool not found/i)
    expect(result.result).toMatchObject({ success: true, operation: 'list', count: 0 })
  })

  it('accepts the legacy manage_mcp_tool alias', async () => {
    const result = await executeLocalCopilotTool(
      'manage_mcp_tool',
      { operation: 'list' },
      toolCtx()
    )

    expect(result.success).toBe(true)
    expect(result.toolName).toBe('manage_mcp_connection')
    expect(executeCopilotMcpServerUseCase).toHaveBeenCalled()
  })
})
