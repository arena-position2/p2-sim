import { db } from '@sim/db'
import { knowledgeBase, userTableDefinitions } from '@sim/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { canonicalWorkspaceFilePath } from '@/lib/mothership/vfs/path-utils'
import { listWorkspaceFiles } from '@/lib/uploads/contexts/workspace'

/**
 * Row caps for context summaries — these feed the system prompt on every
 * model round, so they must stay bounded regardless of workspace size.
 */
const MAX_CONTEXT_KNOWLEDGE_BASES = 100
const MAX_CONTEXT_TABLES = 100
const MAX_CONTEXT_FILES = 100

export interface WorkspaceKnowledgeBaseSummary {
  id: string
  name: string
  description?: string | null
}

export interface WorkspaceTableSummary {
  id: string
  name: string
  description?: string | null
}

export interface WorkspaceFileSummary {
  id: string
  name: string
  path: string
  type: string
  size: number
}

export interface WorkspaceResourceSummaries {
  knowledgeBases: WorkspaceKnowledgeBaseSummary[]
  tables: WorkspaceTableSummary[]
  workspaceFiles: WorkspaceFileSummary[]
}

/**
 * Loads workspace files, tables, and knowledge bases for Arena Copilot context.
 */
export async function loadWorkspaceResourceSummaries(
  workspaceId: string
): Promise<WorkspaceResourceSummaries> {
  const [kbs, tables, files] = await Promise.all([
    db
      .select({
        id: knowledgeBase.id,
        name: knowledgeBase.name,
        description: knowledgeBase.description,
      })
      .from(knowledgeBase)
      .where(and(eq(knowledgeBase.workspaceId, workspaceId), isNull(knowledgeBase.deletedAt)))
      .limit(MAX_CONTEXT_KNOWLEDGE_BASES),

    db
      .select({
        id: userTableDefinitions.id,
        name: userTableDefinitions.name,
        description: userTableDefinitions.description,
      })
      .from(userTableDefinitions)
      .where(
        and(
          eq(userTableDefinitions.workspaceId, workspaceId),
          isNull(userTableDefinitions.archivedAt)
        )
      )
      .limit(MAX_CONTEXT_TABLES),

    listWorkspaceFiles(workspaceId, { limit: MAX_CONTEXT_FILES }),
  ])

  return {
    knowledgeBases: kbs.map((kb) => ({
      id: kb.id,
      name: kb.name,
      description: kb.description,
    })),
    tables: tables.map((table) => ({
      id: table.id,
      name: table.name,
      description: table.description,
    })),
    workspaceFiles: files.map((file) => ({
      id: file.id,
      name: file.name,
      path: canonicalWorkspaceFilePath({ folderPath: file.folderPath, name: file.name }),
      type: file.type,
      size: file.size,
    })),
  }
}
