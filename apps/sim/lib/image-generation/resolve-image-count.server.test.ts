/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetRotatingApiKey } = vi.hoisted(() => ({
  mockGetRotatingApiKey: vi.fn(),
}))

vi.mock('@/lib/core/config/api-keys', () => ({
  getRotatingApiKey: mockGetRotatingApiKey,
}))

import { resolveImageGenerationCount } from '@/lib/image-generation/resolve-image-count.server'

function mockSlmImageCount(imageCount: number) {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  imageCount,
                  imageUrl: null,
                }),
              },
            ],
          },
        },
      ],
    }),
  })
  global.fetch = mockFetch as unknown as typeof fetch
  return mockFetch
}

describe('resolveImageGenerationCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetRotatingApiKey.mockReturnValue('test-google-key')
  })

  it('uses the explicit requested variation count even when Gemini returns a lower count', async () => {
    const originalPrompt =
      'Give 4 different variations with different jerseys, teams and fans wearing different players tshirts.'
    mockSlmImageCount(3)

    const result = await resolveImageGenerationCount({
      prompt: originalPrompt,
    })

    expect(result.imageCount).toBe(4)
    expect(result.slmSuggested).toBe(4)
    expect(result.singleImagePrompt).toBe(originalPrompt)
    expect(result.singleImagePrompts).toHaveLength(4)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips the SLM for ordinary single-image prompts', async () => {
    const originalPrompt = 'A red sports car on a mountain road at sunset.'
    mockSlmImageCount(1)

    const result = await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(result.imageCount).toBe(1)
    expect(result.slmSuggested).toBe(1)
    expect(result.singleImagePrompts).toEqual([originalPrompt])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('still calls the SLM when the prompt asks for variations without an explicit count', async () => {
    const originalPrompt = 'Give me some variations of this logo concept'
    mockSlmImageCount(3)

    await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('counts distinct variations as separate images', async () => {
    const originalPrompt = 'Create 3 distinct variations of this street market scene'
    mockSlmImageCount(1)

    const result = await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(result.imageCount).toBe(3)
    expect(result.singleImagePrompts).toHaveLength(3)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('counts separate variations even when the SLM would return 1', async () => {
    const originalPrompt = 'Give me three separate variations of this logo'
    mockSlmImageCount(1)

    const result = await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(result.imageCount).toBe(3)
    expect(result.singleImagePrompts).toHaveLength(3)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('does not treat a reference single image as a combined-output request', async () => {
    const originalPrompt = 'Give me 3 variations of a single image'
    mockSlmImageCount(1)

    const result = await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(result.imageCount).toBe(3)
    expect(result.singleImagePrompts).toHaveLength(3)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('extracts variation count when the reference image is mentioned earlier in the prompt', async () => {
    const originalPrompt = 'Edit this single image and give me 4 variations with new backgrounds'
    mockSlmImageCount(1)

    const result = await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(result.imageCount).toBe(4)
    expect(result.singleImagePrompts).toHaveLength(4)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns one image for side-by-side composition requests without calling the SLM', async () => {
    const originalPrompt = 'Give me three variations side by side in a single image'
    mockSlmImageCount(3)

    const result = await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(result.imageCount).toBe(1)
    expect(result.singleImagePrompts).toEqual([originalPrompt])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('honors repeat multipliers for combined side-by-side compositions', async () => {
    const originalPrompt = 'Give me three variations side by side in a single image three times'
    mockSlmImageCount(1)

    const result = await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(result.imageCount).toBe(3)
    expect(result.singleImagePrompts).toHaveLength(3)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('preserves the original prompt when the SLM returns rewritten prompt fields in legacy payloads', async () => {
    const originalPrompt = 'A red sports car on a mountain road at sunset.'
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    imageCount: 1,
                    imageUrl: null,
                    singleImagePrompt: 'Completely rewritten prompt from SLM',
                    singleImagePrompts: ['Rewritten variation 1'],
                  }),
                },
              ],
            },
          },
        ],
      }),
    })
    global.fetch = mockFetch as unknown as typeof fetch

    const result = await resolveImageGenerationCount({ prompt: originalPrompt })

    expect(result.imageCount).toBe(1)
    expect(result.singleImagePrompt).toBe(originalPrompt)
    expect(result.singleImagePrompts).toEqual([originalPrompt])
  })
})
