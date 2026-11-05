/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - deploy_api without versionName/versionDescription → rejected
 * - check_deployment_status without workflowId → rejected
 * - stub remaining tools return guidance (not Tool not found)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeCopilotWorkflowUseCase, listLiveWorkflowMcpToolsForWorkflow } = vi.hoisted(() => ({
  executeCopilotWorkflowUseCase: vi.fn(),
  listLiveWorkflowMcpToolsForWorkflow: vi.fn(),
}))

vi.mock('@/lib/mothership/application/execute-workflow-use-case', () => ({
  executeCopilotWorkflowUseCase,
  messageForCopilotWorkflowError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}))
vi.mock('@/lib/mcp/queries', () => ({
  listLiveWorkflowMcpToolsForWorkflow,
}))
vi.mock('@/lib/mcp/urls', () => ({
  buildWorkflowMcpApiEndpoint: (id: string) =>
    `https://example.test/api/v2/workflows/${id}/execute`,
}))
vi.mock('@/lib/core/utils/urls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/utils/urls')>()
  return { ...actual, getBaseUrl: () => 'https://example.test' }
})
vi.mock('@/lib/core/utils/request', () => ({
  generateRequestId: () => 'req-1',
}))

import { executeDeploymentTool } from '@/local-copilot/lib/tools/deployment-tools'
import {
  executeLocalCopilotTool,
  type ToolExecutionContext,
} from '@/local-copilot/lib/tools/executor'
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

describe('executeDeploymentTool', () => {
  beforeEach(() => {
    executeCopilotWorkflowUseCase.mockReset()
    listLiveWorkflowMcpToolsForWorkflow.mockReset()
    listLiveWorkflowMcpToolsForWorkflow.mockResolvedValue([])
  })

  it('rejects deploy_api without version fields', async () => {
    const result = await executeDeploymentTool('deploy_api', { action: 'deploy' }, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/versionDescription|versionName/i)
    expect(executeCopilotWorkflowUseCase).not.toHaveBeenCalled()
  })

  it('checks deployment status', async () => {
    executeCopilotWorkflowUseCase.mockResolvedValue({
      isDeployed: true,
      needsRedeployment: false,
      workflow: { deployedAt: null },
      workspaceId,
      activeDeployment: { version: 1 },
      latestDeploymentAttempt: { isCurrent: true, status: 'active' },
    })

    const result = await executeDeploymentTool('check_deployment_status', {}, toolCtx())
    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      isDeployed: true,
      api: { isDeployed: true },
      mcp: { isDeployed: false },
    })
  })
})

describe('executeLocalCopilotTool remaining stubs', () => {
  it('returns guidance for get_deployed_workflow_state instead of Tool not found', async () => {
    const result = await executeLocalCopilotTool('get_deployed_workflow_state', {}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/check_deployment_status|diff_workflows/i)
    expect(result.error).not.toMatch(/Tool not found/i)
  })
})
