/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - rename without name → rejected
 * - delete without ids → rejected
 * - executor early intercept for rename_workflow
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

import {
  executeLocalCopilotTool,
  type ToolExecutionContext,
} from '@/local-copilot/lib/tools/executor'
import { executeWorkflowOrgTool } from '@/local-copilot/lib/tools/workflow-org-tools'
import type { LocalCopilotStructuredContext } from '@/local-copilot/lib/types'

const workspaceId = 'workspace-1'
const userId = 'user-1'

function toolCtx(): ToolExecutionContext {
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
    userPermission: 'admin',
    structuredContext,
    workflowId: 'workflow-1',
  }
}

describe('executeWorkflowOrgTool', () => {
  beforeEach(() => {
    executeCopilotWorkflowUseCase.mockReset()
  })

  it('rejects rename without name', async () => {
    const result = await executeWorkflowOrgTool('rename_workflow', {}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/name/i)
    expect(executeCopilotWorkflowUseCase).not.toHaveBeenCalled()
  })

  it('rejects delete without workflow ids', async () => {
    const result = await executeWorkflowOrgTool('delete_workflow', {}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/workflowIds/i)
    expect(executeCopilotWorkflowUseCase).not.toHaveBeenCalled()
  })

  it('renames a workflow', async () => {
    executeCopilotWorkflowUseCase.mockResolvedValue({})
    const result = await executeWorkflowOrgTool('rename_workflow', { name: 'Orders v2' }, toolCtx())
    expect(result.success).toBe(true)
    expect(result.output).toEqual({ workflowId: 'workflow-1', name: 'Orders v2' })
  })
})

describe('executeLocalCopilotTool(rename_workflow)', () => {
  beforeEach(() => {
    executeCopilotWorkflowUseCase.mockReset()
    executeCopilotWorkflowUseCase.mockResolvedValue({})
  })

  it('executes locally instead of mothership Tool not found', async () => {
    const result = await executeLocalCopilotTool('rename_workflow', { name: 'Renamed' }, toolCtx())
    expect(result.success).toBe(true)
    expect(result.toolName).toBe('rename_workflow')
  })
})
