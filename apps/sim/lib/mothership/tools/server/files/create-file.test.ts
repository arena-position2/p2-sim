/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecuteCopilotFileUseCase } = vi.hoisted(() => ({
  mockExecuteCopilotFileUseCase: vi.fn(),
}))

vi.mock('@/lib/mothership/application/execute-file-use-case', () => ({
  executeCopilotFileUseCase: mockExecuteCopilotFileUseCase,
}))

vi.mock('@/lib/workspace-files/application/write-workspace-file-by-path', () => ({
  createWorkspaceFileBufferByPath: vi.fn(),
  updateWorkspaceFileContentBufferByPath: vi.fn(),
}))

vi.mock('@/lib/uploads/contexts/workspace/workspace-file-secret-provenance', () => ({
  EXACT_EMPTY_WORKSPACE_FILE_SECRET_PROVENANCE: { status: 'exact', entries: [] },
  createWorkspaceFileSecretProvenanceFromRegistry: vi.fn(async () => ({
    safe: true,
    provenance: { status: 'exact', entries: [] },
  })),
}))

import { createFileServerTool } from '@/lib/mothership/tools/server/files/create-file'

describe('createFileServerTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecuteCopilotFileUseCase.mockImplementation(
      async (_ctx: unknown, _useCase: unknown, input: { path: string; content: Buffer }) => ({
        id: 'file-1',
        name: input.path.split('/').pop() ?? input.path,
        vfsPath: input.path,
        size: input.content.byteLength,
      })
    )
  })

  it('writes markdown content when content is provided', async () => {
    const result = await createFileServerTool.execute(
      {
        fileName: 'files/notes.md',
        content: '# Hello\n\nBody text',
      },
      { userId: 'user-1', workspaceId: 'ws-1' }
    )

    expect(result.success).toBe(true)
    expect(result.data?.size).toBeGreaterThan(0)
    expect(mockExecuteCopilotFileUseCase).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        path: 'files/notes.md',
        content: Buffer.from('# Hello\n\nBody text', 'utf-8'),
      })
    )
  })

  it('rejects empty text/json create without content', async () => {
    const result = await createFileServerTool.execute(
      { outputs: { files: [{ path: 'files/notes.md', mode: 'create' }] } },
      { userId: 'user-1', workspaceId: 'ws-1' }
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('requires non-empty')
    expect(mockExecuteCopilotFileUseCase).not.toHaveBeenCalled()
  })

  it('creates an empty office shell when content is omitted', async () => {
    const result = await createFileServerTool.execute(
      { outputs: { files: [{ path: 'files/Deck.pptx', mode: 'create' }] } },
      { userId: 'user-1', workspaceId: 'ws-1' }
    )

    expect(result.success).toBe(true)
    expect(result.data?.size).toBe(0)
    expect(result.message).toContain('Empty file shell')
    expect(mockExecuteCopilotFileUseCase).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        path: 'files/Deck.pptx',
        content: Buffer.from('', 'utf-8'),
      })
    )
  })

  it('stringifies object content for json files', async () => {
    const result = await createFileServerTool.execute(
      {
        fileName: 'files/samples.json',
        content: { samples: [{ id: 1 }] },
      },
      { userId: 'user-1', workspaceId: 'ws-1' }
    )

    expect(result.success).toBe(true)
    expect(mockExecuteCopilotFileUseCase).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        path: 'files/samples.json',
        content: Buffer.from(JSON.stringify({ samples: [{ id: 1 }] }, null, 2), 'utf-8'),
      })
    )
  })
})
