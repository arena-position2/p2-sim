import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { AuthType } from '@/lib/auth/hybrid'
import {
  PRIVATE_SECRET_PROVENANCE_BUNDLE_V1,
  PRIVATE_SECRET_PROVENANCE_FIELD,
  PRIVATE_SECRET_PROVENANCE_HEADER,
  PRIVATE_TOOL_METADATA_REQUEST_HEADER,
  RESOLVED_SECRET_PROVENANCE_FIELD,
  RESOLVED_SECRET_PROVENANCE_METADATA_V1,
} from '@/lib/execution/private-tool-metadata'
import {
  finalizeKnowledgeProvenanceResponse,
  finalizeKnowledgeRegistryResponse,
  resolveKnowledgeDocumentWriteSecretProvenance,
  resolveKnowledgeWriteSecretProvenance,
} from '@/app/api/knowledge/secret-provenance'
import { ResolvedSecretTraceRegistry } from '@/executor/utils/resolved-secret-trace-registry'

const PRIVATE_PROVENANCE_SCOPE = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
} as const

function createRequest(
  payload: Record<string, unknown>,
  provenanceHeader = PRIVATE_SECRET_PROVENANCE_BUNDLE_V1
): NextRequest {
  return new NextRequest('http://localhost/api/knowledge/kb/documents', {
    method: 'POST',
    headers: { [PRIVATE_SECRET_PROVENANCE_HEADER]: provenanceHeader },
    body: JSON.stringify(payload),
  })
}

function createHeaderlessRequest(payload: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/knowledge/kb/documents', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

function privateChunkPayload(
  scope: { userId: string; workspaceId?: string },
  entries: Array<{ name: string; encryptedValue: string }> = []
) {
  return {
    content: 'workflow content',
    [PRIVATE_SECRET_PROVENANCE_FIELD]: {
      version: 1 as const,
      complete: true,
      selections: [
        {
          key: 'chunk-content',
          provenance: { version: 1 as const, complete: true, entries, scope },
        },
      ],
    },
  }
}

describe('knowledge write secret provenance', () => {
  it('classifies a headerless external chunk write as exact-empty', () => {
    const payload = { content: 'manual content' }

    const result = resolveKnowledgeWriteSecretProvenance({
      headers: createHeaderlessRequest(payload).headers,
      payload,
      authType: AuthType.API_KEY,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      selectionKeys: ['chunk-content'],
    })

    expect(result).toEqual({
      success: true,
      provenances: [{ status: 'exact', entries: [] }],
    })
  })

  it('does not track durable provenance for a legacy headerless internal write', () => {
    const payload = { content: 'legacy workflow content' }

    const result = resolveKnowledgeWriteSecretProvenance({
      headers: createHeaderlessRequest(payload).headers,
      payload,
      authType: AuthType.INTERNAL_JWT,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      selectionKeys: ['chunk-content'],
    })

    expect(result).toEqual({ success: true })
  })

  it('tracks exact-empty provenance only when an internal write supplies a verified envelope', () => {
    const payload = privateChunkPayload(PRIVATE_PROVENANCE_SCOPE)

    const result = resolveKnowledgeWriteSecretProvenance({
      headers: createRequest(payload).headers,
      payload,
      authType: AuthType.INTERNAL_JWT,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      selectionKeys: ['chunk-content'],
    })

    expect(result).toEqual({
      success: true,
      provenances: [{ status: 'exact', entries: [] }],
    })
  })

  it('rejects provenance from another workspace', () => {
    const payload = privateChunkPayload({
      userId: 'workflow-owner',
      workspaceId: 'workspace-2',
    })
    const result = resolveKnowledgeWriteSecretProvenance({
      headers: createRequest(payload).headers,
      payload,
      authType: AuthType.INTERNAL_JWT,
      userId: 'billing-actor',
      workspaceId: 'workspace-1',
      selectionKeys: ['chunk-content'],
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.response.status).toBe(400)
  })

  it('keeps workspace-less knowledge writes isolated to the authenticated user', () => {
    const payload = privateChunkPayload({ userId: 'workflow-owner' })
    const result = resolveKnowledgeWriteSecretProvenance({
      headers: createRequest(payload).headers,
      payload,
      authType: AuthType.INTERNAL_JWT,
      userId: 'billing-actor',
      selectionKeys: ['chunk-content'],
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.response.status).toBe(400)
  })

  it('rejects a private provenance envelope from an external caller', () => {
    const bundle = {
      version: 1 as const,
      complete: true,
      selections: [
        {
          key: 'chunk-content',
          provenance: {
            version: 1 as const,
            complete: true,
            entries: [],
            scope: PRIVATE_PROVENANCE_SCOPE,
          },
        },
      ],
    }
    const payload = { content: 'external content', [PRIVATE_SECRET_PROVENANCE_FIELD]: bundle }

    const result = resolveKnowledgeWriteSecretProvenance({
      headers: createRequest(payload).headers,
      payload,
      authType: AuthType.API_KEY,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      selectionKeys: ['chunk-content'],
    })

    expect(result.success).toBe(false)
    if (!result.success) expect(result.response.status).toBe(400)
  })

  it('persists authenticated unavailable selection lineage as unknown', () => {
    const bundle = {
      version: 1 as const,
      complete: true,
      selections: [
        {
          key: 'document-source:0',
          provenance: {
            version: 1 as const,
            complete: false,
            entries: [],
            scope: PRIVATE_PROVENANCE_SCOPE,
          },
        },
      ],
    }
    const payload = { [PRIVATE_SECRET_PROVENANCE_FIELD]: bundle }

    const result = resolveKnowledgeWriteSecretProvenance({
      headers: createRequest(payload).headers,
      payload,
      authType: AuthType.INTERNAL_JWT,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      selectionKeys: ['document-source:0'],
    })

    expect(result).toEqual({ success: true, provenances: [{ status: 'unknown' }] })
  })

  it('keeps persisted tag names raw while retaining tag-value provenance', () => {
    const documentTagsData = JSON.stringify([{ tagName: 'private-name', value: 'west' }])
    const payload = {
      documents: [{ filename: 'doc.md', documentTagsData }],
      [PRIVATE_SECRET_PROVENANCE_FIELD]: {
        version: 1 as const,
        complete: true,
        selections: [
          {
            key: 'document-filename:0',
            provenance: {
              version: 1 as const,
              complete: true,
              entries: [],
              scope: PRIVATE_PROVENANCE_SCOPE,
            },
          },
          {
            key: 'document-content:0',
            provenance: {
              version: 1 as const,
              complete: true,
              entries: [],
              scope: PRIVATE_PROVENANCE_SCOPE,
            },
          },
          {
            key: 'document-tag-value:0:0',
            provenance: {
              version: 1 as const,
              complete: true,
              entries: [{ name: 'TAG_VALUE', encryptedValue: 'encrypted-tag-value' }],
              scope: PRIVATE_PROVENANCE_SCOPE,
            },
          },
        ],
      },
    }

    const result = resolveKnowledgeDocumentWriteSecretProvenance({
      headers: createRequest(payload).headers,
      payload,
      authType: AuthType.INTERNAL_JWT,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      documents: [{ documentTagsData }],
    })

    expect(result).toEqual({
      success: true,
      provenances: [
        {
          filename: { status: 'exact', entries: [] },
          content: { status: 'exact', entries: [] },
          tags: [
            {
              tagName: 'private-name',
              provenance: {
                status: 'exact',
                entries: [
                  {
                    name: 'TAG_VALUE',
                    encryptedValue: 'encrypted-tag-value',
                    sourceUserId: 'user-1',
                    sourceWorkspaceId: 'workspace-1',
                  },
                ],
              },
            },
          ],
        },
      ],
    })
  })
})

describe('knowledge response provenance finalization', () => {
  function createMetadataRequest(): NextRequest {
    return new NextRequest('http://localhost/api/knowledge/search', {
      method: 'POST',
      headers: {
        [PRIVATE_TOOL_METADATA_REQUEST_HEADER]: RESOLVED_SECRET_PROVENANCE_METADATA_V1,
      },
      body: JSON.stringify({ query: 'answer' }),
    })
  }

  it('exports complete empty provenance when the registry is incomplete and Knowledge is unenforced', () => {
    const registry = new ResolvedSecretTraceRegistry([], PRIVATE_PROVENANCE_SCOPE)
    registry.markIncomplete('knowledge-result-provenance-unavailable')
    const body = { success: true, results: [{ content: 'answer' }] }

    const finalization = finalizeKnowledgeRegistryResponse({
      request: createMetadataRequest(),
      authType: AuthType.INTERNAL_JWT,
      body,
      registry,
    })

    expect(finalization.bodyFields?.[RESOLVED_SECRET_PROVENANCE_FIELD]).toEqual({
      version: 1,
      complete: true,
      entries: [],
      scope: PRIVATE_PROVENANCE_SCOPE,
    })
  })

  it('does not latch unknown write provenance onto the response when Knowledge is unenforced', async () => {
    const body = { success: true, document: { id: 'doc-1' } }

    const finalization = await finalizeKnowledgeProvenanceResponse({
      request: createMetadataRequest(),
      authType: AuthType.INTERNAL_JWT,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      body,
      provenances: [{ status: 'unknown' }],
    })

    expect(finalization.bodyFields?.[RESOLVED_SECRET_PROVENANCE_FIELD]).toEqual({
      version: 1,
      complete: true,
      entries: [],
      scope: {
        userId: 'user-1',
        workspaceId: 'workspace-1',
      },
    })
  })
})
