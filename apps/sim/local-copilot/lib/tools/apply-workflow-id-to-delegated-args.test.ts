/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - open_resource must not receive a pinned/stray workflowId (strict schema)
 * - workflow-scoped tools still require and pin workflowId
 * - optional-schema tools (query_logs) still accept a pin when present
 */
import { describe, expect, it } from 'vitest'
import {
  applyWorkflowIdToDelegatedArgs,
  delegatedToolSchemaAcceptsWorkflowId,
} from '@/local-copilot/lib/tools/mothership-delegated-tool-defs'

describe('delegatedToolSchemaAcceptsWorkflowId', () => {
  it('rejects open_resource (strict panel tool)', () => {
    expect(delegatedToolSchemaAcceptsWorkflowId('open_resource')).toBe(false)
  })

  it('accepts run_workflow (top-level workflowId in schema)', () => {
    expect(delegatedToolSchemaAcceptsWorkflowId('run_workflow')).toBe(true)
  })
})

describe('applyWorkflowIdToDelegatedArgs', () => {
  it('does not pin context workflowId onto open_resource args', () => {
    const result = applyWorkflowIdToDelegatedArgs({
      toolName: 'open_resource',
      args: {
        workspaceId: 'ws-1',
        resources: [{ type: 'workflow', id: 'wf-1' }],
      },
      workflowId: 'wf-from-context',
    })

    expect(result.pinned).toBe(false)
    expect(result.required).toBe(false)
    expect(result.args).toEqual({
      workspaceId: 'ws-1',
      resources: [{ type: 'workflow', id: 'wf-1' }],
    })
    expect(result.args).not.toHaveProperty('workflowId')
  })

  it('strips a stray workflowId from open_resource args', () => {
    const result = applyWorkflowIdToDelegatedArgs({
      toolName: 'open_resource',
      args: {
        resources: [{ type: 'workflow', id: 'wf-1' }],
        workflowId: 'should-not-survive',
      },
      workflowId: 'wf-from-context',
    })

    expect(result.args).not.toHaveProperty('workflowId')
  })

  it('pins workflowId for workflow-scoped tools', () => {
    const result = applyWorkflowIdToDelegatedArgs({
      toolName: 'run_workflow',
      args: { workflow_input: {} },
      workflowId: 'wf-1',
    })

    expect(result).toEqual({
      required: true,
      pinned: true,
      args: { workflow_input: {}, workflowId: 'wf-1' },
    })
  })

  it('reports required-but-unpinned when a scoped tool has no workflowId', () => {
    const result = applyWorkflowIdToDelegatedArgs({
      toolName: 'get_workflow_data',
      args: {},
      workflowId: undefined,
    })
    expect(result.required).toBe(true)
    expect(result.pinned).toBe(false)
    expect(result.args).not.toHaveProperty('workflowId')
  })

  it('does not pin context workflowId onto query_logs (no top-level schema field)', () => {
    const result = applyWorkflowIdToDelegatedArgs({
      toolName: 'query_logs',
      args: { limit: 10 },
      workflowId: 'wf-1',
    })

    expect(result.required).toBe(false)
    expect(result.pinned).toBe(false)
    expect(result.args).toEqual({ limit: 10 })
  })
})
