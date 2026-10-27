/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_EXPLORE_TOTAL_WITHOUT_MUTATION,
  MAX_FILE_EXPLORE_WITHOUT_MUTATION,
} from '@/local-copilot/lib/agent/limits'
import {
  createFileExploreTracker,
  createToolStagnationTracker,
  extractFileExplorePathKey,
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

  it('keeps search_not_found and search_too_long in different buckets', () => {
    const tracker = createToolStagnationTracker()
    const notFound = miss('<div class="drop">', 'search_not_found')
    const tooLong = miss('<div class="drop">', 'search_too_long')
    expect(tracker.record('workspace_file', notFound.args, false, notFound.result)).toBeNull()
    expect(tracker.record('workspace_file', tooLong.args, false, tooLong.result)).toBeNull()
    expect(tracker.record('workspace_file', tooLong.args, false, tooLong.result)).not.toBeNull()
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

describe('file explore hard-stop', () => {
  const contentPath = 'files/Arena%20Agent%20Stack/ad-generator%20(13).html/content'

  it('groups URI-encoded content paths with their leaf file', () => {
    expect(
      extractFileExplorePathKey('read', JSON.stringify({ path: contentPath, offset: 0 }))
    ).toBe('files/Arena Agent Stack/ad-generator (13).html')
    expect(
      extractFileExplorePathKey(
        'read',
        JSON.stringify({
          path: 'files/Arena Agent Stack/ad-generator (13).html/content',
          offset: 200,
        })
      )
    ).toBe('files/Arena Agent Stack/ad-generator (13).html')
  })

  it('hard-stops after enough reads of the same path with different offsets', () => {
    const tracker = createFileExploreTracker()
    let hit = null
    for (let i = 0; i < MAX_FILE_EXPLORE_WITHOUT_MUTATION - 1; i += 1) {
      hit = tracker.record(
        'read',
        JSON.stringify({ path: contentPath, offset: i * 100, limit: 120 }),
        true
      )
      expect(hit).toBeNull()
    }
    hit = tracker.record(
      'read',
      JSON.stringify({ path: contentPath, offset: 900, limit: 120 }),
      true
    )
    expect(hit?.reason).toBe('path')
    expect(hit?.count).toBe(MAX_FILE_EXPLORE_WITHOUT_MUTATION)
    expect(hit?.message).toMatch(/left unchanged/i)
  })

  it('resets the path bucket after a successful file mutation', () => {
    const tracker = createFileExploreTracker()
    for (let i = 0; i < MAX_FILE_EXPLORE_WITHOUT_MUTATION - 1; i += 1) {
      expect(
        tracker.record('read', JSON.stringify({ path: contentPath, offset: i }), true)
      ).toBeNull()
    }
    expect(
      tracker.record(
        'workspace_file',
        JSON.stringify({ operation: 'patch', target: { path: contentPath } }),
        true
      )
    ).toBeNull()
    expect(
      tracker.record('read', JSON.stringify({ path: contentPath, offset: 0 }), true)
    ).toBeNull()
  })

  it('hard-stops on turn-total inspections across mixed tools', () => {
    const tracker = createFileExploreTracker()
    let hit = null
    for (let i = 0; i < MAX_FILE_EXPLORE_TOTAL_WITHOUT_MUTATION - 1; i += 1) {
      const toolName = i % 2 === 0 ? 'read' : 'load_copilot_artifact'
      const args =
        toolName === 'read'
          ? JSON.stringify({ path: `files/other-${i}.html/content`, offset: 0 })
          : JSON.stringify({ artifactId: `art-${i}` })
      hit = tracker.record(toolName, args, true)
      expect(hit).toBeNull()
    }
    hit = tracker.record(
      'grep',
      JSON.stringify({ path: 'files/final.html/content', pattern: 'x' }),
      true
    )
    expect(hit?.reason).toBe('total')
    expect(hit?.totalInspections).toBe(MAX_FILE_EXPLORE_TOTAL_WITHOUT_MUTATION)
  })

  it('ignores failed inspections', () => {
    const tracker = createFileExploreTracker(2, 100)
    expect(tracker.record('read', JSON.stringify({ path: contentPath }), false)).toBeNull()
    expect(tracker.record('read', JSON.stringify({ path: contentPath }), false)).toBeNull()
    expect(tracker.record('read', JSON.stringify({ path: contentPath }), true)).toBeNull()
  })
})
