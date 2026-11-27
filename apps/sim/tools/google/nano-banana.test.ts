/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSaveGeneratedImage } = vi.hoisted(() => ({
  mockSaveGeneratedImage: vi.fn(),
}))

vi.mock('@/lib/uploads/utils/image-storage.server', () => ({
  saveGeneratedImage: mockSaveGeneratedImage,
}))

import {
  buildNanoBananaRequestBody,
  buildNanoBananaToolResponse,
  resolveInlineImageData,
} from '@/app/api/google/api-service'
import { nanoBananaTool } from '@/tools/google/nano-banana'

describe('Nano Banana tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSaveGeneratedImage.mockResolvedValue({
      url: 'https://storage.example.com/nano-banana-4k.png',
      s3UploadFailed: false,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('saves generated image data before returning output', async () => {
    const result = await buildNanoBananaToolResponse(
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'large-4k-base64-image',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'gemini-3-pro-image-preview',
        imageSize: '4K',
        aspectRatio: '1:1',
        _context: {
          workflowId: 'workflow-1',
          sessionUserId: 'user-1',
        },
      }
    )
    expect(mockSaveGeneratedImage).toHaveBeenCalledWith(
      'large-4k-base64-image',
      'workflow-1',
      'user-1',
      'image/png'
    )
    expect(result).toMatchObject({
      success: true,
      output: {
        image: 'https://storage.example.com/nano-banana-4k.png',
        images: ['https://storage.example.com/nano-banana-4k.png'],
        metadata: {
          model: 'gemini-3-pro-image-preview',
          imageSize: '4K',
          stored: true,
        },
      },
    })
  })

  it('strips inline payload fields from request body file references', () => {
    const body = nanoBananaTool.request.body?.({
      model: 'gemini-3-pro-image-preview',
      prompt: 'Fuse images',
      inputImages: [
        {
          id: 'file-1',
          name: 'source.png',
          url: 'https://files.example.com/source.png',
          key: 'execution/workflow/execution/source.png',
          type: 'image/png',
          size: 10_000_000,
          base64: 'large-base64-payload',
          data: 'large-data-payload',
          dataUrl: 'data:image/png;base64,large-data-url-payload',
          bytes: 'large-bytes-payload',
        },
      ],
    })

    expect(body).toMatchObject({
      inputImages: [
        {
          id: 'file-1',
          name: 'source.png',
          url: 'https://files.example.com/source.png',
          key: 'execution/workflow/execution/source.png',
          type: 'image/png',
          size: 10_000_000,
        },
      ],
    })
    expect(JSON.stringify(body)).not.toContain('large-base64-payload')
  })

  it('keeps server-only direct execution out of the client-bundled tool config', () => {
    expect(nanoBananaTool.directExecution).toBeUndefined()
  })

  it('resolves external object URL references into inline image data', async () => {
    const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00])
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(jpegBytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveInlineImageData({
      url: 'https://files.example.com/generated-image',
      type: 'image/jpeg',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://files.example.com/generated-image',
      expect.objectContaining({
        headers: { 'User-Agent': 'Sim-Workflow/1.0' },
      })
    )
    expect(result).toEqual({
      mimeType: 'image/jpeg',
      data: Buffer.from(jpegBytes).toString('base64'),
    })
  })

  it('inlines a selected-image array passed as inputImage', async () => {
    const jpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(jpegBytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      )
    )

    const body = await buildNanoBananaRequestBody({
      prompt: 'Add a car to this image',
      inputImage: [
        {
          url: 'https://files.example.com/selected.jpg',
          type: 'image/jpeg',
        },
      ],
    })

    expect(body.contents[0]?.parts.some((part) => part.inlineData?.mimeType === 'image/jpeg')).toBe(
      true
    )
  })

  it('rejects empty external object URL references before Gemini', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      )
    )

    await expect(
      resolveInlineImageData({
        url: 'https://files.example.com/empty-image',
        type: 'image/png',
      })
    ).rejects.toThrow('Failed to fetch image from URL: Image from URL is empty')
  })

  it('surfaces finishMessage when Gemini returns empty content without image parts', async () => {
    await expect(
      buildNanoBananaToolResponse(
        {
          candidates: [
            {
              content: {},
              finishReason: 'IMAGE_OTHER',
              finishMessage:
                'Unable to show the generated image. The model could not generate the image based on the prompt provided.',
              index: 0,
            },
          ],
        },
        {
          model: 'gemini-3-pro-image-preview',
          imageSize: '4K',
        }
      )
    ).rejects.toThrow(
      'Google Nano Banana could not generate an image (IMAGE_OTHER): Unable to show the generated image. The model could not generate the image based on the prompt provided. Try Resolution 2K or 1K, fewer reference images, or smaller reference images.'
    )
  })
})
