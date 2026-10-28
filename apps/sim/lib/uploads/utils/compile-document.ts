import { sha256Hex } from '@sim/security/hash'
import { runSandboxTask } from '@/lib/execution/sandbox/run-task'
import { loadCompiledDocByExt } from '@/lib/mothership/tools/server/files/doc-compile'
import { parseWorkspaceFileKey } from '@/lib/uploads/contexts/workspace/workspace-file-manager'
import { getContentType } from '@/app/api/files/utils'
import type { SandboxTaskId } from '@/sandbox-tasks/registry'

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d])

interface CompilableFormat {
  magic: Buffer
  taskId: SandboxTaskId
  contentType: string
}

const COMPILABLE_FORMATS: Record<string, CompilableFormat> = {
  '.pptx': {
    magic: ZIP_MAGIC,
    taskId: 'pptx-generate',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  '.docx': {
    magic: ZIP_MAGIC,
    taskId: 'docx-generate',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  '.pdf': {
    magic: PDF_MAGIC,
    taskId: 'pdf-generate',
    contentType: 'application/pdf',
  },
}

const MAX_COMPILED_DOC_CACHE = 10
const compiledDocCache = new Map<string, Buffer>()

function compiledCacheSet(key: string, buffer: Buffer): void {
  if (compiledDocCache.size >= MAX_COMPILED_DOC_CACHE) {
    compiledDocCache.delete(compiledDocCache.keys().next().value as string)
  }
  compiledDocCache.set(key, buffer)
}

/**
 * Compiles workspace document source (docx-js, pptx-js, etc.) into binary output when needed.
 * Skips compilation when `raw` is true or the buffer already has the expected magic bytes.
 */
export async function compileDocumentIfNeeded(
  buffer: Buffer,
  filename: string,
  workspaceId: string | undefined,
  raw: boolean,
  ownerKey: string | undefined,
  signal: AbortSignal | undefined
): Promise<{ buffer: Buffer; contentType: string }> {
  if (raw) return { buffer, contentType: getContentType(filename) }

  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  const format = COMPILABLE_FORMATS[ext]
  if (!format) return { buffer, contentType: getContentType(filename) }

  const magicLen = format.magic.length
  if (buffer.length >= magicLen && buffer.subarray(0, magicLen).equals(format.magic)) {
    return { buffer, contentType: getContentType(filename) }
  }

  const code = buffer.toString('utf-8')
  const extNoDot = ext.replace(/^\./, '')

  // Prefer the write-time content-addressed artifact (same as /api/files/serve).
  if (workspaceId) {
    const stored = await loadCompiledDocByExt(workspaceId, code, extNoDot)
    if (stored && stored.buffer.length > 0) {
      return { buffer: stored.buffer, contentType: stored.contentType }
    }
  }

  const cacheKey = sha256Hex(`${ext}${code}${workspaceId ?? ''}`)
  const cached = compiledDocCache.get(cacheKey)
  if (cached && cached.length > 0) {
    return { buffer: cached, contentType: format.contentType }
  }

  const compiled = await runSandboxTask(
    format.taskId,
    { code, workspaceId: workspaceId || '' },
    { ownerKey, signal }
  )
  if (!Buffer.isBuffer(compiled) || compiled.length === 0) {
    throw new Error(`Document compilation produced an empty ${extNoDot.toUpperCase()} file`)
  }
  compiledCacheSet(cacheKey, compiled)
  return { buffer: compiled, contentType: format.contentType }
}

/**
 * Resolves workspace ID from a storage key for document compilation.
 */
export function getWorkspaceIdForCompile(key: string): string | undefined {
  return parseWorkspaceFileKey(key) ?? undefined
}
