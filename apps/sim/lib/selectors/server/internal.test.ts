import { environmentUtilsMockFns, resetEnvironmentUtilsMock } from '@sim/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListWorkflows = vi.hoisted(() => vi.fn())
const mockFetchOpenRouterEmbeddingModelCatalog = vi.hoisted(() => vi.fn())
const mockGetWorkspaceOrganizationAccounts = vi.hoisted(() => vi.fn())
const mockListKnowledgeDocuments = vi.hoisted(() => vi.fn())
const mockReadKnowledgeDocument = vi.hoisted(() => vi.fn())

vi.mock('@/lib/knowledge/application/documents', () => ({
  listKnowledgeDocuments: { execute: mockListKnowledgeDocuments },
  readKnowledgeDocument: { execute: mockReadKnowledgeDocument },
}))

vi.mock('@/lib/credential-groups/application/workspace-organization-accounts', () => ({
  getWorkspaceOrganizationAccounts: { execute: mockGetWorkspaceOrganizationAccounts },
}))

vi.mock('@/lib/workflows/application/list-workflows', () => ({
  listWorkflows: { execute: mockListWorkflows },
}))

vi.mock('@/lib/embeddings/openrouter-model-catalog.server', () => ({
  fetchOpenRouterEmbeddingModelCatalog: mockFetchOpenRouterEmbeddingModelCatalog,
}))

import { SelectorOptionsUnavailableError } from '@/lib/selectors/server/errors'
import { internalSelectorAttachments } from '@/lib/selectors/server/internal'
import { createSelectorProtectedValues } from '@/lib/selectors/server/protected-values'
import type { ExecuteServerSelectorArgs } from '@/lib/selectors/server/types'

function workflowArgs(): ExecuteServerSelectorArgs {
  return {
    selectorKey: 'sim.workflows',
    context: {},
    request: { kind: 'list' },
    scope: { kind: 'workspace', workspaceId: 'workspace-1' },
    workspaceId: 'workspace-1',
    principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1' },
    requesterUserId: 'user-1',
    references: new Map(),
    protectedValues: createSelectorProtectedValues(),
  }
}

describe.each([
  {
    key: 'workspace.credentialGroupProviders',
    field: 'providers',
    option: { id: 'google-email', label: 'Gmail' },
  },
  {
    key: 'workspace.organizationMcpProviders',
    field: 'mcpProviders',
    option: { id: 'fireflies', label: 'Fireflies' },
  },
] as const)('$key selector', ({ key, field, option }) => {
  it('uses the authorized organization provider projection', async () => {
    mockGetWorkspaceOrganizationAccounts.mockResolvedValue({ allowed: true, [field]: [option] })
    const args: ExecuteServerSelectorArgs = { ...workflowArgs(), selectorKey: key }
    await expect(internalSelectorAttachments[key].execute(args)).resolves.toEqual({
      kind: 'list',
      items: [option],
    })
    expect(mockGetWorkspaceOrganizationAccounts).toHaveBeenCalledWith({
      principal: args.principal,
      input: { workspaceId: 'workspace-1' },
    })
  })
  it('refuses providers when workspace access is not granted', async () => {
    mockGetWorkspaceOrganizationAccounts.mockResolvedValue({ allowed: false, [field]: [option] })
    await expect(
      internalSelectorAttachments[key].execute({ ...workflowArgs(), selectorKey: key })
    ).rejects.toBeInstanceOf(SelectorOptionsUnavailableError)
  })
})

describe('workspace.secretNames selector', () => {
  beforeEach(() => {
    resetEnvironmentUtilsMock()
  })

  it('returns the ACL-filtered names without loading the decrypted environment snapshot', async () => {
    environmentUtilsMockFns.mockGetEffectiveEnvironmentVariableNames.mockResolvedValue([
      'PERSONAL_KEY',
      'SHARED_KEY',
    ])

    await expect(
      internalSelectorAttachments['workspace.secretNames'].execute({
        selectorKey: 'workspace.secretNames',
        context: {},
        request: { kind: 'list' },
        scope: { kind: 'workspace', workspaceId: 'workspace-1' },
        workspaceId: 'workspace-1',
        principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1' },
        requesterUserId: 'user-1',
        references: new Map(),
        protectedValues: createSelectorProtectedValues(),
      })
    ).resolves.toEqual({
      kind: 'list',
      items: [
        { id: 'PERSONAL_KEY', label: 'PERSONAL_KEY' },
        { id: 'SHARED_KEY', label: 'SHARED_KEY' },
      ],
    })

    expect(environmentUtilsMockFns.mockGetEffectiveEnvironmentVariableNames).toHaveBeenCalledWith(
      'user-1',
      'workspace-1'
    )
    expect(environmentUtilsMockFns.mockGetEffectiveEnvironmentSnapshot).not.toHaveBeenCalled()
  })
})

describe('sim.workflows selector', () => {
  it('continues beyond the former 5,000-workflow limit', async () => {
    for (let page = 0; page < 20; page += 1) {
      mockListWorkflows.mockResolvedValueOnce({
        workflows: [],
        nextCursorKeys: [`page-${page + 1}`],
      })
    }
    mockListWorkflows.mockResolvedValueOnce({
      workflows: [{ id: 'workflow-late', name: 'Late workflow', folderPath: '/' }],
      nextCursorKeys: null,
    })

    await expect(
      internalSelectorAttachments['sim.workflows'].execute(workflowArgs())
    ).resolves.toEqual({
      kind: 'list',
      items: [{ id: 'workflow-late', label: 'Late workflow' }],
    })
    expect(mockListWorkflows).toHaveBeenCalledTimes(21)
  })

  it('fails rather than returning a partial list after 10,000 workflows', async () => {
    const workflowPage = Array.from({ length: 250 }, (_, index) => ({
      id: `workflow-${index}`,
      name: `Workflow ${index}`,
      folderPath: '/',
    }))
    mockListWorkflows.mockResolvedValue({
      workflows: workflowPage,
      nextCursorKeys: ['more'],
    })

    await expect(
      internalSelectorAttachments['sim.workflows'].execute(workflowArgs())
    ).rejects.toBeInstanceOf(SelectorOptionsUnavailableError)
    expect(mockListWorkflows).toHaveBeenCalledTimes(40)
  })
})

describe('providers.openrouterEmbeddingModels selector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetEnvironmentUtilsMock()
  })

  it('passes the selector signal to the OpenRouter catalog fetch', async () => {
    const controller = new AbortController()
    mockFetchOpenRouterEmbeddingModelCatalog.mockResolvedValue([
      { id: 'openai/text-embedding-3-small', maxInputTokens: 8_191 },
    ])

    await expect(
      internalSelectorAttachments['providers.openrouterEmbeddingModels'].execute({
        ...workflowArgs(),
        selectorKey: 'providers.openrouterEmbeddingModels',
        signal: controller.signal,
      })
    ).resolves.toEqual({
      kind: 'list',
      items: [
        {
          id: 'openai/text-embedding-3-small',
          label: 'openai/text-embedding-3-small',
        },
      ],
    })

    expect(mockFetchOpenRouterEmbeddingModelCatalog).toHaveBeenCalledOnce()
    expect(mockFetchOpenRouterEmbeddingModelCatalog).toHaveBeenCalledWith(controller.signal)
  })
})

describe('knowledge.documents selector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListKnowledgeDocuments.mockResolvedValue({
      documents: [{ id: 'doc-1', filename: 'guide.pdf' }],
      pagination: { offset: 0, limit: 100, hasMore: false },
    })
    mockReadKnowledgeDocument.mockResolvedValue({
      document: { id: 'doc-1', filename: 'guide.pdf' },
    })
  })

  function documentArgs(
    overrides: Partial<ExecuteServerSelectorArgs> = {}
  ): ExecuteServerSelectorArgs {
    return {
      ...workflowArgs(),
      selectorKey: 'knowledge.documents',
      context: { knowledgeBaseId: 'kb-1' },
      ...overrides,
    }
  }

  it('lists documents without asserting the editor workspace onto the knowledge base', async () => {
    await expect(
      internalSelectorAttachments['knowledge.documents'].execute(documentArgs())
    ).resolves.toEqual({
      kind: 'list',
      items: [{ id: 'doc-1', label: 'guide.pdf' }],
    })
    expect(mockListKnowledgeDocuments).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId: 'user-1' }),
      input: expect.objectContaining({
        knowledgeBaseId: 'kb-1',
        enabledFilter: 'all',
      }),
    })
    expect(mockListKnowledgeDocuments.mock.calls[0][0].input).not.toHaveProperty(
      'assertedWorkspaceId'
    )
  })

  it('resolves a selected document without asserting the editor workspace', async () => {
    await expect(
      internalSelectorAttachments['knowledge.documents'].execute(
        documentArgs({ request: { kind: 'detail', id: 'doc-1' } })
      )
    ).resolves.toEqual({
      kind: 'detail',
      item: { id: 'doc-1', label: 'guide.pdf' },
    })
    expect(mockReadKnowledgeDocument).toHaveBeenCalledWith({
      principal: expect.objectContaining({ userId: 'user-1' }),
      input: { knowledgeBaseId: 'kb-1', documentId: 'doc-1' },
    })
  })
})
