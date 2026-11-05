/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - use-case failure surfaces a Local tool error (not "Tool not found")
 * - success returns draft options from readCopilotWorkflowRunOptions
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeCopilotWorkflowUseCase } = vi.hoisted(() => ({
  executeCopilotWorkflowUseCase: vi.fn(),
}))

vi.mock('@/lib/mothership/application/execute-workflow-use-case', () => ({
  executeCopilotWorkflowUseCase,
  messageForCopilotWorkflowError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}))

import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'
import { executeGetWorkflowRunOptions } from '@/local-copilot/lib/tools/get-workflow-run-options'
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
    workflowId: 'workflow-1',
    activeToolCallId: 'tool-1',
  }
}

describe('executeGetWorkflowRunOptions', () => {
  beforeEach(() => {
    executeCopilotWorkflowUseCase.mockReset()
  })

  it('returns draft run options for a workflow', async () => {
    executeCopilotWorkflowUseCase.mockResolvedValue({
      options: [{ triggerBlockId: 'start-1', inputSchema: { type: 'object' } }],
    })

    const result = await executeGetWorkflowRunOptions({}, toolCtx(), 'workflow-1')

    expect(result.success).toBe(true)
    expect(result.result).toMatchObject({
      workflowId: 'workflow-1',
      version: 'draft',
      options: [{ triggerBlockId: 'start-1' }],
    })
  })

  it('surfaces use-case failures as tool errors', async () => {
    executeCopilotWorkflowUseCase.mockRejectedValue(new Error('Workflow has no saved state'))

    const result = await executeGetWorkflowRunOptions({}, toolCtx(), 'workflow-1')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no saved state/i)
  })
})
