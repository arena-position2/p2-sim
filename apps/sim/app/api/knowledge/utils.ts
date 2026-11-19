import { db } from '@sim/db'
import { knowledgeBase, workspace } from '@sim/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { getUserEntityPermissions } from '@/lib/workspaces/permissions/utils'

interface KnowledgeBaseData {
  id: string
  userId: string
  workspaceId?: string | null
  name: string
  isSearchIndex: boolean
  description?: string | null
  tokenCount: number
  embeddingModel: string
  embeddingDimension: number
  chunkingConfig: unknown
  deletedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface KnowledgeBaseAccessResult {
  hasAccess: true
  knowledgeBase: Pick<
    KnowledgeBaseData,
    | 'id'
    | 'userId'
    | 'workspaceId'
    | 'name'
    | 'isSearchIndex'
    | 'embeddingModel'
    | 'embeddingDimension'
  >
}

interface KnowledgeBaseAccessDenied {
  hasAccess: false
  notFound?: boolean
  reason?: string
}

export type KnowledgeBaseAccessCheck = KnowledgeBaseAccessResult | KnowledgeBaseAccessDenied

/**
 * Resolve knowledge-base access for a user, gated by read or write permission.
 *
 * Read (`requireWrite: false`) grants on any workspace permission; write
 * (`requireWrite: true`) requires `write`/`admin`. Legacy non-workspace KBs grant
 * to the owning user in both modes.
 */
async function resolveKnowledgeBaseAccess(
  knowledgeBaseId: string,
  userId: string,
  requireWrite: boolean
): Promise<KnowledgeBaseAccessCheck> {
  const kb = await db
    .select({
      id: knowledgeBase.id,
      userId: knowledgeBase.userId,
      workspaceId: knowledgeBase.workspaceId,
      name: knowledgeBase.name,
      isSearchIndex: knowledgeBase.isSearchIndex,
      embeddingModel: knowledgeBase.embeddingModel,
      embeddingDimension: knowledgeBase.embeddingDimension,
    })
    .from(knowledgeBase)
    .where(and(eq(knowledgeBase.id, knowledgeBaseId), isNull(knowledgeBase.deletedAt)))
    .limit(1)

  if (kb.length === 0) {
    return { hasAccess: false, notFound: true }
  }

  const kbData = kb[0]

  // Case 1: Knowledge base belongs to a workspace - check workspace access
  if (kbData.workspaceId) {
    // Check if user is workspace owner (owners have full access to all KBs in workspace)
    const workspaceData = await db
      .select({ ownerId: workspace.ownerId })
      .from(workspace)
      .where(eq(workspace.id, kbData.workspaceId))
      .limit(1)

    if (workspaceData.length > 0 && workspaceData[0].ownerId === userId) {
      return { hasAccess: true, knowledgeBase: kbData }
    }

    // Check if user has permissions
    const userPermission = await getUserEntityPermissions(userId, 'workspace', kbData.workspaceId)
    const permitted = requireWrite
      ? userPermission === 'write' || userPermission === 'admin'
      : userPermission !== null
    return permitted ? { hasAccess: true, knowledgeBase: kbData } : { hasAccess: false }
  }

  // Legacy non-workspace KB: allow owner access (KBs created before workspace feature)
  if (kbData.userId === userId) {
    return { hasAccess: true, knowledgeBase: kbData }
  }

  return { hasAccess: false }
}

/**
 * Check if a user has read access to a knowledge base.
 */
export async function checkKnowledgeBaseAccess(
  knowledgeBaseId: string,
  userId: string
): Promise<KnowledgeBaseAccessCheck> {
  return resolveKnowledgeBaseAccess(knowledgeBaseId, userId, false)
}

/** Write access: workspace write/admin, or ownership of a legacy knowledge base with no workspace. */
export async function checkKnowledgeBaseWriteAccess(
  knowledgeBaseId: string,
  userId: string
): Promise<KnowledgeBaseAccessCheck> {
  return resolveKnowledgeBaseAccess(knowledgeBaseId, userId, true)
}
