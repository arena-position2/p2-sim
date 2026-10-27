/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  chatUploadsToAttachmentRefs,
  formatAttachmentHistoryStub,
  formatAttachmentHistoryStubs,
  formatChatUploadsInventorySystemMessage,
  formatOversizedUploadInlineNote,
  LOCAL_COPILOT_AUTO_INLINE_TEXT_MAX_BYTES,
  mergeFileAttachmentRefs,
  shouldAutoInlinePriorChatUploads,
  shouldAutoInlineTextUploadBody,
} from '@/local-copilot/lib/context/chat-uploads'

describe('formatAttachmentHistoryStubs', () => {
  it('builds pointer-only stubs without file bytes', () => {
    const stub = formatAttachmentHistoryStub({
      filename: 'Screens.pdf',
      mediaType: 'application/pdf',
      size: 2048,
    })
    expect(stub).toContain('[Attached: Screens.pdf')
    expect(stub).toContain('uploads/Screens.pdf')
    expect(stub).toMatch(/Do not ask the user to re-upload/)
    expect(stub).not.toContain('Contents of')
  })

  it('joins multiple attachments', () => {
    const stubs = formatAttachmentHistoryStubs([
      { filename: 'a.pdf', media_type: 'application/pdf', size: 10 },
      { filename: 'b.png', media_type: 'image/png', size: 20 },
    ])
    expect(stubs).toContain('a.pdf')
    expect(stubs).toContain('b.png')
  })
})

describe('formatChatUploadsInventorySystemMessage', () => {
  it('returns null for an empty inventory', () => {
    expect(formatChatUploadsInventorySystemMessage([])).toBeNull()
  })

  it('lists uploads with read guidance', () => {
    const message = formatChatUploadsInventorySystemMessage([
      { name: 'Screens.pdf', type: 'application/pdf', size: 4096 },
    ])
    expect(message).toContain('Chat uploads already available')
    expect(message).toContain('uploads/Screens.pdf')
    expect(message).toMatch(/Never ask the user to re-upload/)
    expect(message).toMatch(/not fully inlined/i)
  })
})

describe('shouldAutoInlineTextUploadBody', () => {
  it('allows bodies at or under the soft cap', () => {
    expect(shouldAutoInlineTextUploadBody(0)).toBe(true)
    expect(shouldAutoInlineTextUploadBody(LOCAL_COPILOT_AUTO_INLINE_TEXT_MAX_BYTES)).toBe(true)
  })

  it('rejects bodies above the soft cap', () => {
    expect(shouldAutoInlineTextUploadBody(LOCAL_COPILOT_AUTO_INLINE_TEXT_MAX_BYTES + 1)).toBe(false)
  })
})

describe('formatOversizedUploadInlineNote', () => {
  it('points at uploads/ without embedding file bytes', () => {
    const note = formatOversizedUploadInlineNote({
      filename: 'dashboard.html',
      size: 63_000,
      mediaType: 'text/html',
    })
    expect(note).toContain('dashboard.html')
    expect(note).toContain('uploads/dashboard.html')
    expect(note).toMatch(/too large to inline/i)
    expect(note).not.toContain('<html')
  })
})

describe('shouldAutoInlinePriorChatUploads', () => {
  it('inlines on Yes when prior uploads exist and current has none', () => {
    expect(
      shouldAutoInlinePriorChatUploads({
        message: 'Yes',
        hasCurrentAttachments: false,
        priorUploadCount: 1,
      })
    ).toBe(true)
  })

  it('skips when the current turn already has attachments', () => {
    expect(
      shouldAutoInlinePriorChatUploads({
        message: 'Yes',
        hasCurrentAttachments: true,
        priorUploadCount: 2,
      })
    ).toBe(false)
  })

  it('skips when there are no prior uploads', () => {
    expect(
      shouldAutoInlinePriorChatUploads({
        message: 'Yes',
        hasCurrentAttachments: false,
        priorUploadCount: 0,
      })
    ).toBe(false)
  })

  it('skips long unrelated prompts', () => {
    expect(
      shouldAutoInlinePriorChatUploads({
        message: 'Can you also rename the workflow to Slot checker v2 and add logging?',
        hasCurrentAttachments: false,
        priorUploadCount: 3,
      })
    ).toBe(false)
  })

  it('allows short proceed prefixes', () => {
    expect(
      shouldAutoInlinePriorChatUploads({
        message: 'Yes, please proceed with the metrics.',
        hasCurrentAttachments: false,
        priorUploadCount: 1,
      })
    ).toBe(true)
  })
})

describe('mergeFileAttachmentRefs', () => {
  it('lets current-request attachments win on filename collisions', () => {
    const merged = mergeFileAttachmentRefs(
      [{ key: 'new', filename: 'Screens.pdf', media_type: 'application/pdf', size: 2 }],
      [
        { key: 'old', filename: 'Screens.pdf', media_type: 'application/pdf', size: 1 },
        { key: 'other', filename: 'Notes.txt', media_type: 'text/plain', size: 3 },
      ]
    )
    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: 'Screens.pdf', key: 'new' }),
        expect.objectContaining({ filename: 'Notes.txt', key: 'other' }),
      ])
    )
  })
})

describe('chatUploadsToAttachmentRefs', () => {
  it('maps upload records into attachment refs', () => {
    expect(
      chatUploadsToAttachmentRefs([
        { name: 'Screens.pdf', type: 'application/pdf', size: 10, key: 'k1' },
      ])
    ).toEqual([
      {
        key: 'k1',
        filename: 'Screens.pdf',
        media_type: 'application/pdf',
        size: 10,
      },
    ])
  })
})
