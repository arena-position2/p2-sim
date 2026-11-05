/**
 * Failure modes for Local knowledge ingest:
 * - add_file output with no added documents must not look like a successful ingest
 * - a nested `{ data: { added } }` payload is what the server handler returns
 * - the model message must not claim the document is already queryable
 * - kick dispatches the loaded original file and rewrites that message
 * - a document that cannot be loaded is not dispatched
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getKnowledgeDocument = vi.hoisted(() => vi.fn())
const dispatchDocumentProcessing = vi.hoisted(() => vi.fn())

vi.mock('@/lib/knowledge/documents/service', () => ({
  getKnowledgeDocument,
}))

vi.mock('@/lib/knowledge/documents/processing-dispatch', () => ({
  dispatchDocumentProcessing,
}))

import {
  kickLocalKnowledgeIndexing,
  knowledgeIndexingMessage,
  readAddedKnowledgeDocuments,
} from '@/local-copilot/lib/tools/kick-knowledge-indexing'

describe('readAddedKnowledgeDocuments', () => {
  it('reads documents from the add_file data envelope', () => {
    expect(
      readAddedKnowledgeDocuments({
        success: true,
        message: 'Processing started.',
        data: {
          knowledgeBaseId: 'kb-1',
          added: [{ documentId: 'doc-1', filename: 'notes.pdf' }],
        },
      })
    ).toEqual([{ knowledgeBaseId: 'kb-1', documentId: 'doc-1', filename: 'notes.pdf' }])
  })

  it('returns nothing when the handler added no files', () => {
    expect(
      readAddedKnowledgeDocuments({
        success: false,
        data: { knowledgeBaseId: 'kb-1', added: [], failed: ['files/missing.pdf'] },
      })
    ).toEqual([])
  })
})

describe('knowledgeIndexingMessage', () => {
  it('does not tell the model the document is already queryable', () => {
    const message = knowledgeIndexingMessage(['notes.pdf'], 1)
    expect(message).toContain('notes.pdf')
    expect(message).toContain('Pending')
    expect(message).not.toMatch(/queryable|processing started/i)
  })
})

describe('kickLocalKnowledgeIndexing', () => {
  beforeEach(() => {
    getKnowledgeDocument.mockReset()
    dispatchDocumentProcessing.mockReset().mockResolvedValue(undefined)
  })

  it('dispatches the original document and replaces the handler message', async () => {
    getKnowledgeDocument.mockResolvedValueOnce({
      id: 'doc-1',
      filename: 'notes.pdf',
      fileUrl: '/api/files/serve/kb/doc-1?context=knowledge-base',
      fileSize: 240_000,
      mimeType: 'application/pdf',
    })

    const output = await kickLocalKnowledgeIndexing({
      output: {
        success: true,
        message: 'Added 1 file(s) to "Notes": notes.pdf. Processing started.',
        data: {
          knowledgeBaseId: 'kb-1',
          added: [{ documentId: 'doc-1', filename: 'notes.pdf' }],
        },
      },
    })

    expect(dispatchDocumentProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: 'kb-1',
        documents: [
          expect.objectContaining({
            documentId: 'doc-1',
            filename: 'notes.pdf',
            mimeType: 'application/pdf',
          }),
        ],
      })
    )
    expect(output).toMatchObject({
      message: expect.stringContaining('Indexing was dispatched'),
    })
  })

  it('does not dispatch a document the load could not find', async () => {
    getKnowledgeDocument.mockResolvedValueOnce(null)
    const output = await kickLocalKnowledgeIndexing({
      output: {
        success: true,
        message: 'Processing started.',
        data: {
          knowledgeBaseId: 'kb-1',
          added: [{ documentId: 'doc-missing', filename: 'gone.pdf' }],
        },
      },
    })

    expect(dispatchDocumentProcessing).not.toHaveBeenCalled()
    expect(output).toMatchObject({ message: expect.stringContaining('not started') })
  })
})
