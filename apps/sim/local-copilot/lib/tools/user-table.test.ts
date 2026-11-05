/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - missing operation → rejected without table use-case calls
 * - unsupported operation → clear Local message (not "Tool not found")
 * - get_schema without tableId → rejected
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeCopilotTableUseCase } = vi.hoisted(() => ({
  executeCopilotTableUseCase: vi.fn(),
}))

vi.mock('@/lib/mothership/application/execute-table-use-case', () => ({
  executeCopilotTableUseCase,
}))

vi.mock('@/lib/mothership/application/execute-workflow-use-case', () => ({
  executeCopilotWorkflowUseCase: vi.fn(),
  messageForCopilotWorkflowError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}))

import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'
import { executeUserTable } from '@/local-copilot/lib/tools/user-table'
import type { LocalCopilotStructuredContext } from '@/local-copilot/lib/types'

function toolCtx(): ToolExecutionContext {
  const structuredContext: LocalCopilotStructuredContext = {
    workspace: { id: 'workspace-1', name: 'Workspace', environment: 'self_hosted' },
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
    userId: 'user-1',
    workspaceId: 'workspace-1',
    userPermission: 'admin',
    structuredContext,
    activeToolCallId: 'tool-1',
  }
}

describe('executeUserTable', () => {
  beforeEach(() => {
    executeCopilotTableUseCase.mockReset()
  })

  it('rejects a missing operation', async () => {
    const result = await executeUserTable({ args: { tableId: 'tbl_1' } }, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/operation/i)
    expect(executeCopilotTableUseCase).not.toHaveBeenCalled()
  })

  it('rejects unsupported operations with a Local message', async () => {
    const result = await executeUserTable(
      { operation: 'add_enrichment', args: { tableId: 'tbl_1' } },
      toolCtx()
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not available in Arena Local Copilot/i)
    expect(executeCopilotTableUseCase).not.toHaveBeenCalled()
  })

  it('rejects get_schema without tableId', async () => {
    const result = await executeUserTable({ operation: 'get_schema', args: {} }, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/tableId/i)
    expect(executeCopilotTableUseCase).not.toHaveBeenCalled()
  })

  it('loads schema through the table use case', async () => {
    executeCopilotTableUseCase.mockResolvedValue({
      table: {
        id: 'tbl_1',
        name: 'Scrapes',
        description: null,
        workspaceId: 'workspace-1',
        schema: { columns: [{ name: 'title', type: 'string' }] },
      },
      folderPath: '/',
    })

    const result = await executeUserTable(
      { operation: 'get_schema', args: { tableId: 'tbl_1' } },
      toolCtx()
    )

    expect(result.success).toBe(true)
    expect(result.result).toMatchObject({
      success: true,
      data: {
        table: expect.objectContaining({ id: 'tbl_1', name: 'Scrapes' }),
      },
    })
  })
})
