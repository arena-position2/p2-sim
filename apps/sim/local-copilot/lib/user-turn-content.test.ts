/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockReadChatUpload } = vi.hoisted(() => ({
  mockReadChatUpload: vi.fn(),
}))

vi.mock('@/lib/mothership/tools/handlers/upload-file-reader', () => ({
  readChatUpload: mockReadChatUpload,
}))

import { LOCAL_COPILOT_AUTO_INLINE_TEXT_MAX_BYTES } from '@/local-copilot/lib/context/chat-uploads'
import { getMessageContentText } from '@/local-copilot/lib/providers/message-content'
import {
  buildLocalCopilotUserTurn,
  parseUploadedFileContext,
} from '@/local-copilot/lib/user-turn-content'

describe('parseUploadedFileContext', () => {
  it('parses name, media type, and byte size', () => {
    expect(
      parseUploadedFileContext('File "dashboard.html" (text/html, 63000 bytes) uploaded.')
    ).toEqual({
      displayName: 'dashboard.html',
      mediaType: 'text/html',
      size: 63_000,
    })
  })
})

describe('buildLocalCopilotUserTurn large-file policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('inlines small text uploads', async () => {
    mockReadChatUpload.mockResolvedValue({
      content: '<html><title>Small</title></html>',
      totalLines: 1,
    })

    const turn = await buildLocalCopilotUserTurn({
      message: 'Update the title',
      chatId: 'chat-1',
      fileAttachments: [
        {
          key: 'k1',
          filename: 'page.html',
          media_type: 'text/html',
          size: 32,
        },
      ],
    })

    const text = getMessageContentText(turn.content)
    expect(text).toContain('Contents of "page.html"')
    expect(text).toContain('<title>Small</title>')
    expect(mockReadChatUpload).toHaveBeenCalledWith('page.html', 'chat-1')
  })

  it('skips reading oversized text uploads when size is known', async () => {
    const turn = await buildLocalCopilotUserTurn({
      message: 'Fix the nav',
      chatId: 'chat-1',
      fileAttachments: [
        {
          key: 'k1',
          filename: 'dashboard.html',
          media_type: 'text/html',
          size: LOCAL_COPILOT_AUTO_INLINE_TEXT_MAX_BYTES + 1,
        },
      ],
    })

    const text = getMessageContentText(turn.content)
    expect(text).toMatch(/too large to inline/i)
    expect(text).toContain('uploads/dashboard.html')
    expect(text).not.toContain('Contents of "dashboard.html"')
    expect(mockReadChatUpload).not.toHaveBeenCalled()
  })

  it('replaces oversized bodies after read when size was unknown', async () => {
    const huge = 'x'.repeat(LOCAL_COPILOT_AUTO_INLINE_TEXT_MAX_BYTES + 50)
    mockReadChatUpload.mockResolvedValue({ content: huge, totalLines: 1 })

    const turn = await buildLocalCopilotUserTurn({
      message: 'Edit this',
      chatId: 'chat-1',
      contexts: [
        {
          type: 'uploaded_file',
          content: 'File "notes.txt" (text/plain) uploaded.\nRead with: read("uploads/notes.txt")',
        },
      ],
    })

    const text = getMessageContentText(turn.content)
    expect(text).toMatch(/too large to inline/i)
    expect(text).not.toContain(huge.slice(0, 80))
    expect(mockReadChatUpload).toHaveBeenCalledWith('notes.txt', 'chat-1')
  })

  it('still inlines images', async () => {
    mockReadChatUpload.mockResolvedValue({
      content: '',
      totalLines: 0,
      attachment: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'abc',
        },
      },
    })

    const turn = await buildLocalCopilotUserTurn({
      message: 'Build from this screenshot',
      chatId: 'chat-1',
      fileAttachments: [
        {
          key: 'k1',
          filename: 'screen.png',
          media_type: 'image/png',
          size: 500_000,
        },
      ],
    })

    expect(Array.isArray(turn.content)).toBe(true)
    if (!Array.isArray(turn.content)) return
    expect(turn.content.some((part) => part.type === 'image')).toBe(true)
    expect(mockReadChatUpload).toHaveBeenCalled()
  })
})
