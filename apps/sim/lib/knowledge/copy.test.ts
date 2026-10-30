/**
 * Regression tests for knowledge base copy service guards.
 * Focuses on permission and validation paths that must not regress
 * existing create/update/delete KB behavior.
 *
 * @vitest-environment node
 */
import {
  dbChainMock,
  dbChainMockFns,
  permissionsMock,
  permissionsMockFns,
  resetDbChainMock,
} from '@sim/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sim/db', () => dbChainMock)
vi.mock('@/lib/workspaces/permissions/utils', () => permissionsMock)

vi.mock('@/lib/uploads/core/storage-service', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
}))

vi.mock('@/lib/uploads/contexts/knowledge-base/file-manager', () => ({
  generateKnowledgeBaseFileKey: vi.fn(() => 'kb/copied-file'),
}))

const { mockDeleteKnowledgeBase, mockGetKnowledgeBaseById } = vi.hoisted(() => ({
  mockDeleteKnowledgeBase: vi.fn(),
  mockGetKnowledgeBaseById: vi.fn(),
}))

vi.mock('@/lib/knowledge/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge/service')>()
  return {
    ...actual,
    deleteKnowledgeBase: mockDeleteKnowledgeBase,
    getKnowledgeBaseById: mockGetKnowledgeBaseById,
  }
})

import { copyKnowledgeBaseToWorkspace } from '@/lib/knowledge/copy'
import { KnowledgeBasePermissionError } from '@/lib/knowledge/service'

describe('copyKnowledgeBaseToWorkspace — authorization and validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDbChainMock()
    dbChainMockFns.limit.mockReset()
  })

  it('rejects when the actor lacks write/admin on the target workspace', async () => {
    permissionsMockFns.mockGetUserEntityPermissions.mockResolvedValueOnce('read')

    await expect(
      copyKnowledgeBaseToWorkspace({
        sourceKnowledgeBaseId: 'kb-1',
        targetWorkspaceId: 'ws-target',
        userId: 'user-1',
        requestId: 'req-1',
      })
    ).rejects.toBeInstanceOf(KnowledgeBasePermissionError)

    expect(permissionsMockFns.mockGetUserEntityPermissions).toHaveBeenCalledWith(
      'user-1',
      'workspace',
      'ws-target'
    )
    expect(dbChainMockFns.select).not.toHaveBeenCalled()
  })

  it('rejects when the actor has no permission on the target workspace', async () => {
    permissionsMockFns.mockGetUserEntityPermissions.mockResolvedValueOnce(null)

    await expect(
      copyKnowledgeBaseToWorkspace({
        sourceKnowledgeBaseId: 'kb-1',
        targetWorkspaceId: 'ws-target',
        userId: 'user-1',
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_BASE_FORBIDDEN',
    })
  })

  it('rejects when the source knowledge base does not exist', async () => {
    permissionsMockFns.mockGetUserEntityPermissions.mockResolvedValueOnce('write')
    dbChainMockFns.limit.mockResolvedValueOnce([])

    await expect(
      copyKnowledgeBaseToWorkspace({
        sourceKnowledgeBaseId: 'kb-missing',
        targetWorkspaceId: 'ws-target',
        userId: 'user-1',
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_BASE_COPY_FAILED',
      message: 'Knowledge base not found',
    })
  })

  it('rejects copying into the same workspace', async () => {
    permissionsMockFns.mockGetUserEntityPermissions.mockResolvedValueOnce('admin')
    dbChainMockFns.limit.mockResolvedValueOnce([
      {
        id: 'kb-1',
        workspaceId: 'ws-same',
        name: 'Source',
        description: null,
        embeddingModel: 'text-embedding-3-small',
        embeddingDimension: 1536,
        chunkingConfig: { maxSize: 1024, minSize: 100, overlap: 200 },
        tokenCount: 0,
      },
    ])

    await expect(
      copyKnowledgeBaseToWorkspace({
        sourceKnowledgeBaseId: 'kb-1',
        targetWorkspaceId: 'ws-same',
        userId: 'user-1',
        requestId: 'req-1',
      })
    ).rejects.toMatchObject({
      code: 'KNOWLEDGE_BASE_COPY_FAILED',
      message: 'Cannot copy a knowledge base into the same workspace',
    })
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })
})
