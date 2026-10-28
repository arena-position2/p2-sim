import { describe, expect, it } from 'vitest'
import type { StoredTool } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/tool-input/types'
import {
  buildInitialAgentToolParams,
  isAgentToolBlock,
  isAgentToolPickerBlock,
  isCustomToolAlreadySelected,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/tool-input/utils'
import { AgentBlock } from '@/blocks/blocks/agent'
import { ImageFusionBlock } from '@/blocks/blocks/image_fusion'
import { ImageGeneratorV2Block } from '@/blocks/blocks/image_generator'
import { START_FILES_REF } from '@/executor/constants'

describe('isAgentToolPickerBlock', () => {
  it('includes image_generator_v2 even though it is a blocks-category block', () => {
    expect(isAgentToolPickerBlock(ImageGeneratorV2Block)).toBe(true)
  })

  it('excludes the agent block itself', () => {
    expect(isAgentToolPickerBlock(AgentBlock)).toBe(false)
  })

  it('maps image_generator_v2 to image_generate tool access', () => {
    expect(ImageGeneratorV2Block.tools?.access).toEqual(['image_generate'])
  })
})

describe('buildInitialAgentToolParams', () => {
  it('does not seed user-or-llm defaults for image_generator_v2', () => {
    const params = buildInitialAgentToolParams('image_generator_v2', [
      {
        id: 'provider',
        type: 'string',
        required: false,
        visibility: 'user-or-llm',
        uiComponent: { type: 'combobox', value: () => 'gemini' },
      },
      {
        id: 'model',
        type: 'string',
        required: false,
        visibility: 'user-or-llm',
        uiComponent: { type: 'combobox', value: () => 'gemini-3.1-flash-image-preview' },
      },
    ])

    expect(params).toEqual({ inputImage: START_FILES_REF })
  })

  it('seeds start.files as the image generator reference default', () => {
    const params = buildInitialAgentToolParams('image_generator_v2', [])

    expect(params).toEqual({ inputImage: START_FILES_REF })
  })

  it('still seeds user-only defaults for other agent tools', () => {
    const params = buildInitialAgentToolParams('api', [
      {
        id: 'method',
        type: 'string',
        required: true,
        visibility: 'user-or-llm',
        uiComponent: { type: 'dropdown', value: () => 'GET' },
      },
    ])

    expect(params).toEqual({ method: 'GET' })
  })
})

describe('isAgentToolBlock', () => {
  it('includes image_generator_v2 even though it is a blocks-category block', () => {
    expect(isAgentToolBlock(ImageGeneratorV2Block)).toBe(true)
  })

  it('includes image_fusion as a tools-category block', () => {
    expect(isAgentToolBlock(ImageFusionBlock)).toBe(true)
  })

  it('includes the current File block', () => {
    expect(isAgentToolBlock({ type: 'file_v5', category: 'blocks', hideFromToolbar: false })).toBe(
      true
    )
  })

  it('excludes hidden blocks such as the legacy File block', () => {
    expect(isAgentToolBlock({ type: 'file', category: 'blocks', hideFromToolbar: true })).toBe(
      false
    )
  })

  it('does not admit a versioned block whose base type is unlisted', () => {
    expect(
      isAgentToolBlock({ type: 'memory_v2', category: 'blocks', hideFromToolbar: false })
    ).toBe(false)
  })
})

describe('already-selected checks', () => {
  const selectedTools: StoredTool[] = [
    { type: 'mcp', toolId: 'shared-id', title: 'MCP Tool' },
    { type: 'custom-tool', customToolId: 'custom-1' },
    {
      type: 'custom-tool',
      title: 'Legacy Tool',
      toolId: 'custom-myFunction',
      schema: { function: { name: 'myFunction' } },
      code: 'return true',
    },
    { type: 'http_request', toolId: 'mcp-only-id' },
    { type: 'workflow_input', toolId: 'workflow_executor', params: { workflowId: 'workflow-a' } },
    { type: 'workflow_input', toolId: 'workflow_executor' },
  ]

  it('matches a custom tool only by customToolId, never an MCP id or a legacy inline tool', () => {
    expect(isCustomToolAlreadySelected(selectedTools, 'custom-1')).toBe(true)
    expect(isCustomToolAlreadySelected(selectedTools, 'shared-id')).toBe(false)
    expect(isCustomToolAlreadySelected(selectedTools, 'custom-myFunction')).toBe(false)
    expect(
      isCustomToolAlreadySelected(
        [{ type: 'mcp', toolId: 'mcp-id', customToolId: 'custom-2' } as StoredTool],
        'custom-2'
      )
    ).toBe(false)
  })
})
