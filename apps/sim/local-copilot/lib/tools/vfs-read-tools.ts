import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { executeCopilotFileUseCase } from '@/lib/mothership/application/execute-file-use-case'
import { TOOL_RESULT_MAX_INLINE_CHARS } from '@/lib/mothership/constants'
import { listChatUploads } from '@/lib/mothership/tools/handlers/upload-file-reader'
import {
  type GrepOptions,
  grepReadResult,
  glob as matchVfsGlob,
  grep as matchVfsGrep,
  WorkspaceFileGrepError,
} from '@/lib/mothership/vfs/operations'
import { canonicalWorkspaceFilePath } from '@/lib/mothership/vfs/path-utils'
import { encodeVfsSegment } from '@/lib/vfs/path'
import { listAllWorkspaceFiles } from '@/lib/workspace-files/application/list-workspace-files'
import { readWorkspaceFileText } from '@/lib/workspace-files/application/read-workspace-file-text'
import { clampReadResultForLocalModel } from '@/local-copilot/lib/tools/clamp-read-result'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotVfsReadTools')

/** Cap files opened for an unscoped / folder-scoped grep this turn. */
const MAX_GREP_FILES = 40
/** Soft cap when reading text for grep so one huge HTML file cannot stall the turn. */
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024
/** Soft cap for a full workspace-file read (same order as Cloud vfs_read text path). */
const MAX_TEXT_READ_BYTES = 20 * 1024 * 1024

export const LOCAL_VFS_TOOL_NAMES = ['glob', 'grep', 'read'] as const
export type LocalVfsToolName = (typeof LOCAL_VFS_TOOL_NAMES)[number]

export function isLocalVfsToolName(toolName: string): toolName is LocalVfsToolName {
  return (LOCAL_VFS_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface LocalVfsToolResult {
  success: boolean
  output?: unknown
  error?: string
}

/**
 * Arena Local Copilot implementations of Cloud `glob` / `grep` / `read`.
 *
 * Cloud deleted the full in-memory WorkspaceVFS materializer (moved to Go).
 * Arena keeps a files-/uploads-focused path under `local-copilot` so Sim merges
 * do not need to restore `lib/copilot/tools/handlers/vfs.ts`.
 */
export async function executeLocalVfsTool(
  toolName: LocalVfsToolName,
  rawParams: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalVfsToolResult> {
  if (!ctx.workspaceId) {
    return { success: false, error: 'No workspace context available' }
  }

  try {
    if (toolName === 'glob') return await executeLocalVfsGlob(rawParams, ctx)
    if (toolName === 'grep') return await executeLocalVfsGrep(rawParams, ctx)
    return await executeLocalVfsRead(rawParams, ctx)
  } catch (error) {
    logger.error(`local vfs_${toolName} failed`, {
      error: toError(error).message,
      workspaceId: ctx.workspaceId,
    })
    return { success: false, error: getErrorMessage(error, `vfs_${toolName} failed`) }
  }
}

async function executeLocalVfsGlob(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalVfsToolResult> {
  const pattern = stringArg(params, 'pattern')
  if (!pattern) {
    return { success: false, error: "Missing required parameter 'pattern'" }
  }

  if (isUnsupportedNamespacePattern(pattern)) {
    return {
      success: true,
      output: {
        files: [],
        note: unsupportedNamespaceNote(pattern),
      },
    }
  }

  const pathMap = await buildWorkspaceFilesPathMap(ctx)
  let files = matchVfsGlob(pathMap, pattern)

  if (ctx.chatId && (pattern === 'uploads/*' || pattern.startsWith('uploads/'))) {
    const uploads = await listChatUploads(ctx.chatId)
    const uploadPaths = uploads.map((file) => `uploads/${encodeUploadSegment(file.name)}`)
    files = [...new Set([...files, ...uploadPaths])].sort()
  }

  if (files.length === 0) {
    if (pattern.startsWith('uploads')) {
      return { success: true, output: { files, note: 'This chat has no uploads.' } }
    }
    return { success: true, output: { files } }
  }

  return { success: true, output: { files } }
}

async function executeLocalVfsGrep(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalVfsToolResult> {
  const pattern = stringArg(params, 'pattern')
  if (!pattern) {
    return { success: false, error: "Missing required parameter 'pattern'" }
  }

  const rawPath = stringArg(params, 'path')
  if (rawPath && isUnsupportedNamespacePath(rawPath)) {
    return { success: false, error: unsupportedNamespaceNote(rawPath) }
  }

  const outputMode = (stringArg(params, 'output_mode') ?? 'content') as GrepOptions['outputMode']
  const grepOptions: GrepOptions = {
    maxResults: numberArg(params, 'maxResults') ?? 50,
    outputMode,
    ignoreCase: booleanArg(params, 'ignoreCase') ?? false,
    lineNumbers: booleanArg(params, 'lineNumbers') ?? true,
    context: numberArg(params, 'context') ?? 0,
  }

  const key =
    outputMode === 'files_with_matches' ? 'files' : outputMode === 'count' ? 'counts' : 'matches'

  try {
    const pathMap = await buildWorkspaceFilesPathMap(ctx)
    const fileReference = rawPath ? stripContentSuffix(rawPath) : undefined
    const exactFileReference =
      fileReference &&
      (pathMap.has(fileReference) ||
        fileReference.startsWith('uploads/') ||
        looksLikeSingleFilePath(fileReference))
        ? fileReference
        : undefined

    let result: unknown

    if (exactFileReference) {
      const text = await readFileTextForGrep(ctx, exactFileReference)
      result = grepReadResult(
        exactFileReference,
        { content: text, totalLines: text.split('\n').length },
        pattern,
        exactFileReference,
        grepOptions
      )
    } else {
      const scopedPaths = matchVfsGlob(
        pathMap,
        rawPath ? `${rawPath.replace(/\/+$/, '')}/**` : 'files/**'
      ).slice(0, MAX_GREP_FILES)

      const contentMap = new Map<string, string>()
      for (const filePath of scopedPaths) {
        try {
          contentMap.set(filePath, await readFileTextForGrep(ctx, filePath))
        } catch (error) {
          logger.debug('Skipping unreadable file during local vfs_grep', {
            path: filePath,
            error: toError(error).message,
          })
        }
      }

      if (ctx.chatId && (!rawPath || rawPath === 'uploads' || rawPath.startsWith('uploads/'))) {
        const uploads = await listChatUploads(ctx.chatId)
        for (const upload of uploads.slice(0, MAX_GREP_FILES)) {
          const uploadPath = `uploads/${encodeUploadSegment(upload.name)}`
          if (
            rawPath &&
            rawPath !== 'uploads' &&
            rawPath !== 'uploads/' &&
            uploadPath !== stripContentSuffix(rawPath)
          ) {
            continue
          }
          try {
            contentMap.set(uploadPath, await readFileTextForGrep(ctx, uploadPath))
          } catch {
            // skip binary / unreadable uploads
          }
        }
      }

      result = matchVfsGrep(contentMap, pattern, undefined, grepOptions)
    }

    const output = { [key]: result }
    if (serializedResultSize(output) > TOOL_RESULT_MAX_INLINE_CHARS) {
      return {
        success: false,
        error:
          'Grep result too large to return inline. Retry grep with a more specific pattern or narrower path, and reduce context or maxResults.',
      }
    }

    return { success: true, output }
  } catch (error) {
    if (error instanceof WorkspaceFileGrepError) {
      return { success: false, error: error.message }
    }
    throw error
  }
}

async function executeLocalVfsRead(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<LocalVfsToolResult> {
  const path = stringArg(params, 'path')
  if (!path) {
    return { success: false, error: "Missing required parameter 'path'" }
  }

  if (isUnsupportedNamespacePath(path)) {
    return { success: false, error: unsupportedNamespaceNote(path) }
  }

  if (!path.startsWith('files/') && !path.startsWith('uploads/')) {
    return {
      success: false,
      error: `Arena Local Copilot read supports files/ and uploads/ paths. Got: ${path}`,
    }
  }

  if (path.startsWith('uploads/') && !ctx.chatId) {
    return { success: false, error: 'No chat context available for uploads/' }
  }

  const offset = numberArg(params, 'offset')
  const limit = numberArg(params, 'limit')
  const reference = stripContentSuffix(path)
  const delegation = toCopilotServerToolContext(ctx)

  const { text, truncated } = await executeCopilotFileUseCase(delegation, readWorkspaceFileText, {
    workspaceId: ctx.workspaceId,
    reference,
    chatId: ctx.chatId,
    allowPlainText: true,
    maxBytes: MAX_TEXT_READ_BYTES,
  })

  const raw = {
    content: text,
    totalLines: text.split('\n').length,
    ...(truncated ? { truncated: true as const } : {}),
  }
  const windowed = applyLineWindow(raw, offset, limit)
  const clamped = clampReadResultForLocalModel(windowed)

  if (serializedResultSize(clamped) > TOOL_RESULT_MAX_INLINE_CHARS) {
    return {
      success: false,
      error: `${path} is still too large over the requested window. Narrow offset/limit, or grep this file for the section you need.`,
    }
  }

  return { success: true, output: clamped }
}

async function buildWorkspaceFilesPathMap(ctx: ToolExecutionContext): Promise<Map<string, string>> {
  const delegation = toCopilotServerToolContext(ctx)
  const { files } = await executeCopilotFileUseCase(delegation, listAllWorkspaceFiles, {
    workspaceId: ctx.workspaceId,
    scope: 'active',
  })

  const map = new Map<string, string>()
  for (const file of files) {
    const path = canonicalWorkspaceFilePath({
      folderPath: file.folderPath ?? null,
      name: file.name,
    })
    map.set(path, '')
  }
  return map
}

async function readFileTextForGrep(ctx: ToolExecutionContext, reference: string): Promise<string> {
  const delegation = toCopilotServerToolContext(ctx)
  const { text } = await executeCopilotFileUseCase(delegation, readWorkspaceFileText, {
    workspaceId: ctx.workspaceId,
    reference,
    chatId: ctx.chatId,
    allowPlainText: true,
    maxBytes: MAX_GREP_FILE_BYTES,
  })
  return text
}

/** Heuristic: `files/<name>`, `files/<folder>/<name>`, or `uploads/<name>` (not a bare namespace). */
function looksLikeSingleFilePath(path: string): boolean {
  if (path.startsWith('uploads/')) {
    const rest = path.slice('uploads/'.length)
    return rest.length > 0 && !rest.includes('/')
  }
  if (!path.startsWith('files/')) return false
  const parts = path.split('/').filter(Boolean)
  // files/<leaf> or files/<folder>/.../<leaf> — require at least one name segment after files/
  return parts.length >= 2 && Boolean(parts[parts.length - 1]?.includes('.'))
}

function stripContentSuffix(path: string): string {
  return path.replace(/\/(?:content|style|compiled-check|compiled|render|extract)$/, '')
}

function isUnsupportedNamespacePattern(pattern: string): boolean {
  return /^(workflows|knowledgebases|tables|environment|internal|agent|docs|tests|changelog)(\/|$|\*)/.test(
    pattern
  )
}

function isUnsupportedNamespacePath(path: string): boolean {
  return /^(workflows|knowledgebases|tables|environment|internal|agent|docs|tests|changelog)(\/|$)/.test(
    path
  )
}

function unsupportedNamespaceNote(target: string): string {
  if (target.startsWith('agent')) {
    return 'Arena Local Copilot does not materialize agent/ VFS paths. Use manage_mcp_connection (operation "list") for MCP server configs.'
  }
  return `Arena Local Copilot VFS tools cover files/ and uploads/ only (got "${target}"). Use specialized tools for workflows, tables, knowledge bases, or docs.`
}

function encodeUploadSegment(name: string): string {
  try {
    return encodeVfsSegment(name)
  } catch {
    return name
  }
}

function applyLineWindow<T extends { content: string; totalLines: number }>(
  result: T,
  offset: number | undefined,
  limit: number | undefined
): T {
  if (offset === undefined && limit === undefined) return result
  const lines = result.content.split('\n')
  const start = Math.max(0, Math.min(lines.length, offset ?? 0))
  const endRaw = limit !== undefined ? start + Math.max(0, limit) : lines.length
  const end = Math.max(start, Math.min(lines.length, endRaw))
  return {
    ...result,
    content: lines.slice(start, end).join('\n'),
  }
}

function serializedResultSize(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function stringArg(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function numberArg(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function booleanArg(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}
