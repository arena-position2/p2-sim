/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  createToolStagnationTracker,
  fingerprintToolCall,
  resolveStagnationAction,
} from '@/local-copilot/lib/agent/tool-stagnation'

const path = 'files/ad-generator (10).html'

function miss(search: string, errorType: string) {
  return {
    args: JSON.stringify({
      operation: 'patch',
      target: { path },
      edit: { strategy: 'search_replace', search },
    }),
    result: {
      success: false,
      errorType,
      message: `Patch failed: ${search}`,
      data: { vfsPath: path, operation: 'patch' },
    },
  }
}

describe('workspace_file patch stagnation', () => {
  it('treats different searches with the same error type as one loop', () => {
    const escaped = miss('<div class=\\"drop\\">', 'search_not_found')
    const plain = miss('<div class="drop">', 'search_not_found')
    expect(fingerprintToolCall('workspace_file', escaped.args, false, escaped.result)).toBe(
      fingerprintToolCall('workspace_file', plain.args, false, plain.result)
    )
  })

  it('keeps search_not_found and search_repeated in different buckets', () => {
    const notFound = miss('<div class="drop">', 'search_not_found')
    const repeated = miss('<div class="drop">', 'search_repeated')
    expect(fingerprintToolCall('workspace_file', notFound.args, false, notFound.result)).not.toBe(
      fingerprintToolCall('workspace_file', repeated.args, false, repeated.result)
    )
  })

  it('stops on the second search_not_found while patch-repair is still pending', () => {
    const tracker = createToolStagnationTracker()
    const first = miss('first block', 'search_not_found')
    const second = miss('second block', 'search_not_found')
    expect(tracker.record('workspace_file', first.args, false, first.result)).toBeNull()
    const hit = tracker.record('workspace_file', second.args, false, second.result)
    expect(hit?.toolName).toBe('workspace_file')
    expect(hit?.count).toBe(2)
    const action = resolveStagnationAction(hit!, ['workspace_file:patch-repair'])
    expect(action.stop).toBe(true)
    expect(action.systemMessage).not.toMatch(/still pending/i)
  })

  it('keeps nudging when a different follow-up is pending', () => {
    const tracker = createToolStagnationTracker()
    const args = JSON.stringify({ operations: [{ block_id: 'a', operation_type: 'edit' }] })
    const result = { success: false, error: 'same failure' }
    expect(tracker.record('edit_workflow', args, false, result)).toBeNull()
    expect(tracker.record('edit_workflow', args, false, result)).toBeNull()
    const hit = tracker.record('edit_workflow', args, false, result)
    expect(hit).not.toBeNull()
    const action = resolveStagnationAction(hit!, ['create_workflow:populate'])
    expect(action.stop).toBe(false)
    expect(action.systemMessage).toMatch(/still pending/i)
  })
})
