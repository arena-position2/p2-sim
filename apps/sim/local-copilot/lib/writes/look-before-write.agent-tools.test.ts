/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_TOOLS_NOT_CANVAS_ADD_ERROR,
  assertAgentToolsNotAddedAsCanvasBlocks,
  assertEditWorkflowLookBeforeWrite,
  clearLivePatchExcerptTokens,
  rejectPatchSearchIgnoringLiveExcerpt,
  rejectRepeatedPatchSearch,
  rememberFailedPatchSearch,
  rememberLivePatchExcerptTokens,
} from '@/local-copilot/lib/writes/look-before-write'

describe('assertAgentToolsNotAddedAsCanvasBlocks', () => {
  it('rejects canvas add for image_generator_v2 / chart_generator / exa', () => {
    const result = assertAgentToolsNotAddedAsCanvasBlocks({
      operations: [
        {
          operation_type: 'add',
          block_id: 'img-1',
          params: { type: 'image_generator_v2', name: 'Image Generator' },
        },
        {
          operation_type: 'add',
          block_id: 'chart-1',
          params: { type: 'chart_generator', name: 'Chart Generator' },
        },
        {
          operation_type: 'add',
          block_id: 'exa-1',
          params: { type: 'exa', name: 'Exa' },
        },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(AGENT_TOOLS_NOT_CANVAS_ADD_ERROR.slice(0, 40))
      expect(result.error).toMatch(/image_generator_v2/)
      expect(result.error).toMatch(/chart_generator/)
      expect(result.error).toMatch(/exa/)
      expect(result.error).toMatch(/params\.inputs\.tools/)
    }
  })

  it('allows Function / Agent canvas adds (legitimate blocks)', () => {
    expect(
      assertAgentToolsNotAddedAsCanvasBlocks({
        operations: [
          {
            operation_type: 'add',
            block_id: 'fn-1',
            params: { type: 'function', name: 'Process Output' },
          },
          {
            operation_type: 'add',
            block_id: 'agent-1',
            params: { type: 'agent', name: 'Responder' },
          },
        ],
      }).ok
    ).toBe(true)
  })

  it('allows editing an Agent tools array (operation_type edit)', () => {
    expect(
      assertAgentToolsNotAddedAsCanvasBlocks({
        operations: [
          {
            operation_type: 'edit',
            block_id: 'agent-1',
            params: {
              inputs: {
                tools: [
                  {
                    type: 'image_generator_v2',
                    usageControl: 'auto',
                  },
                  {
                    type: 'chart_generator',
                    operation: 'generate',
                    usageControl: 'auto',
                  },
                  {
                    type: 'exa',
                    operation: 'exa_search',
                    usageControl: 'auto',
                  },
                ],
              },
            },
          },
        ],
      }).ok
    ).toBe(true)
  })
})

describe('assertEditWorkflowLookBeforeWrite agent-tools gate', () => {
  it('fails closed before metadata check when canvas-adding agent tools', () => {
    const result = assertEditWorkflowLookBeforeWrite({
      operations: [
        {
          operation_type: 'add',
          block_id: 'img-1',
          params: { type: 'image_generator_v2', name: 'Image' },
        },
      ],
      blocksMetadataByType: new Map([['image_generator_v2', {}]]),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Do not add image_generator_v2/)
    }
  })
})

describe('repeated patch searches', () => {
  const args = {
    operation: 'patch',
    target: { path: 'files/ad-generator (10).html' },
    edit: {
      strategy: 'search_replace' as const,
      search: '<div class=\\"drop\\">\n  <h4>Brand Logo</h4>',
    },
  }

  it('rejects the same normalized search and allows a different one', () => {
    const failed = new Map<string, Set<string>>()
    rememberFailedPatchSearch(failed, args, {
      errorType: 'search_not_found',
      data: { vfsPath: 'files/ad-generator (10).html' },
    })

    const repeated = rejectRepeatedPatchSearch({
      args: {
        ...args,
        edit: {
          strategy: 'search_replace',
          search: '<div class="drop"> <h4>Brand Logo</h4>',
        },
      },
      failedPatchSearches: failed,
    })
    expect(repeated?.result.errorType).toBe('search_repeated')

    const next = rejectRepeatedPatchSearch({
      args: {
        ...args,
        edit: { strategy: 'search_replace', search: 'id="generateBtn"' },
      },
      failedPatchSearches: failed,
    })
    expect(next).toBeNull()
  })

  it('records search_too_long misses so the same needle is rejected next', () => {
    const failed = new Map<string, Set<string>>()
    const longSearch = `<button id="generateBtn">${'x'.repeat(700)}</button>`
    rememberFailedPatchSearch(
      failed,
      {
        ...args,
        edit: { strategy: 'search_replace', search: longSearch },
      },
      {
        errorType: 'search_too_long',
        data: { vfsPath: 'files/ad-generator (10).html' },
      }
    )

    const repeated = rejectRepeatedPatchSearch({
      args: {
        ...args,
        edit: { strategy: 'search_replace', search: longSearch },
      },
      failedPatchSearches: failed,
    })
    expect(repeated?.result.errorType).toBe('search_repeated')
  })
})

describe('live excerpt token gate after patch miss', () => {
  const args = {
    operation: 'patch',
    target: { path: 'files/ad-generator (10).html' },
    edit: {
      strategy: 'search_replace' as const,
      search: '<div class="invented">Nope</div>',
    },
  }

  it('rejects a next search that ignores live excerpt tokens', () => {
    const live = new Map<string, Set<string>>()
    rememberLivePatchExcerptTokens(live, args, {
      errorType: 'search_not_found',
      data: {
        vfsPath: 'files/ad-generator (10).html',
        excerpt:
          'Live lines containing generateBtn, Generate:\n1: <button id="generateBtn">Generate</button>',
      },
    })

    const ignored = rejectPatchSearchIgnoringLiveExcerpt({
      args,
      livePatchExcerptTokens: live,
    })
    expect(ignored?.result.errorType).toBe('search_ignores_live_excerpt')

    const ok = rejectPatchSearchIgnoringLiveExcerpt({
      args: {
        ...args,
        edit: { strategy: 'search_replace', search: 'id="generateBtn"' },
      },
      livePatchExcerptTokens: live,
    })
    expect(ok).toBeNull()
  })

  it('clears live tokens after a successful patch prepare', () => {
    const live = new Map<string, Set<string>>()
    rememberLivePatchExcerptTokens(live, args, {
      errorType: 'search_not_found',
      data: {
        vfsPath: 'files/ad-generator (10).html',
        excerpt: 'Live lines containing generateBtn:\n1: id="generateBtn"',
      },
    })
    expect(live.size).toBe(1)
    clearLivePatchExcerptTokens(live, args)
    expect(live.size).toBe(0)
  })
})
