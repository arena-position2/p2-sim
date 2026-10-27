/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { ResolvedSecretTraceRegistry } from '@/executor/utils/resolved-secret-trace-registry'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

function baseCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    userId: 'user-1',
    workspaceId: 'workspace-1',
    structuredContext: {},
    ...overrides,
  }
}

describe('toCopilotServerToolContext', () => {
  it('forwards the active tool call ID onto the trusted Copilot context', () => {
    expect(toCopilotServerToolContext(baseCtx({ activeToolCallId: 'tool-call-1' }))).toEqual(
      expect.objectContaining({
        copilotToolExecution: true,
        toolCallId: 'tool-call-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
      })
    )
  })

  it('forwards the turn-scoped secret registry for model-egress projection', () => {
    const resolvedSecretTraceRegistry = new ResolvedSecretTraceRegistry()

    expect(toCopilotServerToolContext(baseCtx({ resolvedSecretTraceRegistry }))).toEqual(
      expect.objectContaining({
        resolvedSecretTraceRegistry,
      })
    )
  })

  it('defaults missing userPermission to write so create_file is not denied', () => {
    expect(toCopilotServerToolContext(baseCtx()).userPermission).toBe('write')
    expect(toCopilotServerToolContext(baseCtx({ userPermission: '' })).userPermission).toBe('write')
    expect(toCopilotServerToolContext(baseCtx({ userPermission: 'read' })).userPermission).toBe(
      'read'
    )
  })
})
