/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockResolveProviderInlineImageData } = vi.hoisted(() => ({
  mockResolveProviderInlineImageData: vi.fn(),
}))

vi.mock('@/app/api/google/api-service', () => ({
  resolveProviderInlineImageData: mockResolveProviderInlineImageData,
}))

import { generateOpenAIImageEdit } from '@/lib/image-generation/openai-reference.server'

describe('generateOpenAIImageEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves internal reference URLs via temporary provider URL before calling OpenAI', async () => {
    const referenceImage = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ])
    const generatedImage = Buffer.from('generated-image').toString('base64')
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: generatedImage }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    mockResolveProviderInlineImageData.mockResolvedValue({
      mimeType: 'image/png',
      data: referenceImage.toString('base64'),
    })
    global.fetch = mockFetch as unknown as typeof fetch

    const internalReferenceUrl =
      'https://dev-agent.thearena.ai/api/files/serve/execution/ws/wf/ex/source.png'

    const result = await generateOpenAIImageEdit(
      'openai-key',
      {
        model: 'gpt-image-2',
        prompt: 'Use this as a reference',
        size: '1024x1024',
        quality: 'low',
        background: 'opaque',
        outputFormat: 'png',
        inputImage: internalReferenceUrl,
      },
      { userId: 'user-1', requestId: 'req-1' }
    )

    expect(result.buffer.toString()).toBe('generated-image')
    expect(mockResolveProviderInlineImageData).toHaveBeenCalledWith(
      internalReferenceUrl,
      undefined,
      'user-1',
      'req-1-0'
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/images/edits')
  })

  it('resolves each file when the selected image arrives as an inputImage array', async () => {
    const referenceImage = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ])
    const generatedImage = Buffer.from('generated-image').toString('base64')
    const selectedImage = {
      key: 'execution/ws/wf/ex/selected.png',
      url: 'https://dev-agent.thearena.ai/api/files/serve/execution/ws/wf/ex/selected.png',
      type: 'image/png',
    }
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: generatedImage }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    mockResolveProviderInlineImageData.mockResolvedValue({
      mimeType: 'image/png',
      data: referenceImage.toString('base64'),
    })
    global.fetch = mockFetch as unknown as typeof fetch

    await generateOpenAIImageEdit(
      'openai-key',
      {
        model: 'gpt-image-1.5',
        prompt: 'Add a car to this image',
        inputImage: [selectedImage],
      },
      { userId: 'user-1', requestId: 'req-array' }
    )

    expect(mockResolveProviderInlineImageData).toHaveBeenCalledWith(
      selectedImage,
      undefined,
      'user-1',
      'req-array-0'
    )
  })

  it('appends multiple reference images for gpt-image-2 edits', async () => {
    const referenceImage = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ])
    const generatedImage = Buffer.from('generated-image').toString('base64')
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: generatedImage }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )

    mockResolveProviderInlineImageData.mockResolvedValue({
      mimeType: 'image/png',
      data: referenceImage.toString('base64'),
    })
    global.fetch = mockFetch as unknown as typeof fetch

    await generateOpenAIImageEdit(
      'openai-key',
      {
        model: 'gpt-image-2',
        prompt: 'Composite image 1 and image 2',
        inputImages: ['https://example.com/a.png', 'https://example.com/b.png'],
      },
      { userId: 'user-1', requestId: 'req-2' }
    )

    expect(mockResolveProviderInlineImageData).toHaveBeenCalledTimes(2)
    const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit
    const formData = requestInit.body as FormData
    expect(Array.from(formData.keys()).filter((key) => key === 'image')).toHaveLength(2)
  })
})
