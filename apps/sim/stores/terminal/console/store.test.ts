import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSaveBlob } = vi.hoisted(() => ({
  mockSaveBlob: vi.fn(),
}))

vi.mock('@/lib/uploads/client/download', () => ({
  saveBlob: mockSaveBlob,
}))

vi.unmock('@/stores/terminal')
vi.unmock('@/stores/terminal/console/store')

import { useTerminalConsoleStore } from '@/stores/terminal/console/store'

describe('terminal console store', () => {
  beforeEach(() => {
    mockSaveBlob.mockClear()
    useTerminalConsoleStore.setState({
      workflowEntries: {},
      entryIdsByBlockExecution: {},
      entryLocationById: {},
      isOpen: false,
      _hasHydrated: true,
    })
  })

  it('neutralizes formula-leading text in CSV exports', async () => {
    useTerminalConsoleStore.getState().addConsole({
      workflowId: 'wf-1',
      blockId: 'block-1',
      blockName: 'Function',
      blockType: 'function',
      executionId: 'exec-1',
      executionOrder: 1,
      error: '=1+1',
    })

    useTerminalConsoleStore.getState().exportConsoleCSV('wf-1')

    expect(mockSaveBlob).toHaveBeenCalledOnce()
    const [blob, filename] = mockSaveBlob.mock.calls[0] as [Blob, string]
    expect(filename).toMatch(/^terminal-console-wf-1-.*\.csv$/)
    await expect(blob.text()).resolves.toContain(",'=1+1,")
  })

  it('normalizes oversized payloads when adding console entries', () => {
    useTerminalConsoleStore.getState().addConsole({
      workflowId: 'wf-1',
      blockId: 'block-1',
      blockName: 'Function',
      blockType: 'function',
      executionId: 'exec-1',
      executionOrder: 1,
      output: {
        a: 'x'.repeat(100_000),
        b: 'y'.repeat(100_000),
        c: 'z'.repeat(100_000),
        d: 'q'.repeat(100_000),
        e: 'r'.repeat(100_000),
        f: 's'.repeat(100_000),
      },
    })

    const [entry] = useTerminalConsoleStore.getState().getWorkflowEntries('wf-1')

    expect(entry.output).toMatchObject({
      __simTruncated: true,
    })
  })

  it('updates one workflow without replacing unrelated workflow arrays', () => {
    useTerminalConsoleStore.getState().addConsole({
      workflowId: 'wf-1',
      blockId: 'block-1',
      blockName: 'Function',
      blockType: 'function',
      executionId: 'exec-1',
      executionOrder: 1,
      output: { ok: true },
    })

    useTerminalConsoleStore.getState().addConsole({
      workflowId: 'wf-2',
      blockId: 'block-2',
      blockName: 'Function',
      blockType: 'function',
      executionId: 'exec-2',
      executionOrder: 1,
      output: { ok: true },
    })

    const before = useTerminalConsoleStore.getState()
    const workflowTwoEntries = before.workflowEntries['wf-2']

    useTerminalConsoleStore.getState().updateConsole(
      'block-1',
      {
        executionOrder: 1,
        replaceOutput: { status: 'updated' },
      },
      'exec-1'
    )

    const after = useTerminalConsoleStore.getState()

    expect(after.workflowEntries['wf-2']).toBe(workflowTwoEntries)
    expect(after.getWorkflowEntries('wf-1')[0].output).toMatchObject({ status: 'updated' })
  })

  describe('cancelRunningEntries', () => {
    it('only cancels running entries for the requested execution when provided', () => {
      useTerminalConsoleStore.getState().addConsole({
        workflowId: 'wf-1',
        blockId: 'block-1',
        blockName: 'Function 1',
        blockType: 'function',
        executionId: 'exec-1',
        executionOrder: 1,
        isRunning: true,
      })
      useTerminalConsoleStore.getState().addConsole({
        workflowId: 'wf-1',
        blockId: 'block-2',
        blockName: 'Function 2',
        blockType: 'function',
        executionId: 'exec-2',
        executionOrder: 2,
        isRunning: true,
      })

      useTerminalConsoleStore.getState().cancelRunningEntries('wf-1', 'exec-1')

      const entries = useTerminalConsoleStore.getState().getWorkflowEntries('wf-1')
      expect(entries.find((entry) => entry.executionId === 'exec-1')).toMatchObject({
        isCanceled: true,
        isRunning: false,
      })
      expect(entries.find((entry) => entry.executionId === 'exec-2')).toMatchObject({
        isRunning: true,
      })
    })
  })

  describe('finishRunningEntries', () => {
    it('settles running entries without marking them canceled', () => {
      useTerminalConsoleStore.getState().addConsole({
        workflowId: 'wf-1',
        blockId: 'block-1',
        blockName: 'Function',
        blockType: 'function',
        executionId: 'exec-1',
        executionOrder: 1,
        isRunning: true,
        startedAt: new Date(Date.now() - 1000).toISOString(),
      })

      useTerminalConsoleStore.getState().finishRunningEntries('wf-1', 'exec-1')

      const [entry] = useTerminalConsoleStore.getState().getWorkflowEntries('wf-1')
      expect(entry.isCanceled).toBe(false)
      expect(entry.isRunning).toBe(false)
      expect(entry.endedAt).toBeDefined()
    })

    it('settles live agent stream chrome when finishing', () => {
      useTerminalConsoleStore.getState().addConsole({
        workflowId: 'wf-1',
        blockId: 'block-1',
        blockName: 'Agent',
        blockType: 'agent',
        executionId: 'exec-1',
        executionOrder: 1,
        isRunning: true,
        agentStreamActive: true,
        agentStreamToolCalls: [
          {
            key: 'block-1:t1',
            id: 't1',
            name: 'http_request',
            displayName: 'HTTP Request',
            status: 'running',
          },
        ],
      })

      useTerminalConsoleStore.getState().finishRunningEntries('wf-1', 'exec-1')

      const [entry] = useTerminalConsoleStore.getState().getWorkflowEntries('wf-1')
      expect(entry.agentStreamActive).toBe(false)
      expect(entry.agentStreamToolCalls?.[0]?.status).toBe('success')
    })
  })

  describe('updateConsole agent stream chrome', () => {
    it('settles running tools and clears agentStreamActive when a block errors', () => {
      useTerminalConsoleStore.getState().addConsole({
        workflowId: 'wf-1',
        blockId: 'block-1',
        blockName: 'Agent',
        blockType: 'agent',
        executionId: 'exec-1',
        executionOrder: 1,
        isRunning: true,
        agentStreamActive: true,
        agentStreamThinking: 'working…',
        agentStreamToolCalls: [
          {
            key: 'block-1:t1',
            id: 't1',
            name: 'http_request',
            displayName: 'HTTP Request',
            status: 'running',
          },
        ],
      })

      useTerminalConsoleStore.getState().updateConsole(
        'block-1',
        {
          isRunning: false,
          success: false,
          error: 'timeout',
        },
        'exec-1'
      )

      const [entry] = useTerminalConsoleStore.getState().getWorkflowEntries('wf-1')
      expect(entry.agentStreamActive).toBe(false)
      expect(entry.agentStreamThinking).toBe('working…')
      expect(entry.agentStreamToolCalls?.[0]?.status).toBe('error')
    })

    it('clears thinking without changing an active block when projection is unavailable', () => {
      useTerminalConsoleStore.getState().addConsole({
        workflowId: 'wf-1',
        blockId: 'block-1',
        blockName: 'Agent',
        blockType: 'agent',
        executionId: 'exec-1',
        executionOrder: 1,
        isRunning: true,
        agentStreamActive: true,
        agentStreamThinking: 'projected thinking',
      })

      useTerminalConsoleStore
        .getState()
        .updateConsole('block-1', { clearAgentStreamThinking: true }, 'exec-1')

      const [entry] = useTerminalConsoleStore.getState().getWorkflowEntries('wf-1')
      expect(entry.isRunning).toBe(true)
      expect(entry.agentStreamActive).toBe(true)
      expect(entry.agentStreamThinking).toBeUndefined()
    })
  })

  describe('loop iteration identity', () => {
    it('keeps distinct rows for the same block across loop iterations', () => {
      const store = useTerminalConsoleStore.getState()
      store.addConsole({
        workflowId: 'wf-1',
        blockId: 'fn-1',
        blockName: 'Function',
        blockType: 'function',
        executionId: 'exec-1',
        executionOrder: 1,
        isRunning: true,
        iterationCurrent: 0,
        iterationTotal: 4,
        iterationType: 'loop',
        iterationContainerId: 'loop-1',
      })
      store.addConsole({
        workflowId: 'wf-1',
        blockId: 'fn-1',
        blockName: 'Function',
        blockType: 'function',
        executionId: 'exec-1',
        executionOrder: 2,
        isRunning: true,
        iterationCurrent: 1,
        iterationTotal: 4,
        iterationType: 'loop',
        iterationContainerId: 'loop-1',
      })

      store.updateConsole(
        'fn-1',
        {
          executionOrder: 2,
          iterationCurrent: 1,
          iterationContainerId: 'loop-1',
          replaceOutput: { result: 'iter-1' },
          isRunning: false,
          success: true,
        },
        'exec-1'
      )
      store.updateConsole(
        'fn-1',
        {
          executionOrder: 1,
          iterationCurrent: 0,
          iterationContainerId: 'loop-1',
          replaceOutput: { result: 'iter-0' },
          isRunning: false,
          success: true,
        },
        'exec-1'
      )

      const entries = store.getWorkflowEntries('wf-1')
      const iter0 = entries.find((entry) => entry.iterationCurrent === 0)
      const iter1 = entries.find((entry) => entry.iterationCurrent === 1)
      expect(iter0?.output).toMatchObject({ result: 'iter-0' })
      expect(iter1?.output).toMatchObject({ result: 'iter-1' })
      expect(entries).toHaveLength(2)
    })

    it('does not paint identity-less stream chrome onto completed iterations', () => {
      const store = useTerminalConsoleStore.getState()
      store.addConsole({
        workflowId: 'wf-1',
        blockId: 'agent-1',
        blockName: 'Agent',
        blockType: 'agent',
        executionId: 'exec-1',
        executionOrder: 1,
        isRunning: false,
        success: true,
        iterationCurrent: 0,
        iterationType: 'loop',
        iterationContainerId: 'loop-1',
        output: { result: 'done-0' },
      })
      store.addConsole({
        workflowId: 'wf-1',
        blockId: 'agent-1',
        blockName: 'Agent',
        blockType: 'agent',
        executionId: 'exec-1',
        executionOrder: 2,
        isRunning: true,
        agentStreamActive: true,
        iterationCurrent: 1,
        iterationType: 'loop',
        iterationContainerId: 'loop-1',
      })

      store.updateConsole('agent-1', { agentStreamThinking: 'iter 1 thinking' }, 'exec-1')

      const entries = store.getWorkflowEntries('wf-1')
      const iter0 = entries.find((entry) => entry.iterationCurrent === 0)
      const iter1 = entries.find((entry) => entry.iterationCurrent === 1)
      expect(iter0?.agentStreamThinking).toBeUndefined()
      expect(iter0?.output).toMatchObject({ result: 'done-0' })
      expect(iter1?.agentStreamThinking).toBe('iter 1 thinking')
    })

    it('adds a new iteration row when a completion has no matching start', () => {
      const store = useTerminalConsoleStore.getState()
      store.addConsole({
        workflowId: 'wf-1',
        blockId: 'fn-1',
        blockName: 'Function',
        blockType: 'function',
        executionId: 'exec-1',
        executionOrder: 1,
        isRunning: false,
        success: true,
        iterationCurrent: 0,
        iterationType: 'loop',
        iterationContainerId: 'loop-1',
        output: { result: 'iter-0' },
      })

      store.updateConsole(
        'fn-1',
        {
          executionOrder: 4,
          iterationCurrent: 3,
          iterationTotal: 4,
          iterationType: 'loop',
          iterationContainerId: 'loop-1',
          replaceOutput: { result: 'iter-3' },
          isRunning: false,
          success: true,
        },
        'exec-1'
      )

      const entries = store.getWorkflowEntries('wf-1')
      expect(entries).toHaveLength(2)
      const iter3 = entries.find((entry) => entry.iterationCurrent === 3)
      const iter0 = entries.find((entry) => entry.iterationCurrent === 0)
      expect(iter3?.output).toMatchObject({ result: 'iter-3' })
      expect(iter0?.output).toMatchObject({ result: 'iter-0' })
    })
  })
})
