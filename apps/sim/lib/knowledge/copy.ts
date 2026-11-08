import { db } from '@sim/db'
import { document, embedding, knowledgeBase, knowledgeBaseTagDefinitions } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { getErrorMessage, getPostgresErrorCode } from '@sim/utils/errors'
import { generateId } from '@sim/utils/id'
import { and, asc, eq, gt, isNull, type SQL } from 'drizzle-orm'
import { mapWithConcurrency } from '@/lib/core/utils/concurrency'
import {
  deleteKnowledgeBase,
  getKnowledgeBaseById,
  KnowledgeBaseConflictError,
  KnowledgeBasePermissionError,
} from '@/lib/knowledge/service'
import type { ChunkingConfig, KnowledgeBaseWithCounts } from '@/lib/knowledge/types'
import { generateKnowledgeBaseFileKey } from '@/lib/uploads/contexts/knowledge-base/file-manager'
import { downloadFile, uploadFile } from '@/lib/uploads/core/storage-service'
import { MAX_FILE_SIZE } from '@/lib/uploads/utils/validation'
import { getUserEntityPermissions } from '@/lib/workspaces/permissions/utils'

const logger = createLogger('KnowledgeBaseCopy')

const CONTENT_PAGE = 50
const DOCUMENT_COPY_CONCURRENCY = 4

export class KnowledgeBaseCopyError extends Error {
  readonly code = 'KNOWLEDGE_BASE_COPY_FAILED' as const
}

interface CopyKnowledgeBaseParams {
  sourceKnowledgeBaseId: string
  targetWorkspaceId: string
  name?: string
  userId: string
  requestId: string
}

/**
 * Copies a knowledge base into another workspace: metadata, tag definitions,
 * live documents (with re-keyed blobs), and embeddings. Connectors are not copied.
 */
export async function copyKnowledgeBaseToWorkspace(
  params: CopyKnowledgeBaseParams
): Promise<KnowledgeBaseWithCounts> {
  const { sourceKnowledgeBaseId, targetWorkspaceId, userId, requestId } = params

  const targetPermission = await getUserEntityPermissions(userId, 'workspace', targetWorkspaceId)
  if (targetPermission !== 'admin' && targetPermission !== 'write') {
    throw new KnowledgeBasePermissionError(
      'User does not have permission to create knowledge bases in the target workspace'
    )
  }

  const [source] = await db
    .select()
    .from(knowledgeBase)
    .where(and(eq(knowledgeBase.id, sourceKnowledgeBaseId), isNull(knowledgeBase.deletedAt)))
    .limit(1)

  if (!source) {
    throw new KnowledgeBaseCopyError('Knowledge base not found')
  }

  if (source.workspaceId === targetWorkspaceId) {
    throw new KnowledgeBaseCopyError('Cannot copy a knowledge base into the same workspace')
  }

  const desiredName = (params.name?.trim() || source.name).slice(0, 100)
  const uniqueName = await resolveUniqueKnowledgeBaseName(targetWorkspaceId, desiredName)

  const now = new Date()
  const childKbId = generateId()

  try {
    await db.insert(knowledgeBase).values({
      id: childKbId,
      userId,
      workspaceId: targetWorkspaceId,
      name: uniqueName,
      description: source.description,
      tokenCount: 0,
      embeddingModel: source.embeddingModel,
      embeddingDimension: source.embeddingDimension,
      chunkingConfig: source.chunkingConfig,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })
  } catch (error: unknown) {
    if (getPostgresErrorCode(error) === '23505') {
      throw new KnowledgeBaseConflictError(uniqueName)
    }
    throw error
  }

  try {
    const tagDefinitions = await db
      .select()
      .from(knowledgeBaseTagDefinitions)
      .where(eq(knowledgeBaseTagDefinitions.knowledgeBaseId, sourceKnowledgeBaseId))

    if (tagDefinitions.length > 0) {
      await db.insert(knowledgeBaseTagDefinitions).values(
        tagDefinitions.map((definition) => ({
          ...definition,
          id: generateId(),
          knowledgeBaseId: childKbId,
        }))
      )
    }

    let afterDocId: string | null = null
    for (;;) {
      const liveDocs = and(
        eq(document.knowledgeBaseId, sourceKnowledgeBaseId),
        isNull(document.deletedAt),
        isNull(document.archivedAt)
      )
      const where: SQL<unknown> | undefined =
        afterDocId === null ? liveDocs : and(liveDocs, gt(document.id, afterDocId))

      const docs = await db
        .select()
        .from(document)
        .where(where)
        .orderBy(asc(document.id))
        .limit(CONTENT_PAGE)

      if (docs.length === 0) break

      const docErrors = await mapWithConcurrency(
        docs,
        DOCUMENT_COPY_CONCURRENCY,
        async (doc): Promise<unknown> => {
          try {
            const childDocId = generateId()
            const blob = await copyKbDocumentBlob(doc, targetWorkspaceId, userId, requestId)
            await db.insert(document).values({
              ...doc,
              id: childDocId,
              knowledgeBaseId: childKbId,
              connectorId: null,
              deletedAt: null,
              archivedAt: null,
              ...(blob ? { storageKey: blob.storageKey, fileUrl: blob.fileUrl } : {}),
            })
            await copyDocumentEmbeddings(doc.id, childDocId, childKbId)
            return null
          } catch (error) {
            return error
          }
        }
      )

      const docError = docErrors.find((error) => error != null)
      if (docError) throw docError

      afterDocId = docs[docs.length - 1].id
      if (docs.length < CONTENT_PAGE) break
    }

    await db
      .update(knowledgeBase)
      .set({
        tokenCount: source.tokenCount,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeBase.id, childKbId))

    const copied = await getKnowledgeBaseById(childKbId)
    if (!copied) {
      throw new KnowledgeBaseCopyError('Copied knowledge base could not be loaded')
    }

    logger.info(
      `[${requestId}] Copied knowledge base ${sourceKnowledgeBaseId} -> ${childKbId} in workspace ${targetWorkspaceId}`
    )

    return {
      ...copied,
      chunkingConfig: copied.chunkingConfig as ChunkingConfig,
    }
  } catch (error) {
    logger.error(`[${requestId}] Knowledge base copy failed; soft-deleting partial copy`, {
      childKbId,
      error: getErrorMessage(error),
    })
    try {
      await deleteKnowledgeBase(childKbId, requestId)
    } catch (cleanupError) {
      logger.error(`[${requestId}] Failed to clean up partial knowledge base copy`, {
        childKbId,
        error: getErrorMessage(cleanupError),
      })
    }
    throw error
  }
}

async function resolveUniqueKnowledgeBaseName(
  workspaceId: string,
  desiredName: string
): Promise<string> {
  if (!(await knowledgeBaseNameExists(workspaceId, desiredName))) {
    return desiredName
  }

  const copyName = `${desiredName} (copy)`.slice(0, 100)
  if (!(await knowledgeBaseNameExists(workspaceId, copyName))) {
    return copyName
  }

  for (let i = 2; i <= 50; i++) {
    const candidate = `${desiredName} (copy ${i})`.slice(0, 100)
    if (!(await knowledgeBaseNameExists(workspaceId, candidate))) {
      return candidate
    }
  }

  throw new KnowledgeBaseConflictError(desiredName)
}

async function knowledgeBaseNameExists(workspaceId: string, name: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: knowledgeBase.id })
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.workspaceId, workspaceId),
        eq(knowledgeBase.name, name),
        isNull(knowledgeBase.deletedAt)
      )
    )
    .limit(1)

  return Boolean(existing)
}

async function copyDocumentEmbeddings(
  sourceDocumentId: string,
  childDocumentId: string,
  childKnowledgeBaseId: string
): Promise<void> {
  let afterId: string | null = null
  for (;;) {
    const where: SQL<unknown> | undefined =
      afterId === null
        ? eq(embedding.documentId, sourceDocumentId)
        : and(eq(embedding.documentId, sourceDocumentId), gt(embedding.id, afterId))

    const rows = await db
      .select()
      .from(embedding)
      .where(where)
      .orderBy(asc(embedding.id))
      .limit(CONTENT_PAGE)

    if (rows.length === 0) break

    await db.insert(embedding).values(
      rows.map((row) => {
        const { contentTsv: _contentTsv, ...rest } = row
        return {
          ...rest,
          id: generateId(),
          documentId: childDocumentId,
          knowledgeBaseId: childKnowledgeBaseId,
        }
      })
    )

    afterId = rows[rows.length - 1].id
    if (rows.length < CONTENT_PAGE) break
  }
}

async function copyKbDocumentBlob(
  doc: { storageKey: string | null; filename: string; mimeType: string },
  childWorkspaceId: string,
  userId: string,
  requestId: string
): Promise<{ storageKey: string; fileUrl: string } | null> {
  if (!doc.storageKey) return null

  try {
    const buffer = await downloadFile({
      key: doc.storageKey,
      context: 'knowledge-base',
      maxBytes: MAX_FILE_SIZE,
    })
    const targetKey = generateKnowledgeBaseFileKey(doc.filename)
    await uploadFile({
      file: buffer,
      fileName: doc.filename,
      contentType: doc.mimeType,
      context: 'knowledge-base',
      customKey: targetKey,
      preserveKey: true,
      metadata: {
        userId,
        workspaceId: childWorkspaceId,
        originalName: doc.filename,
      },
    })
    return { storageKey: targetKey, fileUrl: `/api/files/serve/${encodeURIComponent(targetKey)}` }
  } catch (error) {
    logger.warn(`[${requestId}] Failed to copy KB document blob; keeping source key`, {
      sourceStorageKey: doc.storageKey,
      error: getErrorMessage(error),
    })
    return null
  }
}
