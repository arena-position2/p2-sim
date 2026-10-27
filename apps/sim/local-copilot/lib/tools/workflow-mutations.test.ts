/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeCreateWorkflow } = vi.hoisted(() => ({
  executeCreateWorkflow: vi.fn(),
}))

vi.mock('@/lib/mothership/tools/handlers/workflow/mutations', () => ({
  executeCreateWorkflow,
}))

vi.mock('@/lib/mothership/tools/server/workflow/edit-workflow', () => ({
  editWorkflowServerTool: { execute: vi.fn() },
}))

vi.mock('@/lib/mothership/tools/server/workflow/edit-workflow/normalize-args', () => ({
  normalizeEditWorkflowArgs: (args: Record<string, unknown>) => args,
  resolveEditWorkflowOperations: () => null,
}))

import { editWorkflowServerTool } from '@/lib/mothership/tools/server/workflow/edit-workflow'
import {
  runCreateWorkflowTool,
  runEditWorkflowTool,
} from '@/local-copilot/lib/tools/workflow-mutations'

describe('runCreateWorkflowTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    executeCreateWorkflow.mockResolvedValue({ success: true, output: { workflowId: 'wf-1' } })
  })

  it('refuses to create without a trusted tool call ID', async () => {
    const result = await runCreateWorkflowTool(
      { name: 'Lead Router' },
      { userId: 'user-1', workspaceId: 'workspace-1' }
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/tool call ID/)
    expect(executeCreateWorkflow).not.toHaveBeenCalled()
  })

  it('passes trusted Copilot execution context into the create use case', async () => {
    await runCreateWorkflowTool(
      { name: 'Lead Router' },
      {
        userId: 'user-1',
        workspaceId: 'workspace-1',
        workflowId: '',
        chatId: 'chat-1',
        activeToolCallId: 'tool-call-1',
      }
    )

    expect(executeCreateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Lead Router', workspaceId: 'workspace-1' }),
      expect.objectContaining({
        userId: 'user-1',
        workspaceId: 'workspace-1',
        chatId: 'chat-1',
        copilotToolExecution: true,
        toolCallId: 'tool-call-1',
      })
    )
  })
})

describe('runEditWorkflowTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses to edit without a trusted tool call ID', async () => {
    const result = await runEditWorkflowTool(
      { workflowId: 'wf-1', operations: [{ block_id: 'a', operation_type: 'add' }] },
      { userId: 'user-1', workspaceId: 'workspace-1' }
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/tool call ID/)
    expect(editWorkflowServerTool.execute).not.toHaveBeenCalled()
  })
})
