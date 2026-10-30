import { createLogger } from '@sim/logger'
import { isPayloadSizeLimitError } from '@/lib/core/utils/stream-limits'
import { processExecutionFiles } from '@/lib/execution/files'
import { uploadExecutionFile } from '@/lib/uploads/contexts/execution/file-manager'
import { downloadFile } from '@/lib/uploads/core/storage-service'
import type { StorageContext } from '@/lib/uploads/shared/types'
import { isInternalFileUrl, parseInternalFileUrl } from '@/lib/uploads/utils/file'
import type { UserFile } from '@/executor/types'

const logger = createLogger('ChatFileManager')

/** Same ceiling as execution-file uploads. A reused image is copied into the run, so it must fit. */
const MAX_REUSED_IMAGE_BYTES = 20 * 1024 * 1024

export interface ChatFile {
  data?: string // Legacy field - base64-encoded file data (data:mime;base64,...) or raw base64
  dataUrl?: string // Preferred field - base64-encoded file data (data:mime;base64,...)
  url?: string // Direct URL to existing file
  name: string // Original filename
  type: string // MIME type
}

export interface ChatExecutionContext {
  workspaceId: string
  workflowId: string
  executionId: string
}

function toAbsoluteInternalUrl(fileUrl: string): string {
  if (fileUrl.startsWith('http')) {
    return fileUrl
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  return `${baseUrl}${fileUrl.startsWith('/') ? fileUrl : `/${fileUrl}`}`
}

function internalStorageKey(fileUrl: string): string | null {
  if (!isInternalFileUrl(fileUrl)) return null
  try {
    return parseInternalFileUrl(fileUrl).key
  } catch {
    return null
  }
}

function hasSafeKeyParts(parts: string[]): boolean {
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

/**
 * Storage key for an image this workflow already produced.
 *
 * Chat runs as a public principal, so a stored key from another file is refused later.
 * Two stores are allowed: `agent-generated-images/{workflowId}/...`, and an image file
 * under `execution/{workspaceId}/{workflowId}/...` from an earlier run of this same
 * workflow. Image Generator saves the picture the chat shows into that execution path
 * (`generated-image.png`). A later edit starts a new execution, and the previous key
 * is not this run's file — copying it here is what lets the edit use the picture.
 * The key prefix is the check; a `context` query on the URL is ignored.
 */
function reusableWorkflowImageKey(
  fileUrl: string,
  executionContext: ChatExecutionContext
): { key: string; context: StorageContext } | null {
  const { workflowId, workspaceId } = executionContext
  if (!workflowId || workflowId.includes('/') || !workspaceId || workspaceId.includes('/')) {
    return null
  }

  const key = internalStorageKey(fileUrl)
  if (!key) return null

  const parts = key.split('/')
  if (!hasSafeKeyParts(parts)) return null

  if (parts.length >= 4 && parts[0] === 'agent-generated-images' && parts[1] === workflowId) {
    return { key, context: 'agent-generated-images' }
  }

  const fileName = parts[parts.length - 1] ?? ''
  if (
    parts.length >= 5 &&
    parts[0] === 'execution' &&
    parts[1] === workspaceId &&
    parts[2] === workflowId &&
    /\.(png|jpe?g|gif|webp)$/i.test(fileName)
  ) {
    return { key, context: 'execution' }
  }

  return null
}

async function copyReusableWorkflowImage(
  key: string,
  context: StorageContext,
  name: string,
  mime: string,
  executionContext: ChatExecutionContext,
  userId?: string
): Promise<UserFile> {
  let buffer: Buffer
  try {
    buffer = await downloadFile({
      key,
      context,
      maxBytes: MAX_REUSED_IMAGE_BYTES,
    })
  } catch (error) {
    if (isPayloadSizeLimitError(error)) {
      throw new Error(`File "${name}" exceeds the maximum size limit of 20MB`)
    }
    throw error
  }

  if (buffer.length > MAX_REUSED_IMAGE_BYTES) {
    const fileSizeMB = (buffer.length / (1024 * 1024)).toFixed(2)
    throw new Error(
      `File "${name}" exceeds the maximum size limit of 20MB (actual size: ${fileSizeMB}MB)`
    )
  }

  return uploadExecutionFile(
    executionContext,
    buffer,
    name,
    mime || 'application/octet-stream',
    userId
  )
}

/**
 * Process and upload chat files to temporary execution storage
 *
 * Handles three input formats:
 * 1. Base64 dataUrl - File content encoded as data URL (uploaded from client)
 * 2. Direct URL - Pass-through URL to existing file (already uploaded)
 * 3. Internal serve URL for an image this workflow already stored - copied into this execution
 *
 * Fresh uploads and reused generated images are stored under the current execution.
 * Any other stored reference is left for the execution-scope check to refuse.
 *
 * @param files Array of chat file attachments
 * @param executionContext Execution context for temporary storage
 * @param requestId Unique request identifier for logging/tracing
 * @param userId User ID for file metadata (optional)
 * @returns Array of UserFile objects with upload results
 */
export async function processChatFiles(
  files: ChatFile[],
  executionContext: ChatExecutionContext,
  requestId: string,
  userId?: string
): Promise<UserFile[]> {
  logger.info(
    `Processing ${files.length} chat files for execution ${executionContext.executionId}`,
    {
      requestId,
      executionContext,
    }
  )

  const copiedFiles: UserFile[] = []
  const transformedFiles: Array<{
    type: 'file' | 'url'
    data: string
    name: string
    mime?: string
  }> = []

  for (const file of files) {
    const directUrl = file.url?.trim()
    const inlineData = file.dataUrl || file.data
    const internalUrl =
      directUrl ||
      (inlineData && isInternalFileUrl(inlineData) ? toAbsoluteInternalUrl(inlineData) : '')

    const reusableImage = internalUrl
      ? reusableWorkflowImageKey(internalUrl, executionContext)
      : null
    if (reusableImage) {
      copiedFiles.push(
        await copyReusableWorkflowImage(
          reusableImage.key,
          reusableImage.context,
          file.name,
          file.type,
          executionContext,
          userId
        )
      )
      continue
    }

    if (directUrl) {
      transformedFiles.push({
        type: 'url',
        data: directUrl,
        name: file.name,
        mime: file.type,
      })
      continue
    }

    if (inlineData && isInternalFileUrl(inlineData)) {
      transformedFiles.push({
        type: 'url',
        data: toAbsoluteInternalUrl(inlineData),
        name: file.name,
        mime: file.type,
      })
      continue
    }

    transformedFiles.push({
      type: inlineData ? 'file' : 'url',
      data: inlineData || '',
      name: file.name,
      mime: file.type,
    })
  }

  const uploadedFiles =
    transformedFiles.length > 0
      ? await processExecutionFiles(transformedFiles, executionContext, requestId, userId)
      : []

  const userFiles = [...copiedFiles, ...uploadedFiles]

  logger.info(`Successfully processed ${userFiles.length} chat files`, {
    requestId,
    executionId: executionContext.executionId,
  })

  return userFiles
}
