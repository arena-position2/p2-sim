/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - missing required args → rejected before file APIs
 * - no workspace → denied
 * - unsupported namespaces (agent/, workflows/, …) → empty/note, not Tool not found
 * - glob / read happy path over workspace files (regression: must not 404)
 * - executor early intercept for glob/grep/read
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeCopilotFileUseCase, listChatUploads } = vi.hoisted(() => ({
  executeCopilotFileUseCase: vi.fn(),
  listChatUploads: vi.fn(),
}))

vi.mock('@/lib/mothership/application/execute-file-use-case', () => ({
  executeCopilotFileUseCase,
}))
vi.mock('@/lib/mothership/tools/handlers/upload-file-reader', () => ({
  listChatUploads,
}))

import {
  executeLocalCopilotTool,
  type ToolExecutionContext,
} from '@/local-copilot/lib/tools/executor'
import { executeLocalVfsTool } from '@/local-copilot/lib/tools/vfs-read-tools'
import type { LocalCopilotStructuredContext } from '@/local-copilot/lib/types'

const workspaceId = 'workspace-1'
const userId = 'user-1'

function toolCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  const structuredContext: LocalCopilotStructuredContext = {
    workspace: { id: workspaceId, name: 'Workspace', environment: 'self_hosted' },
    connectedIntegrations: [],
    envVariables: [],
    hostedKeysAvailable: false,
    execution: {
      lastRunStatus: 'unknown',
      logs: [],
      failedBlockId: null,
      error: null,
    },
    availableIntegrations: [],
    availableBlocks: [],
  }
  return {
    userId,
    workspaceId,
    userPermission: 'admin',
    structuredContext,
    ...overrides,
  }
}

function mockWorkspaceFiles(files: Array<{ name: string; folderPath?: string | null }>): void {
  executeCopilotFileUseCase.mockImplementation(async (_ctx, _useCase, input: unknown) => {
    const record = input as Record<string, unknown>
    if (record.scope === 'active') {
      return {
        files: files.map((file) => ({
          id: `file-${file.name}`,
          name: file.name,
          folderPath: file.folderPath ?? null,
        })),
      }
    }
    if (typeof record.reference === 'string') {
      const reference = record.reference
      const leaf = reference.split('/').pop() ?? reference
      return {
        text: `content-of-${leaf}\nsecond-line`,
        truncated: false,
        degraded: false,
        degradedReason: null,
        byteCount: 20,
        file: { id: 'f1', name: leaf },
      }
    }
    throw new Error(`Unexpected executeCopilotFileUseCase input: ${JSON.stringify(input)}`)
  })
}

describe('executeLocalVfsTool', () => {
  beforeEach(() => {
    executeCopilotFileUseCase.mockReset()
    listChatUploads.mockReset()
    listChatUploads.mockResolvedValue([])
  })

  it('rejects glob without pattern before listing files', async () => {
    const result = await executeLocalVfsTool('glob', {}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/pattern/i)
    expect(executeCopilotFileUseCase).not.toHaveBeenCalled()
  })

  it('rejects read without path before reading files', async () => {
    const result = await executeLocalVfsTool('read', {}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/path/i)
    expect(executeCopilotFileUseCase).not.toHaveBeenCalled()
  })

  it('denies when workspace context is missing', async () => {
    const result = await executeLocalVfsTool(
      'glob',
      { pattern: 'files/**' },
      toolCtx({ workspaceId: '' })
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/workspace/i)
  })

  it('returns an empty glob with guidance for agent/ MCP paths', async () => {
    const result = await executeLocalVfsTool('glob', { pattern: 'agent/mcp*' }, toolCtx())
    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      files: [],
      note: expect.stringMatching(/manage_mcp_connection/i),
    })
    expect(executeCopilotFileUseCase).not.toHaveBeenCalled()
  })

  it('globs workspace files under files/', async () => {
    mockWorkspaceFiles([{ name: 'page.html' }, { name: 'data.csv', folderPath: 'Reports' }])

    const result = await executeLocalVfsTool('glob', { pattern: 'files/**/*.html' }, toolCtx())
    expect(result.success).toBe(true)
    expect(result.output).toEqual({
      files: expect.arrayContaining(['files/page.html']),
    })
    expect((result.output as { files: string[] }).files).not.toContain('files/Reports/data.csv')
  })

  it('reads a files/ path with offset/limit windowing', async () => {
    mockWorkspaceFiles([{ name: 'page.html' }])

    const result = await executeLocalVfsTool(
      'read',
      { path: 'files/page.html/content', offset: 1, limit: 1 },
      toolCtx()
    )
    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      content: 'second-line',
      totalLines: 2,
    })
  })

  it('rejects read of unsupported namespaces', async () => {
    const result = await executeLocalVfsTool('read', { path: 'workflows/abc' }, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/files\/ and uploads\//i)
  })
})

describe('executeLocalCopilotTool(glob/grep/read)', () => {
  beforeEach(() => {
    executeCopilotFileUseCase.mockReset()
    listChatUploads.mockReset()
    listChatUploads.mockResolvedValue([])
    mockWorkspaceFiles([{ name: 'notes.md' }])
  })

  it('executes glob locally instead of mothership Tool not found', async () => {
    const result = await executeLocalCopilotTool('glob', { pattern: 'files/**' }, toolCtx())
    expect(result.success).toBe(true)
    expect(result.toolName).toBe('glob')
    expect(result.result).toMatchObject({
      files: expect.arrayContaining(['files/notes.md']),
    })
    expect(result.error).toBeUndefined()
  })

  it('executes read locally and remembers the path', async () => {
    const ctx = toolCtx()
    const result = await executeLocalCopilotTool('read', { path: 'files/notes.md' }, ctx)
    expect(result.success).toBe(true)
    expect(result.toolName).toBe('read')
    expect(result.result).toMatchObject({
      content: expect.stringContaining('content-of-notes.md'),
    })
    expect(ctx.readVfsPaths?.has('files/notes.md')).toBe(true)
  })
})
