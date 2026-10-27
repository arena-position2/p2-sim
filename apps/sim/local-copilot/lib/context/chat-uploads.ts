import type { WorkspaceFileRecord } from '@/lib/uploads/contexts/workspace/workspace-file-manager'
import type { CopilotFileAttachmentRef } from '@/local-copilot/lib/user-turn-content'

/** Prefix for the system note listing chat-scoped uploads. */
export const CHAT_UPLOADS_INVENTORY_SYSTEM_PREFIX =
  'Chat uploads already available on this conversation:' as const

/** Soft cap so proceed auto-inline cannot dump an unbounded upload set into one turn. */
export const MAX_AUTO_INLINE_PRIOR_UPLOADS = 8

/**
 * Soft cap for auto-inlining text upload bodies into the current user turn.
 * Larger files stay as inventory/pointer notes; the model must read/grep them.
 * Applies to all text-like uploads (html/md/txt/json/csv/pdf extract), not HTML-only.
 */
export const LOCAL_COPILOT_AUTO_INLINE_TEXT_MAX_BYTES = 24_000

/**
 * True when a text upload body is small enough to embed in the user turn.
 */
export function shouldAutoInlineTextUploadBody(byteLength: number): boolean {
  return (
    Number.isFinite(byteLength) &&
    byteLength >= 0 &&
    byteLength <= LOCAL_COPILOT_AUTO_INLINE_TEXT_MAX_BYTES
  )
}

/**
 * Pointer note when a text upload is too large to dump into the prompt.
 */
export function formatOversizedUploadInlineNote(params: {
  filename: string
  size?: number
  mediaType?: string
}): string {
  const sizePart =
    typeof params.size === 'number' && Number.isFinite(params.size) && params.size >= 0
      ? ` (${formatByteSize(params.size)})`
      : ''
  const media = params.mediaType?.trim()
  const mediaPart = media ? ` [${media}]` : ''
  return [
    `File "${params.filename}"${sizePart}${mediaPart} is too large to inline into this turn.`,
    `It is available at uploads/${params.filename} — call read("uploads/${params.filename}") or grep, then edit with workspace_file patch.`,
    'Do not ask the user to re-upload. Do not invent file contents from memory.',
  ].join(' ')
}

/**
 * Short history stub for a persisted attachment — pointers only, no file bytes.
 */
export function formatAttachmentHistoryStub(params: {
  filename: string
  mediaType?: string
  size?: number
}): string {
  const media = params.mediaType?.trim() || 'application/octet-stream'
  const size =
    typeof params.size === 'number' && Number.isFinite(params.size) && params.size >= 0
      ? `, ${formatByteSize(params.size)}`
      : ''
  return `[Attached: ${params.filename} (${media}${size}). Still on this chat at uploads/${params.filename} — read("uploads/${params.filename}") when you need contents. Do not ask the user to re-upload.]`
}

/**
 * Joins stubs for all attachments on a persisted user message.
 */
export function formatAttachmentHistoryStubs(
  attachments:
    | Array<{ filename?: string; media_type?: string; mediaType?: string; size?: number }>
    | undefined
): string {
  if (!attachments?.length) return ''
  return attachments
    .map((attachment) => {
      const filename = attachment.filename?.trim()
      if (!filename) return ''
      return formatAttachmentHistoryStub({
        filename,
        mediaType: attachment.media_type ?? attachment.mediaType,
        size: attachment.size,
      })
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * System inventory of chat-scoped mothership uploads for the current turn.
 */
export function formatChatUploadsInventorySystemMessage(
  uploads: Array<Pick<WorkspaceFileRecord, 'name' | 'type' | 'size'>>
): string | null {
  if (uploads.length === 0) return null
  const lines = uploads.map((upload) => {
    const media = upload.type?.trim() || 'application/octet-stream'
    const size =
      typeof upload.size === 'number' && Number.isFinite(upload.size)
        ? `, ${formatByteSize(upload.size)}`
        : ''
    return `- uploads/${upload.name} (${media}${size})`
  })
  return [
    CHAT_UPLOADS_INVENTORY_SYSTEM_PREFIX,
    ...lines,
    'These files are already attached to this chat. Use read("uploads/<filename>") (or tool equivalents) when you need their contents. Large text/HTML uploads are not fully inlined into the prompt — read/grep them, then patch. Never ask the user to re-upload a file that appears here.',
  ].join('\n')
}

/**
 * Maps chat upload records into the attachment refs used by user-turn inlining.
 */
export function chatUploadsToAttachmentRefs(
  uploads: Array<Pick<WorkspaceFileRecord, 'name' | 'type' | 'size' | 'key'>>
): CopilotFileAttachmentRef[] {
  return uploads.slice(0, MAX_AUTO_INLINE_PRIOR_UPLOADS).map((upload) => ({
    key: upload.key,
    filename: upload.name,
    media_type: upload.type || 'application/octet-stream',
    size: upload.size,
  }))
}

/**
 * Merges current-request attachments with prior chat uploads (current names win).
 */
export function mergeFileAttachmentRefs(
  current: CopilotFileAttachmentRef[] | undefined,
  prior: CopilotFileAttachmentRef[]
): CopilotFileAttachmentRef[] {
  const byName = new Map<string, CopilotFileAttachmentRef>()
  for (const attachment of prior) {
    byName.set(attachment.filename, attachment)
  }
  for (const attachment of current ?? []) {
    byName.set(attachment.filename, attachment)
  }
  return [...byName.values()]
}

const EXACT_PROCEED_RE =
  /^(yes|yep|yeah|yup|ok|okay|sure|correct|confirmed|confirm|proceed|continue|go\s*ahead|do\s*it|sounds?\s+good|that'?s\s+right|please\s+proceed|lgtm|ship\s*it)[.!\s]*$/i

const SHORT_PROCEED_PREFIX_RE =
  /^(yes|yep|yeah|yup|ok|okay|sure|correct|confirmed|proceed|continue|go\s*ahead)\b/i

/**
 * True when this turn has no new uploads but prior chat uploads should be
 * auto-inlined (e.g. user said "Yes" after attaching screens on the previous turn).
 */
export function shouldAutoInlinePriorChatUploads(params: {
  message: string
  hasCurrentAttachments: boolean
  priorUploadCount: number
}): boolean {
  if (params.hasCurrentAttachments || params.priorUploadCount <= 0) return false
  const trimmed = params.message.trim()
  if (!trimmed) return false
  if (EXACT_PROCEED_RE.test(trimmed)) return true
  // Short continuations like "Yes, please proceed." after a confirmation round.
  if (trimmed.length <= 96 && SHORT_PROCEED_PREFIX_RE.test(trimmed)) return true
  return false
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
