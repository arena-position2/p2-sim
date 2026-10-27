/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecuteTool } = vi.hoisted(() => ({
  mockExecuteTool: vi.fn(),
}))

vi.mock('@/tools', () => ({
  executeTool: mockExecuteTool,
}))

import { runImageGenerationWrapper } from '@/lib/image-generation/run-wrapper.server'

const BASE_TOOLS = [
  ['openai_image', { model: 'gpt-image-1', prompt: 'a cat' }],
  ['google_imagen', { model: 'imagen-4.0-generate-001', prompt: 'a cat' }],
  ['google_nano_banana', { model: 'gemini-2.5-flash-image', prompt: 'a cat' }],
] as const

describe('runImageGenerationWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecuteTool.mockResolvedValue({
      success: true,
      output: { image: 'https://example.com/image.png' },
    })
  })

  it.each(BASE_TOOLS)(
    'executes %s even when no trusted context is supplied',
    async (baseToolId, params) => {
      const result = await runImageGenerationWrapper({
        baseToolId,
        params,
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.output.image).toBe('https://example.com/image.png')
      }
      expect(mockExecuteTool).toHaveBeenCalledWith(baseToolId, expect.any(Object))
    }
  )

  it('runs one generation per requested variation', async () => {
    mockExecuteTool.mockImplementation(async (_toolId: string, params: { prompt?: string }) => ({
      success: true,
      output: { image: `https://example.com/${params.prompt?.length ?? 0}.png` },
    }))

    const result = await runImageGenerationWrapper({
      baseToolId: 'image_generate',
      params: {
        provider: 'gemini',
        model: 'gemini-3.1-flash-image-preview',
        prompt: 'Create 3 distinct variations of this street market scene',
      },
    })

    expect(result.success).toBe(true)
    expect(mockExecuteTool).toHaveBeenCalledTimes(3)
    const prompts = mockExecuteTool.mock.calls.map((call) => call[1]?.prompt as string)
    expect(prompts[0]).toContain('variation 1 of 3')
    expect(prompts[1]).toContain('variation 2 of 3')
    expect(prompts[2]).toContain('variation 3 of 3')
    expect(prompts.every((prompt) => prompt.includes('Do not combine multiple variations'))).toBe(
      true
    )
    if (result.success) {
      expect(result.output.images).toHaveLength(3)
    }
  })

  it.each(BASE_TOOLS)('forwards trusted executeTool options to %s', async (baseToolId, params) => {
    const executionContext = {
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      executionId: 'ex-1',
      userId: 'user-1',
      metadata: {},
    }

    const result = await runImageGenerationWrapper(
      { baseToolId, params },
      { executionContext: executionContext as never }
    )

    expect(result.success).toBe(true)
    expect(mockExecuteTool).toHaveBeenCalledWith(
      baseToolId,
      expect.objectContaining({ prompt: 'a cat' }),
      { executionContext }
    )
  })
})
