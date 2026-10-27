import {
  inputValidationMock,
  inputValidationMockFns,
} from '@sim/testing/mocks/input-validation.mock'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isInternalToolFileResult,
  type StoredToolFile,
} from '@/lib/internal/tool-operations/file-result'

const mocks = vi.hoisted(() => ({
  resolveFiles: vi.fn(),
}))

vi.mock('@/lib/internal/slack/file-input', () => ({
  forEachSlackAttachmentFile: mocks.resolveFiles,
}))

vi.mock('@/lib/core/security/input-validation.server', () => inputValidationMock)

import type { SlackOperationError } from '@/lib/internal/slack/errors'
import {
  executeSlackAddReaction,
  executeSlackDownload,
  executeSlackReadMessages,
  executeSlackSendMessage,
  executeSlackUpdateMessage,
} from '@/lib/internal/slack/operations'
import { MAX_FILE_SIZE } from '@/lib/uploads/utils/validation'

const { mockValidateUrlWithDNS, mockSecureFetchWithPinnedIP, mockSecureFetchWithValidation } =
  inputValidationMockFns

const originalFetch = global.fetch

function slackResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe('Slack operations', () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch
    mockValidateUrlWithDNS.mockResolvedValue({
      isValid: true,
      resolvedIP: '93.184.216.34',
      originalHostname: 'files.slack.com',
    })
    mockSecureFetchWithValidation.mockResolvedValue(new Response(null, { status: 200 }))
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('passes cancellation through Slack Web API calls and preserves logical-error status', async () => {
    const controller = new AbortController()
    vi.mocked(global.fetch).mockResolvedValueOnce(
      slackResponse({ ok: false, error: 'already_reacted' })
    )

    await expect(
      executeSlackAddReaction(
        { accessToken: 'token', channel: 'C1', timestamp: '1.0', name: 'eyes' },
        controller.signal
      )
    ).rejects.toMatchObject<Partial<SlackOperationError>>({
      status: 200,
      body: { success: false, error: 'already_reacted' },
    })
    expect(vi.mocked(global.fetch).mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    })
  })

  it('retains the update fallback message and exact metadata projection', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      slackResponse({ ok: true, channel: 'C1', ts: '2.0', text: 'normalized' })
    )

    const result = await executeSlackUpdateMessage({
      accessToken: 'token',
      channel: 'C1',
      timestamp: '1.0',
      text: 'updated',
    })

    expect(result).toEqual({
      success: true,
      output: {
        message: {
          type: 'message',
          ts: '2.0',
          text: 'normalized',
          channel: 'C1',
        },
        content: 'Message updated successfully',
        metadata: { channel: 'C1', timestamp: '2.0', text: 'normalized' },
      },
    })
  })

  it('opens a DM, keeps the read limit bounded by the contract, and maps legacy fields', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(slackResponse({ ok: true, channel: { id: 'D1' } }))
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          messages: [
            {
              ts: '2.0',
              text: 'hello',
              reactions: [{ name: 'eyes', count: 1 }],
              files: [{ id: 'F1', name: 'report.pdf' }],
              edited: { user: 'U2', ts: '2.1' },
            },
          ],
        })
      )
      .mockResolvedValueOnce(slackResponse({ ok: true, user: { id: 'U2', name: 'ada' } }))

    const result = await executeSlackReadMessages({
      accessToken: 'token',
      userId: 'U1',
      limit: 15,
    })

    expect(result.output.messages).toHaveLength(1)
    expect(result.output.messages[0]).toMatchObject({
      type: 'message',
      ts: '2.0',
      reactions: [{ name: 'eyes', count: 1, users: [] }],
      files: [{ id: 'F1', name: 'report.pdf' }],
      edited: { user: 'U2', user_name: 'ada', ts: '2.1' },
    })
    const historyUrl = String(vi.mocked(global.fetch).mock.calls[1]?.[0])
    expect(historyUrl).toContain('channel=D1')
    expect(historyUrl).toContain('limit=15')
  })

  it('auto-paginates history, converts fromDate, and attaches thread replies', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          has_more: true,
          response_metadata: { next_cursor: 'page-2' },
          messages: [{ ts: '3.0', text: 'first', reply_count: 1 }],
        })
      )
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          has_more: false,
          messages: [{ ts: '2.0', text: 'second' }],
        })
      )
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          messages: [
            { ts: '3.0', text: 'first' },
            { ts: '3.1', text: 'reply <@U9>' },
          ],
        })
      )
      .mockResolvedValueOnce(slackResponse({ ok: true, user: { id: 'U9', name: 'linus' } }))

    const result = await executeSlackReadMessages({
      accessToken: 'token',
      channel: 'C1',
      limit: 20,
      fromDate: '2026-01-01',
      autoPaginate: true,
      includeThreads: true,
      maxThreads: 10,
      maxRepliesPerThread: 100,
    })

    expect(result.output.messages).toHaveLength(2)
    expect(result.output.messages[0]).toMatchObject({
      ts: '3.0',
      replies: [{ ts: '3.1', text: 'reply @linus' }],
    })
    expect(result.output.paginationInfo).toMatchObject({
      autoPaginated: true,
    })
    expect(result.output.totalPages).toBe(2)
    const firstHistoryUrl = String(vi.mocked(global.fetch).mock.calls[0]?.[0])
    expect(firstHistoryUrl).toContain('oldest=1767225600')
    expect(String(vi.mocked(global.fetch).mock.calls[1]?.[0])).toContain('cursor=page-2')
  })

  it('uses the protected file resolver, validated upload URL, and completes sharing', async () => {
    const controller = new AbortController()
    mocks.resolveFiles.mockImplementation(async (_files, _context, consume) => {
      await consume({
        buffer: Buffer.from('hello'),
        contentType: 'text/plain',
        name: 'hello.txt',
        type: 'text/plain',
      })
    })
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          upload_url: 'https://files.slack.com/upload/signed',
          file_id: 'F1',
        })
      )
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          files: [{ id: 'F1', name: 'hello.txt', created: 10, mimetype: 'text/plain' }],
        })
      )

    const result = await executeSlackSendMessage(
      {
        accessToken: 'token',
        channel: 'C1',
        text: 'hello',
        files: [{ key: 'workspace/file-1', name: 'hello.txt', size: 5 }],
      },
      {
        requestId: 'request-1',
        signal: controller.signal,
        userId: 'user-1',
      }
    )

    expect(mocks.resolveFiles).toHaveBeenCalledWith(
      [{ key: 'workspace/file-1', name: 'hello.txt', size: 5 }],
      expect.objectContaining({
        requestId: 'request-1',
        signal: controller.signal,
        userId: 'user-1',
      }),
      expect.any(Function)
    )
    expect(mocks.secureFetchWithValidation).toHaveBeenCalledWith(
      'https://files.slack.com/upload/signed',
      expect.objectContaining({
        method: 'POST',
        body: Buffer.from('hello'),
        signal: controller.signal,
      }),
      'uploadUrl'
    )
    assert(isInternalToolFileResult(result))
    expect(result.files).toEqual([
      { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    ])
    const storedFile: StoredToolFile = {
      id: 'stored-file-1',
      key: 'execution/stored-file-1',
      url: '/api/files/serve/stored-file-1',
      name: 'hello.txt',
      type: 'text/plain',
      mimeType: 'text/plain',
      size: 5,
      context: 'execution',
    }
    expect(result.present([storedFile])).toMatchObject({
      success: true,
      output: { channel: 'C1', fileCount: 1, ts: '10', files: [storedFile] },
    })
  })

  it('keeps private Slack downloads DNS-pinned, bounded, and cancellable', async () => {
    const controller = new AbortController()
    vi.mocked(global.fetch).mockResolvedValueOnce(
      slackResponse({
        ok: true,
        file: {
          name: 'report.pdf',
          mimetype: 'application/pdf',
          url_private: 'https://files.slack.com/report.pdf',
        },
      })
    )
    mockSecureFetchWithPinnedIP.mockResolvedValue(new Response(Buffer.from('pdf'), { status: 200 }))

    const result = await executeSlackDownload(
      { accessToken: 'token', fileId: 'F1' },
      controller.signal
    )

    expect(mockSecureFetchWithPinnedIP).toHaveBeenCalledWith(
      'https://files.slack.com/report.pdf',
      '93.184.216.34',
      {
        headers: { Authorization: 'Bearer token' },
        profile: 'contentFetch',
        maxResponseBytes: MAX_FILE_SIZE,
        signal: controller.signal,
      }
    )
    assert(isInternalToolFileResult(result))
    expect(result.files).toEqual([
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') },
    ])
    const storedFile: StoredToolFile = {
      id: 'stored-file-1',
      key: 'execution/stored-file-1',
      url: '/api/files/serve/stored-file-1',
      name: 'report.pdf',
      type: 'application/pdf',
      mimeType: 'application/pdf',
      size: 3,
      context: 'execution',
    }
    expect(result.present([storedFile])).toEqual({ success: true, output: { file: storedFile } })
  })
})
