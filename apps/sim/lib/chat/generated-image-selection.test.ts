/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn(() =>
  Promise.reject(new Error('fetch should not be called for internal serve URLs'))
)

vi.stubGlobal('fetch', fetchMock)

import { materializeSelectedGeneratedImage } from '@/lib/chat/generated-image-selection'
import { validateAttachmentFileType } from '@/lib/uploads/utils/validation'

describe('materializeSelectedGeneratedImage', () => {
  it('uses a positive file size for internal serve URLs without downloading the image', async () => {
    const result = await materializeSelectedGeneratedImage({
      id: 'img-1',
      messageId: 'msg-1',
      name: 'generated.png',
      url: 'http://localhost:3000/api/files/serve/agent-generated-images/wf/user/image.png',
      type: 'image/png',
    })

    expect(result.size).toBeGreaterThan(0)
    expect(result.file.size).toBe(0)
    expect(result.url).toContain('/api/files/serve/')
    expect(result.dataUrl).toContain('/api/files/serve/')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves known byte size from generated image metadata', async () => {
    const result = await materializeSelectedGeneratedImage({
      id: 'img-2',
      messageId: 'msg-2',
      name: 'generated.png',
      url: '/api/files/serve/agent-generated-images/wf/user/image.png',
      type: 'image/png',
      size: 872_519,
    })

    expect(result.size).toBe(872_519)
  })

  it('infers concrete mime type for internal serve URLs with wildcard metadata', async () => {
    const result = await materializeSelectedGeneratedImage({
      id: 'img-3',
      messageId: 'msg-3',
      name: 'Generated image',
      url: '/api/files/serve/agent-generated-images%2Fwf%2Fuser%2Fimage.jpeg',
      type: 'image/*',
    })

    expect(result.type).toBe('image/jpeg')
    expect(result.name).toBe('Generated image.jpg')
    expect(result.file.name).toBe('Generated image.jpg')
    expect(validateAttachmentFileType(result.file.name)).toBeNull()
  })

  it('materializes stored images from storage keys without downloading bytes', async () => {
    const result = await materializeSelectedGeneratedImage({
      id: 'img-4',
      messageId: 'msg-4',
      name: 'Generated image',
      url: 'https://bucket.s3.amazonaws.com/tmp/presigned?expires=1',
      key: 'agent-generated-images/workflow/user/image.png',
      type: 'image/png',
      size: 8_725_519,
    })

    expect(result.size).toBe(8_725_519)
    expect(result.name).toBe('Generated image.png')
    expect(result.file.name).toBe('Generated image.png')
    expect(validateAttachmentFileType(result.file.name)).toBeNull()
    expect(result.url).toContain('/api/files/serve/')
    expect(result.dataUrl).toContain('/api/files/serve/')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
