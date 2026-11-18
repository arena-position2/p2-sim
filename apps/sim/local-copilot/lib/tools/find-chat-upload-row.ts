import { db } from '@sim/db'
import { type WorkspaceFileRow, workspaceFiles } from '@sim/db/schema'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { decodeVfsSegmentSafe, encodeVfsSegment } from '@/lib/vfs/path'

/**
 * Canonical comparison key for an upload's VFS name. Accepts both the raw display
 * name and a percent-encoded segment so either spelling resolves the same row.
 */
function canonicalUploadKey(name: string): string {
  const decoded = decodeVfsSegmentSafe(name)
  try {
    return encodeVfsSegment(decoded)
  } catch {
    return name.trim()
  }
}

function vfsName(row: WorkspaceFileRow): string {
  return row.displayName ?? row.originalName
}

/**
 * Resolve a chat upload row by VFS name for Local `materialize_file`.
 *
 * Kept under local-copilot (instead of exporting the mothership upload-file-reader
 * helper) so Sim merges do not need to touch that shared module.
 */
export async function findChatUploadRowByName(
  chatId: string,
  fileName: string
): Promise<WorkspaceFileRow | null> {
  const exactRows = await db
    .select()
    .from(workspaceFiles)
    .where(
      and(
        eq(workspaceFiles.chatId, chatId),
        eq(workspaceFiles.context, 'mothership'),
        or(
          eq(workspaceFiles.displayName, fileName),
          and(isNull(workspaceFiles.displayName), eq(workspaceFiles.originalName, fileName))
        ),
        isNull(workspaceFiles.deletedAt)
      )
    )
    .orderBy(desc(workspaceFiles.uploadedAt), desc(workspaceFiles.id))
    .limit(1)

  if (exactRows[0]) {
    return exactRows[0]
  }

  const allRows = await db
    .select()
    .from(workspaceFiles)
    .where(
      and(
        eq(workspaceFiles.chatId, chatId),
        eq(workspaceFiles.context, 'mothership'),
        isNull(workspaceFiles.deletedAt)
      )
    )
    .orderBy(desc(workspaceFiles.uploadedAt), desc(workspaceFiles.id))

  const segmentKey = canonicalUploadKey(fileName)
  return allRows.find((row) => canonicalUploadKey(vfsName(row)) === segmentKey) ?? null
}
