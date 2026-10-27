import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { readChatUpload } from '@/lib/mothership/tools/handlers/upload-file-reader'
import { isImageFileType } from '@/lib/uploads/utils/file-utils'
import {
  formatOversizedUploadInlineNote,
  shouldAutoInlineTextUploadBody,
} from '@/local-copilot/lib/context/chat-uploads'
import { isWorkflowContextPointer } from '@/local-copilot/lib/context/open-workflow'
import { getMessageContentText } from '@/local-copilot/lib/providers/message-content'
import type { ChatMessage, ChatMessageContentPart } from '@/local-copilot/lib/providers/types'

const logger = createLogger('LocalCopilotUserTurn')

export interface CopilotFileAttachmentRef {
  key: string
  filename: string
  media_type: string
  size: number
}

export interface CopilotContextEntry {
  type: string
  content: string
  tag?: string
  path?: string
}

export interface BuildLocalCopilotUserTurnParams {
  message: string
  contexts?: CopilotContextEntry[]
  fileAttachments?: CopilotFileAttachmentRef[]
  chatId?: string
}

function formatContextEntry(entry: CopilotContextEntry): string {
  const tagPrefix = entry.tag ? `[${entry.tag}]\n` : ''
  const path = entry.path?.trim() ?? ''
  if (isWorkflowContextPointer(entry.type, path) && !entry.content.trim()) {
    return `${tagPrefix}The currently open workflow is in the system context.`.trim()
  }
  const body = entry.content.trim()
    ? entry.content
    : path
      ? `Resource path: ${path}\nRead with: read("${path}")`
      : ''
  return `${tagPrefix}${body}`.trim()
}

function formatContextEntries(contexts?: CopilotContextEntry[]): string {
  if (!contexts?.length) return ''
  return contexts.map(formatContextEntry).filter(Boolean).join('\n\n')
}

/**
 * Parses mothership `uploaded_file` context lines like
 * `File "name.html" (text/html, 63000 bytes) uploaded.`
 */
export function parseUploadedFileContext(content: string): {
  displayName: string
  mediaType: string
  size?: number
} | null {
  const nameMatch = content.match(/^File "([^"]+)"/)
  const metaMatch = content.match(/\(([^,]+),\s*(\d+)\s*bytes\)/i)
  const typeOnlyMatch = content.match(/\(([^,)]+)(?:,|\))/)
  const displayName = nameMatch?.[1]?.trim()
  const mediaType = metaMatch?.[1]?.trim() || typeOnlyMatch?.[1]?.trim()
  if (!displayName || !mediaType) return null
  const sizeRaw = metaMatch?.[2]
  const size =
    sizeRaw !== undefined && Number.isFinite(Number(sizeRaw)) ? Number(sizeRaw) : undefined
  return size !== undefined ? { displayName, mediaType, size } : { displayName, mediaType }
}

async function inlineChatUpload(
  displayName: string,
  mediaType: string,
  chatId: string,
  knownSize?: number
): Promise<{ text?: string; image?: ChatMessageContentPart } | null> {
  try {
    // Images stay vision-inlined regardless of byte size.
    if (
      !isImageFileType(mediaType) &&
      typeof knownSize === 'number' &&
      !shouldAutoInlineTextUploadBody(knownSize)
    ) {
      logger.info('Skipping oversized chat upload inline for Arena Copilot', {
        chatId,
        displayName,
        knownSize,
      })
      return {
        text: formatOversizedUploadInlineNote({
          filename: displayName,
          size: knownSize,
          mediaType,
        }),
      }
    }

    const readResult = await readChatUpload(displayName, chatId)
    if (!readResult) return null

    const attachment = readResult.attachment
    if (attachment?.type === 'image' && attachment.source.type === 'base64') {
      return {
        image: {
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.source.media_type,
            data: attachment.source.data,
          },
        },
      }
    }

    if (isImageFileType(mediaType)) {
      return null
    }

    const content = readResult.content.trim()
    if (!content) return null

    if (!shouldAutoInlineTextUploadBody(content.length)) {
      logger.info('Clamping oversized chat upload inline after read for Arena Copilot', {
        chatId,
        displayName,
        contentLength: content.length,
        knownSize,
      })
      return {
        text: formatOversizedUploadInlineNote({
          filename: displayName,
          size: typeof knownSize === 'number' ? knownSize : content.length,
          mediaType,
        }),
      }
    }

    return { text: `Contents of "${displayName}":\n${content}` }
  } catch (error) {
    logger.warn('Failed to inline chat upload for Arena Copilot', {
      chatId,
      displayName,
      error: getErrorMessage(error),
    })
    return null
  }
}

/**
 * Builds the current user turn for Arena Copilot, including upload context text and
 * inline vision blocks for image attachments tracked on the mothership chat.
 * Large text uploads are pointer-only — full bytes stay in uploads/ until read/grep.
 */
export async function buildLocalCopilotUserTurn(
  params: BuildLocalCopilotUserTurnParams
): Promise<ChatMessage> {
  const contextText = formatContextEntries(params.contexts)
  const supplementalText: string[] = []
  const imageParts: ChatMessageContentPart[] = []
  const inlinedUploadNames = new Set<string>()

  if (params.chatId) {
    for (const entry of params.contexts ?? []) {
      if (entry.type !== 'uploaded_file') continue
      const parsed = parseUploadedFileContext(entry.content)
      if (!parsed) continue
      inlinedUploadNames.add(parsed.displayName)
      const inlined = await inlineChatUpload(
        parsed.displayName,
        parsed.mediaType,
        params.chatId,
        parsed.size
      )
      if (inlined?.text) supplementalText.push(inlined.text)
      if (inlined?.image) imageParts.push(inlined.image)
    }

    for (const attachment of params.fileAttachments ?? []) {
      if (inlinedUploadNames.has(attachment.filename)) continue
      inlinedUploadNames.add(attachment.filename)
      const inlined = await inlineChatUpload(
        attachment.filename,
        attachment.media_type,
        params.chatId,
        attachment.size
      )
      if (inlined?.text) supplementalText.push(inlined.text)
      if (inlined?.image) imageParts.push(inlined.image)
    }
  }

  const textSections = [params.message, contextText, ...supplementalText].filter(Boolean)
  const text = textSections.join('\n\n')

  if (imageParts.length === 0) {
    return { role: 'user', content: text }
  }

  const parts: ChatMessageContentPart[] = []
  if (text.trim()) {
    parts.push({ type: 'text', text })
  }
  parts.push(...imageParts)

  return { role: 'user', content: parts }
}

/**
 * Plain-text view of the user turn for tool metadata and persistence.
 */
export function getLocalCopilotUserTurnText(message: ChatMessage): string {
  return getMessageContentText(message.content)
}
