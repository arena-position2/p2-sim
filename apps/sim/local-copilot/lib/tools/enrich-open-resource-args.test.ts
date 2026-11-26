/**
 * @vitest-environment node
 *
 * Protects A1 open_resource failures: LLM path + missing requestMode.
 * Enrich must map file path → id and strip keys Zod rejects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const resolveWorkspaceFileReference = vi.hoisted(() => vi.fn())

vi.mock('@/lib/uploads/contexts/workspace/workspace-file-manager', () => ({
  resolveWorkspaceFileReference,
}))

import { enrichOpenResourceArgs } from '@/local-copilot/lib/tools/enrich-open-resource-args'

const ctx: ToolExecutionContext = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  chatId: 'chat-1',
  structuredContext: {},
}

describe('enrichOpenResourceArgs', () => {
  beforeEach(() => {
    resolveWorkspaceFileReference.mockReset()
  })

  it('resolves file path to id and drops path (Zod is id-only)', async () => {
    resolveWorkspaceFileReference.mockResolvedValue({ id: 'file-abc', name: 'Page.html' })
    const args: Record<string, unknown> = {
      resources: [{ type: 'file', path: 'files/Apps/Page.html', view: 'ignored-for-file' }],
    }

    const reject = await enrichOpenResourceArgs(args, ctx)
    expect(reject).toBeNull()
    expect(args.resources).toEqual([{ type: 'file', id: 'file-abc' }])
    expect(resolveWorkspaceFileReference).toHaveBeenCalledWith(
      'workspace-1',
      'files/Apps/Page.html',
      expect.objectContaining({ includeChatUploads: true, chatId: 'chat-1' })
    )
  })

  it('keeps workflow id entries and maps view → viewId', async () => {
    const args: Record<string, unknown> = {
      resources: [{ type: 'table', id: 'table-1', view: 'view-9' }],
    }
    expect(await enrichOpenResourceArgs(args, ctx)).toBeNull()
    expect(args.resources).toEqual([{ type: 'table', id: 'table-1', viewId: 'view-9' }])
    expect(resolveWorkspaceFileReference).not.toHaveBeenCalled()
  })

  it('fails clearly when a file path does not resolve', async () => {
    resolveWorkspaceFileReference.mockResolvedValue(null)
    const args: Record<string, unknown> = {
      resources: [{ type: 'file', path: 'files/Missing.html' }],
    }
    const reject = await enrichOpenResourceArgs(args, ctx)
    expect(reject?.success).toBe(false)
    expect(reject?.error).toMatch(/No workspace file found/i)
  })

  it('rejects empty resources', async () => {
    const reject = await enrichOpenResourceArgs({ resources: [] }, ctx)
    expect(reject?.success).toBe(false)
    expect(reject?.error).toMatch(/resources/i)
  })
})
