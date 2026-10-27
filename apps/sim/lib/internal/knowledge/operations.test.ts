import { createExecutorPrincipal } from '@sim/testing/factories/principal.factory'
import {
  billingAttributionMock,
  billingAttributionMockFns,
} from '@sim/testing/mocks/billing-attribution.mock'
import {
  knowledgeSearchUseCaseMock,
  knowledgeSearchUseCaseMockFns,
} from '@sim/testing/mocks/knowledge-search-use-case.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listKnowledgeTags: { execute: vi.fn() },
  syncKnowledgeConnector: { execute: vi.fn() },
  connectorSynced: vi.fn(),
}))

vi.mock('@/lib/billing/core/billing-attribution', () => billingAttributionMock)

vi.mock('@/lib/knowledge/api/internal-route', () => ({
  internalKnowledgeActorUserId: (principal: { subjectUserId?: string }) =>
    principal.subjectUserId ?? 'billing-owner',
  internalKnowledgeProvenanceUserId: (_headers: Headers, principal: { subjectUserId?: string }) =>
    principal.subjectUserId ?? 'billing-owner',
  internalKnowledgeAnalytics: {
    connectorSynced: mocks.connectorSynced,
    documentDeleted: vi.fn(),
    documentUpserted: vi.fn(),
    documentsUploaded: vi.fn(),
  },
  toInternalKnowledgeChunk: (value: unknown) => value,
  toInternalKnowledgeConnector: (value: unknown) => value,
  toInternalKnowledgeConnectorDetail: (value: unknown) => value,
  toInternalKnowledgeDocument: (value: unknown) => value,
  toInternalKnowledgeTag: (value: unknown) => value,
}))

vi.mock('@/lib/knowledge/api/secret-provenance', () => ({
  finalizeKnowledgePersistedResponse: vi.fn().mockResolvedValue({}),
  finalizeKnowledgeProvenanceResponse: vi.fn().mockResolvedValue({}),
  finalizeKnowledgeRegistryResponse: vi.fn().mockReturnValue({}),
  resolveKnowledgeDocumentWriteSecretProvenance: vi.fn().mockReturnValue({ success: true }),
  resolveKnowledgeWriteSecretProvenance: vi.fn().mockReturnValue({ success: true }),
}))

vi.mock('@/lib/knowledge/application/chunks', () => ({
  createKnowledgeChunk: { execute: vi.fn() },
  deleteKnowledgeChunk: { execute: vi.fn() },
  listKnowledgeChunks: { execute: vi.fn() },
  updateKnowledgeChunk: { execute: vi.fn() },
}))

vi.mock('@/lib/knowledge/application/connectors', () => ({
  listKnowledgeConnectors: { execute: vi.fn() },
  readKnowledgeConnector: { execute: vi.fn() },
  syncKnowledgeConnector: mocks.syncKnowledgeConnector,
}))

vi.mock('@/lib/knowledge/application/documents', () => ({
  createKnowledgeDocuments: { execute: vi.fn() },
  deleteKnowledgeDocument: { execute: vi.fn() },
  listKnowledgeDocuments: { execute: vi.fn() },
  readKnowledgeDocument: { execute: vi.fn() },
  upsertKnowledgeDocument: { execute: vi.fn() },
}))

vi.mock('@/lib/knowledge/application/search', () => knowledgeSearchUseCaseMock)

vi.mock('@/lib/knowledge/application/tags', () => ({
  listKnowledgeTags: mocks.listKnowledgeTags,
}))

vi.mock('@/lib/knowledge/model-input-provenance', () => ({
  prepareKnowledgeModelInputProvenance: vi.fn(),
}))

vi.mock('@/lib/knowledge/secret-provenance', () => ({
  createKnowledgeDocumentSourceValue: vi.fn(),
}))

import { internalKnowledgeSearchContract } from '@/lib/api/contracts/knowledge/search'
import {
  type KnowledgeOperationContext,
  listTagsOperation,
  searchOperation,
  syncConnectorOperation,
} from '@/lib/internal/knowledge/operations'

const { mockResolveBillingAttribution } = billingAttributionMockFns
const { mockSearchKnowledgeExecute } = knowledgeSearchUseCaseMockFns

const principal = createExecutorPrincipal({
  subjectUserId: 'trusted-user',
  audience: 'sim:knowledge',
  expiresAt: new Date('2026-01-01T00:05:00.000Z'),
  delegationContext: { kind: 'workflow_execution', workflowId: 'workflow-1' },
})

function createContext(): KnowledgeOperationContext {
  return { principal, headers: new Headers({ 'x-billing': 'snapshot' }) }
}

describe('Knowledge direct operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls the canonical tag use case without asserting the workflow workspace', async () => {
    const tag = {
      id: 'tag-1',
      tagSlot: 'tag1',
      displayName: 'Team',
      fieldType: 'text',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    mocks.listKnowledgeTags.execute.mockResolvedValue({ tagDefinitions: [tag] })
    const context = createContext()

    const result = await listTagsOperation('kb-1', context)

    expect(mocks.listKnowledgeTags.execute).toHaveBeenCalledWith({
      principal,
      input: { knowledgeBaseId: 'kb-1' },
      request: { headers: context.headers },
    })
    expect(result.body).toEqual({ success: true, data: [tag] })
  })

  it('bills the knowledge-base workspace without asserting the workflow workspace', async () => {
    const attribution = { actorUserId: 'trusted-user', workspaceId: 'workspace-2' }
    mockResolveBillingAttribution.mockResolvedValue(attribution)
    mocks.syncKnowledgeConnector.execute.mockImplementation(async ({ input }) => {
      await expect(input.resolveBillingAttribution('workspace-2')).resolves.toBe(attribution)
      return {
        knowledgeBaseId: 'kb-1',
        workspaceId: 'workspace-2',
        connectorId: 'connector-1',
        connectorType: 'notion',
      }
    })
    const context = createContext()

    const result = await syncConnectorOperation('kb-1', 'connector-1', false, context)

    expect(mockResolveBillingAttribution).toHaveBeenCalledWith({
      actorUserId: 'trusted-user',
      workspaceId: 'workspace-2',
    })
    expect(mocks.syncKnowledgeConnector.execute).toHaveBeenCalledWith({
      principal,
      input: expect.objectContaining({
        knowledgeBaseId: 'kb-1',
        connectorId: 'connector-1',
        source: 'ui',
      }),
      request: { headers: context.headers },
    })
    expect(mocks.syncKnowledgeConnector.execute.mock.calls[0][0].input).not.toHaveProperty(
      'assertedWorkspaceId'
    )
    expect(mocks.connectorSynced).toHaveBeenCalledOnce()
    expect(result.body).toEqual({ success: true, message: 'Sync triggered' })
  })

  it('searches by knowledge base id without asserting the workflow workspace', async () => {
    mockSearchKnowledgeExecute.mockResolvedValue({
      results: [],
      query: 'answer',
      knowledgeBaseIds: ['kb-1'],
      knowledgeBaseId: 'kb-1',
      topK: 10,
      totalResults: 0,
      resultSecretRegistry: { isComplete: () => true },
    })
    const context = createContext()

    const result = await searchOperation(
      { knowledgeBaseIds: ['kb-1'], query: 'answer', topK: 10, skipUsageBilling: true },
      context
    )

    expect(mockSearchKnowledgeExecute).toHaveBeenCalledWith({
      principal,
      input: expect.objectContaining({
        knowledgeBaseIds: ['kb-1'],
        query: 'answer',
        topK: 10,
        surface: 'workflow',
        skipUsageBilling: true,
      }),
      request: { headers: context.headers },
    })
    expect(mockSearchKnowledgeExecute.mock.calls[0][0].input).not.toHaveProperty('workspaceId')
    expect(result.body).toEqual({
      success: true,
      data: {
        results: [],
        query: 'answer',
        knowledgeBaseIds: ['kb-1'],
        knowledgeBaseId: 'kb-1',
        topK: 10,
        totalResults: 0,
      },
    })
  })

  it('presents embedding identity as chunkId so the search contract can validate results', async () => {
    mockSearchKnowledgeExecute.mockResolvedValue({
      results: [
        {
          embeddingId: 'embedding-1',
          knowledgeBaseId: 'kb-1',
          documentId: 'document-1',
          documentName: 'guide.pdf',
          sourceUrl: null,
          sourceModifiedAt: null,
          connectorType: null,
          content: 'answer',
          chunkIndex: 0,
          metadata: {},
          similarity: 0.8,
          rankScore: 0.42,
          rank: 1,
        },
      ],
      query: 'answer',
      knowledgeBaseIds: ['kb-1'],
      knowledgeBaseId: 'kb-1',
      topK: 10,
      totalResults: 1,
      workspaceId: 'workspace-1',
      resultSecretRegistry: { isComplete: () => true },
    })

    const result = await searchOperation(
      { knowledgeBaseIds: ['kb-1'], query: 'answer', topK: 10, skipUsageBilling: true },
      createContext()
    )

    expect(result.body).toEqual({
      success: true,
      data: {
        results: [
          {
            documentId: 'document-1',
            documentName: 'guide.pdf',
            sourceUrl: null,
            content: 'answer',
            chunkIndex: 0,
            metadata: {},
            similarity: 0.8,
            rankScore: 0.42,
            rank: 1,
            knowledgeBaseId: 'kb-1',
            chunkId: 'embedding-1',
            workspaceId: 'workspace-1',
          },
        ],
        query: 'answer',
        knowledgeBaseIds: ['kb-1'],
        knowledgeBaseId: 'kb-1',
        topK: 10,
        totalResults: 1,
      },
    })
    expect(internalKnowledgeSearchContract.response.schema.parse(result.body)).toEqual(result.body)
  })
})
