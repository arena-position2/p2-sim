/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - missing operation → rejected
 * - add without schema/code → rejected before use cases
 * - write ops denied without workspace write
 * - list happy path (regression: must not Tool not found)
 */
import { posthogServerMock } from '@sim/testing/mocks/posthog-server.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listAvailableCustomToolsUseCase,
  createWorkspaceCustomToolUseCase,
  updateWorkspaceCustomToolUseCase,
  deleteWorkspaceCustomToolUseCase,
  executeCopilotCustomToolUseCase,
} = vi.hoisted(() => ({
  listAvailableCustomToolsUseCase: { operation: { id: 'custom_tools.list_available' } },
  createWorkspaceCustomToolUseCase: { operation: { id: 'custom_tools.create' } },
  updateWorkspaceCustomToolUseCase: { operation: { id: 'custom_tools.update' } },
  deleteWorkspaceCustomToolUseCase: { operation: { id: 'custom_tools.delete' } },
  executeCopilotCustomToolUseCase: vi.fn(),
}))

vi.mock('@/lib/posthog/server', () => posthogServerMock)
vi.mock('@/lib/custom-tools/application/use-cases', () => ({
  listAvailableCustomToolsUseCase,
  createWorkspaceCustomToolUseCase,
  updateWorkspaceCustomToolUseCase,
  deleteWorkspaceCustomToolUseCase,
}))
vi.mock('@/lib/mothership/application/execute-custom-tool-use-case', () => ({
  executeCopilotCustomToolUseCase,
}))

import {
  executeLocalCopilotTool,
  type ToolExecutionContext,
} from '@/local-copilot/lib/tools/executor'
import { executeManageCustomTool } from '@/local-copilot/lib/tools/manage-custom-tool'
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

describe('executeManageCustomTool', () => {
  beforeEach(() => {
    executeCopilotCustomToolUseCase.mockReset()
  })

  it('rejects a missing operation before touching use cases', async () => {
    const result = await executeManageCustomTool({}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/operation/i)
    expect(executeCopilotCustomToolUseCase).not.toHaveBeenCalled()
  })

  it('rejects add without schema/code', async () => {
    const result = await executeManageCustomTool({ operation: 'add' }, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/schema|code/i)
    expect(executeCopilotCustomToolUseCase).not.toHaveBeenCalled()
  })

  it('denies add without workspace write', async () => {
    const result = await executeManageCustomTool(
      {
        operation: 'add',
        schema: { type: 'function', function: { name: 'echo', parameters: {} } },
        code: 'return args',
      },
      toolCtx('read')
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/permission|write|denied/i)
    expect(executeCopilotCustomToolUseCase).not.toHaveBeenCalled()
  })

  it('lists custom tools', async () => {
    executeCopilotCustomToolUseCase.mockResolvedValue({
      tools: [{ id: 't1', title: 'Echo' }],
    })
    const result = await executeManageCustomTool({ operation: 'list' }, toolCtx())
    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({ count: 1, operation: 'list' })
  })
})

describe('executeLocalCopilotTool(manage_custom_tool)', () => {
  beforeEach(() => {
    executeCopilotCustomToolUseCase.mockReset()
    executeCopilotCustomToolUseCase.mockResolvedValue({ tools: [] })
  })

  it('executes locally instead of mothership Tool not found', async () => {
    const result = await executeLocalCopilotTool(
      'manage_custom_tool',
      { operation: 'list' },
      toolCtx()
    )
    expect(result.success).toBe(true)
    expect(result.toolName).toBe('manage_custom_tool')
    expect(result.error).toBeUndefined()
  })
})
