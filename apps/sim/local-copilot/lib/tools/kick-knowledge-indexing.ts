import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { isRecordLike, toArray } from '@sim/utils/object'
import type { BillingAttributionSnapshot } from '@/lib/billing/core/billing-attribution'
import { generateRequestId } from '@/lib/core/utils/request'
import { SYSTEM_ACCESS_SCOPE } from '@/lib/knowledge/access/types'
import { dispatchDocumentProcessing } from '@/lib/knowledge/documents/processing-dispatch'
import { getKnowledgeDocument } from '@/lib/knowledge/documents/service'

const logger = createLogger('LocalCopilotKnowledgeIndexing')

export interface AddedKnowledgeDocumentRef {
  knowledgeBaseId: string
  documentId: string
  filename: string
}

/**
 * Documents `add_file` just created. The shared handler only enqueues an outbox
 * row; Local starts the same indexing dispatch the manual upload uses.
 */
export function readAddedKnowledgeDocuments(output: unknown): AddedKnowledgeDocumentRef[] {
  if (!isRecordLike(output)) return []
  const data = isRecordLike(output.data) ? output.data : output
  const knowledgeBaseId = typeof data.knowledgeBaseId === 'string' ? data.knowledgeBaseId : ''
  if (!knowledgeBaseId) return []
  return toArray(data.added).flatMap((entry) => {
    if (!isRecordLike(entry)) return []
    const documentId = typeof entry.documentId === 'string' ? entry.documentId : ''
    const filename = typeof entry.filename === 'string' ? entry.filename : ''
    if (!documentId) return []
    return [{ knowledgeBaseId, documentId, filename }]
  })
}

/** Model-facing status. Indexing is in flight; the row stays Pending until it finishes. */
export function knowledgeIndexingMessage(addedNames: string[], dispatchedCount: number): string {
  const names = addedNames.filter((name) => name.length > 0).join(', ')
  const listed = names.length > 0 ? `: ${names}` : ''
  if (dispatchedCount === 0) {
    return `Added ${addedNames.length} file(s)${listed}. Indexing was not started.`
  }
  if (dispatchedCount < addedNames.length) {
    return `Added ${addedNames.length} file(s)${listed}. Indexing was dispatched for ${dispatchedCount} of them. Each document stays Pending until it shows Enabled.`
  }
  return `Added ${addedNames.length} file(s)${listed}. Indexing was dispatched. Each document stays Pending until it shows Enabled.`
}

/**
 * Starts indexing for documents a Local `add_file` just created, using the
 * same dispatch as a manual upload. The shared outbox row remains the backup
 * if this request dies first. Never throws — a kick failure leaves the row
 * Pending for that outbox.
 */
export async function kickLocalKnowledgeIndexing(params: {
  output: unknown
  billingAttribution?: BillingAttributionSnapshot
}): Promise<unknown> {
  const added = readAddedKnowledgeDocuments(params.output)
  if (added.length === 0 || !isRecordLike(params.output)) return params.output

  const knowledgeBaseId = added[0]?.knowledgeBaseId
  if (!knowledgeBaseId) return params.output

  const documents = []
  for (const ref of added) {
    try {
      const row = await getKnowledgeDocument(
        ref.knowledgeBaseId,
        ref.documentId,
        SYSTEM_ACCESS_SCOPE
      )
      if (!row) continue
      documents.push({
        documentId: row.id,
        filename: row.filename,
        fileUrl: row.fileUrl,
        fileSize: row.fileSize,
        mimeType: row.mimeType,
      })
    } catch (error) {
      logger.warn('Failed to load a knowledge document for indexing', {
        documentId: ref.documentId,
        error: getErrorMessage(error),
      })
    }
  }

  if (documents.length > 0) {
    await dispatchDocumentProcessing({
      documents,
      knowledgeBaseId,
      processingOptions: {},
      requestId: generateRequestId(),
      billingAttribution: params.billingAttribution,
    })
  }

  return {
    ...params.output,
    message: knowledgeIndexingMessage(
      added.map((ref) => ref.filename),
      documents.length
    ),
  }
}
