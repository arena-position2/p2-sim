/**
 * Arena Local Copilot implementations of workspace file/folder leaf tools
 * (`list_file_folders`, `create_file_folder`, rename/move/delete file + folder).
 *
 * Cloud deleted the mothership TS handlers (moved to Go). Arena keeps a
 * files/-focused path under `local-copilot` so Sim merges do not need to restore
 * those handlers — same pattern as `vfs-read-tools`.
 */
import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { buildFolderPath, parseFolderPath, ROOT_FOLDER_PATH } from '@/lib/folders/paths'
import {
  executeCopilotFileUseCase,
  resolveCopilotWorkspaceFileReference,
} from '@/lib/mothership/application/execute-file-use-case'
import { canonicalWorkspaceFilePath } from '@/lib/mothership/vfs/path-utils'
import { decodeVfsPathSegments } from '@/lib/vfs/path'
import { deleteWorkspaceFileOperation } from '@/lib/workspace-files/application/delete-workspace-file'
import { moveWorkspaceFileItemsOperation } from '@/lib/workspace-files/application/move-workspace-file-items'
import { fileOperations } from '@/lib/workspace-files/application/operations'
import { renameWorkspaceFile } from '@/lib/workspace-files/application/rename-workspace-file'
import {
  createWorkspaceFileFolderOperation,
  deleteWorkspaceFileFolderOperation,
  listWorkspaceFileFoldersOperation,
  updateWorkspaceFileFolderOperation,
} from '@/lib/workspace-files/application/workspace-file-folders'
import { toWorkspaceFileFolderPathView } from '@/lib/workspace-files/folder-display-path'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotVfsFileFolderTools')

export const LOCAL_FILE_FOLDER_TOOL_NAMES = [
  'list_file_folders',
  'create_file_folder',
  'rename_file_folder',
  'move_file_folder',
  'delete_file_folder',
  'rename_file',
  'move_file',
  'delete_file',
] as const

export type LocalFileFolderToolName = (typeof LOCAL_FILE_FOLDER_TOOL_NAMES)[number]

export function isLocalFileFolderToolName(toolName: string): toolName is LocalFileFolderToolName {
  return (LOCAL_FILE_FOLDER_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface LocalFileFolderToolResult {
  success: boolean
  output?: unknown
  error?: string
}

/**
 * Executes one Arena-local file/folder leaf tool.
 */
export async function executeLocalFileFolderTool(
  toolName: LocalFileFolderToolName,
  rawParams: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  if (!ctx.workspaceId) {
    return { success: false, error: 'No workspace context available' }
  }

  try {
    switch (toolName) {
      case 'list_file_folders':
        return await executeListFileFolders(rawParams, ctx)
      case 'create_file_folder':
        return await executeCreateFileFolder(rawParams, ctx)
      case 'rename_file_folder':
        return await executeRenameFileFolder(rawParams, ctx)
      case 'move_file_folder':
        return await executeMoveFileFolder(rawParams, ctx)
      case 'delete_file_folder':
        return await executeDeleteFileFolder(rawParams, ctx)
      case 'rename_file':
        return await executeRenameFile(rawParams, ctx)
      case 'move_file':
        return await executeMoveFile(rawParams, ctx)
      case 'delete_file':
        return await executeDeleteFile(rawParams, ctx)
    }
  } catch (error) {
    logger.error(`local ${toolName} failed`, {
      error: toError(error).message,
      workspaceId: ctx.workspaceId,
    })
    return { success: false, error: orchestrationOrGenericMessage(error, `${toolName} failed`) }
  }
}

async function executeListFileFolders(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  const parentPathRaw = stringArg(params, 'parentPath') ?? stringArg(params, 'path')
  const parentPath = parentPathRaw ? toCanonicalFolderPath(parentPathRaw) : undefined
  const recursive = booleanArg(params, 'recursive') ?? false
  const search = stringArg(params, 'search')

  const delegation = toCopilotServerToolContext(ctx)
  const { folders } = await executeCopilotFileUseCase(
    delegation,
    listWorkspaceFileFoldersOperation,
    {
      workspaceId: ctx.workspaceId,
      scope: 'active',
      ...(parentPath !== undefined ? { parentPath } : {}),
      ...(search ? { search } : {}),
      recursive,
    }
  )

  const projected = folders.map((folder) => {
    try {
      const view = toWorkspaceFileFolderPathView(folder)
      return {
        id: folder.id,
        name: folder.name,
        path: vfsFolderPathFromCanonical(view.path),
        parentPath:
          view.parentPath === ROOT_FOLDER_PATH
            ? 'files'
            : vfsFolderPathFromCanonical(view.parentPath),
      }
    } catch {
      const fallback = folder.path?.startsWith('/')
        ? vfsFolderPathFromCanonical(folder.path)
        : `files/${folder.path}`
      return {
        id: folder.id,
        name: folder.name,
        path: fallback,
        parentPath: 'files',
      }
    }
  })

  return {
    success: true,
    output: {
      success: true,
      data: { folders: projected },
      message:
        projected.length === 0
          ? 'No folders yet.'
          : `Listed ${projected.length} folder${projected.length === 1 ? '' : 's'}.`,
    },
  }
}

async function executeCreateFileFolder(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  const pathRaw = stringArg(params, 'path')
  const name = stringArg(params, 'name')
  const parentPathRaw = stringArg(params, 'parentPath')

  let createPath: string | undefined
  if (pathRaw) {
    createPath = toCanonicalFolderPath(pathRaw)
    if (createPath === ROOT_FOLDER_PATH) {
      return { success: false, error: 'Cannot create the workspace files root as a folder' }
    }
  } else if (name) {
    const parentCanonical = parentPathRaw ? toCanonicalFolderPath(parentPathRaw) : ROOT_FOLDER_PATH
    const parentSegments =
      parentCanonical === ROOT_FOLDER_PATH ? [] : parseFolderPath(parentCanonical)
    createPath = buildFolderPath([...parentSegments, name])
  } else {
    return {
      success: false,
      error: 'Provide path (e.g. "files/Reports") or name (optional parentPath).',
    }
  }

  const delegation = toCopilotServerToolContext(ctx)
  const { folder } = await executeCopilotFileUseCase(
    delegation,
    createWorkspaceFileFolderOperation,
    {
      workspaceId: ctx.workspaceId,
      path: createPath,
    }
  )

  const folderWithPath = {
    ...folder,
    path:
      typeof (folder as { path?: unknown }).path === 'string'
        ? (folder as { path: string }).path
        : createPath,
  }
  const view = toWorkspaceFileFolderPathView(folderWithPath)
  const vfsPath = vfsFolderPathFromCanonical(view.path)
  return {
    success: true,
    output: {
      success: true,
      data: {
        id: folder.id,
        name: folder.name,
        path: vfsPath,
        vfsPath,
      },
      message: `Created folder at ${vfsPath}.`,
    },
  }
}

async function executeRenameFileFolder(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  const pathRaw = stringArg(params, 'path')
  const name = stringArg(params, 'name') ?? stringArg(params, 'newName')
  if (!pathRaw || !name) {
    return { success: false, error: 'REQUIRED: path and name (new folder name).' }
  }

  const sourceCanonical = toCanonicalFolderPath(pathRaw)
  if (sourceCanonical === ROOT_FOLDER_PATH) {
    return { success: false, error: 'Cannot rename the workspace files root' }
  }

  const segments = parseFolderPath(sourceCanonical)
  const destinationCanonical = buildFolderPath([...segments.slice(0, -1), name])

  const delegation = toCopilotServerToolContext(ctx)
  const { folder } = await executeCopilotFileUseCase(
    delegation,
    updateWorkspaceFileFolderOperation,
    {
      workspaceId: ctx.workspaceId,
      path: sourceCanonical,
      destinationPath: destinationCanonical,
    }
  )

  const vfsPath = vfsFolderPathFromCanonical(destinationCanonical)
  return {
    success: true,
    output: {
      success: true,
      data: { id: folder.id, name: folder.name, path: vfsPath, vfsPath },
      message: `Renamed folder to ${vfsPath}.`,
    },
  }
}

async function executeMoveFileFolder(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  const pathRaw = stringArg(params, 'path')
  if (!pathRaw) {
    return {
      success: false,
      error: 'REQUIRED: path. Omit destinationPath (or pass "files") for root.',
    }
  }

  const sourceCanonical = toCanonicalFolderPath(pathRaw)
  if (sourceCanonical === ROOT_FOLDER_PATH) {
    return { success: false, error: 'Cannot move the workspace files root' }
  }

  const destinationRaw = stringArg(params, 'destinationPath') ?? 'files'
  const destinationCanonical = toCanonicalFolderPath(destinationRaw)

  const delegation = toCopilotServerToolContext(ctx)
  const { folder } = await executeCopilotFileUseCase(
    delegation,
    updateWorkspaceFileFolderOperation,
    {
      workspaceId: ctx.workspaceId,
      path: sourceCanonical,
      destinationPath: destinationCanonical,
    }
  )

  const view = toWorkspaceFileFolderPathView(folder)
  const vfsPath = vfsFolderPathFromCanonical(view.path)
  return {
    success: true,
    output: {
      success: true,
      data: { id: folder.id, name: folder.name, path: vfsPath, vfsPath },
      message: `Moved folder to ${vfsPath}.`,
    },
  }
}

async function executeDeleteFileFolder(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  const paths = stringArrayArg(params, 'paths')
  const single = stringArg(params, 'path')
  const targets = paths.length > 0 ? paths : single ? [single] : []
  if (targets.length === 0) {
    return { success: false, error: 'REQUIRED: paths (array) or path.' }
  }

  const recursive = booleanArg(params, 'recursive') ?? true
  const delegation = toCopilotServerToolContext(ctx)
  const deleted: string[] = []

  for (const target of targets) {
    const canonical = toCanonicalFolderPath(target)
    if (canonical === ROOT_FOLDER_PATH) {
      return { success: false, error: 'Cannot delete the workspace files root' }
    }
    await executeCopilotFileUseCase(delegation, deleteWorkspaceFileFolderOperation, {
      workspaceId: ctx.workspaceId,
      path: canonical,
      recursive,
    })
    deleted.push(vfsFolderPathFromCanonical(canonical))
  }

  return {
    success: true,
    output: {
      success: true,
      data: { deleted },
      message: `Deleted ${deleted.length} folder${deleted.length === 1 ? '' : 's'}.`,
    },
  }
}

async function executeRenameFile(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  const path = stringArg(params, 'path')
  const newName = stringArg(params, 'newName') ?? stringArg(params, 'name')
  if (!path || !newName) {
    return { success: false, error: 'REQUIRED: path and newName (including extension).' }
  }
  if (!path.startsWith('files/')) {
    return { success: false, error: 'rename_file only supports files/ paths (not uploads/).' }
  }

  const delegation = toCopilotServerToolContext(ctx)
  const file = await resolveCopilotWorkspaceFileReference(delegation, fileOperations.rename, {
    workspaceId: ctx.workspaceId,
    reference: path,
  })

  const { file: renamed } = await executeCopilotFileUseCase(
    delegation,
    renameWorkspaceFile,
    {
      fileId: file.id,
      assertedWorkspaceId: ctx.workspaceId,
      name: newName,
    },
    { fileId: file.id }
  )

  const vfsPath = canonicalWorkspaceFilePath({
    folderPath: renamed.folderPath ?? null,
    name: renamed.name,
  })
  return {
    success: true,
    output: {
      success: true,
      data: { id: renamed.id, name: renamed.name, path: vfsPath, vfsPath },
      message: `Renamed file to ${vfsPath}.`,
    },
  }
}

async function executeMoveFile(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  const paths = stringArrayArg(params, 'paths')
  const single = stringArg(params, 'path')
  const targets = paths.length > 0 ? paths : single ? [single] : []
  if (targets.length === 0) {
    return {
      success: false,
      error: 'REQUIRED: paths (array). Omit destinationPath (or pass "files") for root.',
    }
  }

  const destinationRaw = stringArg(params, 'destinationPath') ?? 'files'
  const destinationCanonical = toCanonicalFolderPath(destinationRaw)

  const delegation = toCopilotServerToolContext(ctx)
  const fileIds: string[] = []
  for (const target of targets) {
    if (!target.startsWith('files/')) {
      return { success: false, error: `move_file only supports files/ paths (got "${target}").` }
    }
    const file = await resolveCopilotWorkspaceFileReference(delegation, fileOperations.move, {
      workspaceId: ctx.workspaceId,
      reference: target,
    })
    fileIds.push(file.id)
  }

  const result = await executeCopilotFileUseCase(delegation, moveWorkspaceFileItemsOperation, {
    workspaceId: ctx.workspaceId,
    fileIds,
    targetFolderPath: destinationCanonical,
  })

  return {
    success: true,
    output: {
      success: true,
      data: {
        movedItems: result.movedItems,
        destinationPath:
          destinationCanonical === ROOT_FOLDER_PATH
            ? 'files'
            : vfsFolderPathFromCanonical(destinationCanonical),
      },
      message: `Moved ${result.movedItems.files} file${result.movedItems.files === 1 ? '' : 's'}.`,
    },
  }
}

async function executeDeleteFile(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalFileFolderToolResult> {
  const paths = stringArrayArg(params, 'paths')
  const single = stringArg(params, 'path')
  const targets = paths.length > 0 ? paths : single ? [single] : []
  if (targets.length === 0) {
    return { success: false, error: 'REQUIRED: paths (array).' }
  }

  const delegation = toCopilotServerToolContext(ctx)
  const deleted: string[] = []

  for (const target of targets) {
    if (!target.startsWith('files/')) {
      return { success: false, error: `delete_file only supports files/ paths (got "${target}").` }
    }
    const file = await resolveCopilotWorkspaceFileReference(delegation, fileOperations.delete, {
      workspaceId: ctx.workspaceId,
      reference: target,
    })
    await executeCopilotFileUseCase(
      delegation,
      deleteWorkspaceFileOperation,
      { fileId: file.id, assertedWorkspaceId: ctx.workspaceId },
      { fileId: file.id }
    )
    deleted.push(target)
  }

  return {
    success: true,
    output: {
      success: true,
      data: { deleted },
      message: `Deleted ${deleted.length} file${deleted.length === 1 ? '' : 's'}.`,
    },
  }
}

/**
 * Converts a model-facing VFS folder path (`files/Reports`, `files`, `/Reports`)
 * into the canonical folder path the workspace-file-folder ops expect (`/Reports`, `/`).
 */
export function toCanonicalFolderPath(raw: string): string {
  let trimmed = raw.trim().replace(/\\/g, '/')
  while (trimmed.startsWith('./')) trimmed = trimmed.slice(2)
  trimmed = trimmed.replace(/\/{2,}/g, '/')
  if (trimmed.endsWith('/') && trimmed.length > 1) trimmed = trimmed.slice(0, -1)

  if (!trimmed || trimmed === 'files' || trimmed === 'files/') {
    return ROOT_FOLDER_PATH
  }

  if (trimmed.startsWith('files/')) {
    const rest = trimmed.slice('files/'.length)
    if (!rest) return ROOT_FOLDER_PATH
    const segments = decodeVfsPathSegments(rest)
    return buildFolderPath(segments)
  }

  if (trimmed === ROOT_FOLDER_PATH || trimmed.startsWith('/')) {
    // Already canonical (or root). Validate via buildFolderPath round-trip when non-root.
    if (trimmed === ROOT_FOLDER_PATH) return ROOT_FOLDER_PATH
    const segments = decodeVfsPathSegments(trimmed.slice(1))
    return buildFolderPath(segments)
  }

  const segments = decodeVfsPathSegments(trimmed)
  return buildFolderPath(segments)
}

/** Model-facing VFS folder path from a canonical `/Reports/Q3` path. */
export function vfsFolderPathFromCanonical(canonical: string): string {
  if (canonical === ROOT_FOLDER_PATH) return 'files'
  const withoutSlash = canonical.startsWith('/') ? canonical.slice(1) : canonical
  return `files/${withoutSlash}`
}

function orchestrationOrGenericMessage(error: unknown, fallback: string): string {
  if (error instanceof OrchestrationError) return error.message
  return getErrorMessage(error, fallback)
}

function stringArg(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function stringArrayArg(params: Record<string, unknown>, key: string): string[] {
  const value = params[key]
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function booleanArg(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}
