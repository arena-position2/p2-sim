/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_TOOLS_NOT_CANVAS_ADD_ERROR,
  assertAgentToolsNotAddedAsCanvasBlocks,
  assertEditWorkflowLookBeforeWrite,
  rejectRepeatedPatchSearch,
  rememberFailedPatchSearch,
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
                    title: 'Image Generator',
                    toolId: 'image_generate',
                    usageControl: 'auto',
                  },
                  {
                    type: 'chart_generator',
                    title: 'Chart Generator',
                    toolId: 'chart_generate',
                    usageControl: 'auto',
                  },
                  {
                    type: 'exa',
                    title: 'Exa Search',
                    operation: 'exa_search',
                    toolId: 'exa_search',
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
})
