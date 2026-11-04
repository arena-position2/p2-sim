/**
 * Failure modes for Local's Cloud-parity client workflow path:
 * - missing run/toolCall id → error (cannot bind async row / wait)
 * - missing workflowId → error (execute route would reject)
 * - browser never reports → timeout error the model can retry from
 * - success/error completions map into ToolExecutionResult
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MothershipStreamV1ToolOutcome } from '@/lib/mothership/generated/mothership-stream-v1'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const waitForWorkflowToolCompletion = vi.hoisted(() => vi.fn())
const upsertAsyncToolCall = vi.hoisted(() => vi.fn())
const sealClientToolContext = vi.hoisted(() => vi.fn())

vi.mock('@/lib/mothership/request/tools/client', () => ({
  waitForWorkflowToolCompletion,
}))

vi.mock('@/lib/mothership/async-runs/repository', () => ({
  upsertAsyncToolCall,
}))

vi.mock('@/lib/mothership/request/tools/client-completion-seal.server', () => ({
  sealClientToolContext,
}))

import {
  localClientWorkflowToolCallFrame,
  persistLocalClientWorkflowToolCall,
  shouldRunLocalWorkflowToolOnClient,
  waitForLocalClientWorkflowTool,
} from '@/local-copilot/lib/tools/client-workflow-run'

function toolCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    userId: 'user-1',
    workspaceId: 'ws-1',
    structuredContext: {} as ToolExecutionContext['structuredContext'],
    ...overrides,
  }
}

describe('shouldRunLocalWorkflowToolOnClient', () => {
  it('hands workflow run tools to the browser and leaves other tools server-side', () => {
    expect(shouldRunLocalWorkflowToolOnClient('run_workflow')).toBe(true)
    expect(shouldRunLocalWorkflowToolOnClient('run_block')).toBe(true)
    expect(shouldRunLocalWorkflowToolOnClient('edit_workflow')).toBe(false)
  })
})

describe('localClientWorkflowToolCallFrame', () => {
  it('marks the call as client-executable so the canvas starts the run', () => {
    const frame = localClientWorkflowToolCallFrame({
      toolCallId: 'tc-1',
      toolName: 'run_workflow',
      args: { workflowId: 'wf-1' },
    })
    expect(frame.executor).toBe('client')
    expect(frame.ui.clientExecutable).toBe(true)
    expect(frame.status).toBe('executing')
    expect(frame.arguments).toEqual({ workflowId: 'wf-1' })
  })
})

describe('persistLocalClientWorkflowToolCall', () => {
  beforeEach(() => {
    upsertAsyncToolCall.mockReset().mockResolvedValue(null)
    sealClientToolContext.mockReset()
  })

  it('pins workflowId from the run context before persisting the async row', async () => {
    const pinned = await persistLocalClientWorkflowToolCall({
      runId: 'run-1',
      toolCallId: 'tc-1',
      toolName: 'run_workflow',
      args: { workflow_input: { url: 'https://example.com' } },
      userId: 'user-1',
      workflowId: 'wf-from-run',
    })

    expect(pinned.workflowId).toBe('wf-from-run')
    expect(upsertAsyncToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        toolCallId: 'tc-1',
        toolName: 'run_workflow',
        status: 'running',
        args: expect.objectContaining({ workflowId: 'wf-from-run' }),
      })
    )
  })
})

describe('waitForLocalClientWorkflowTool', () => {
  beforeEach(() => {
    waitForWorkflowToolCompletion.mockReset()
  })

  it('fails closed when runId or toolCallId is missing', async () => {
    const missingRun = await waitForLocalClientWorkflowTool({
      toolName: 'run_workflow',
      args: { workflowId: 'wf-1' },
      ctx: toolCtx({ activeToolCallId: 'tc-1' }),
    })
    expect(missingRun.success).toBe(false)
    expect(missingRun.error).toMatch(/missing run or tool call id/i)

    const missingCall = await waitForLocalClientWorkflowTool({
      toolName: 'run_workflow',
      args: { workflowId: 'wf-1' },
      ctx: toolCtx({ runId: 'run-1' }),
    })
    expect(missingCall.success).toBe(false)
    expect(missingCall.error).toMatch(/missing run or tool call id/i)
  })

  it('fails closed when workflowId cannot be resolved', async () => {
    const result = await waitForLocalClientWorkflowTool({
      toolName: 'run_workflow',
      args: {},
      ctx: toolCtx({ runId: 'run-1', activeToolCallId: 'tc-1' }),
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/workflowId is required/i)
    expect(waitForWorkflowToolCompletion).not.toHaveBeenCalled()
  })

  it('surfaces a retryable error when the browser never completes', async () => {
    waitForWorkflowToolCompletion.mockResolvedValueOnce(null)
    const result = await waitForLocalClientWorkflowTool({
      toolName: 'run_workflow',
      args: { workflowId: 'wf-1' },
      ctx: toolCtx({ runId: 'run-1', activeToolCallId: 'tc-1' }),
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timed out waiting for the browser/i)
  })

  it('returns block logs from a successful browser completion for the model', async () => {
    waitForWorkflowToolCompletion.mockResolvedValueOnce({
      status: MothershipStreamV1ToolOutcome.success,
      message: 'Workflow execution completed.',
      data: {
        success: true,
        workflowId: 'wf-1',
        executionId: 'exec-1',
        logs: [{ blockName: 'Scrape Page', success: true }],
      },
    })

    const result = await waitForLocalClientWorkflowTool({
      toolName: 'run_workflow',
      args: { workflowId: 'wf-1' },
      ctx: toolCtx({ runId: 'run-1', activeToolCallId: 'tc-1' }),
    })

    expect(result.success).toBe(true)
    expect(result.result).toMatchObject({
      executionId: 'exec-1',
      logs: [{ blockName: 'Scrape Page', success: true }],
    })
  })

  it('passes a failed browser run through so the model can fix and rerun', async () => {
    waitForWorkflowToolCompletion.mockResolvedValueOnce({
      status: MothershipStreamV1ToolOutcome.error,
      message: 'Block Extract Fields failed',
      data: {
        success: false,
        workflowId: 'wf-1',
        executionId: 'exec-2',
        error: 'Block Extract Fields failed',
        logs: [{ blockName: 'Extract Fields', success: false }],
      },
    })

    const result = await waitForLocalClientWorkflowTool({
      toolName: 'run_workflow',
      args: { workflowId: 'wf-1' },
      ctx: toolCtx({ runId: 'run-1', activeToolCallId: 'tc-1' }),
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Block Extract Fields failed')
    expect(result.result).toMatchObject({
      executionId: 'exec-2',
      logs: [{ blockName: 'Extract Fields', success: false }],
    })
  })
})
