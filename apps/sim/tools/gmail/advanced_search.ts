import { createLogger } from '@sim/logger'
import type { ExecutionContext } from '@/lib/uploads/contexts/execution/utils'
import type {
  GmailAdvancedSearchParams,
  GmailAdvancedSearchResponse,
  ThreadedEmailMessage,
} from '@/tools/gmail/types'
import { extractAttachmentInfo, GMAIL_API_BASE } from '@/tools/gmail/utils'
import type { ToolConfig } from '@/tools/types'

const logger = createLogger('GmailAdvancedSearchTool')

/**
 * Decodes base64url encoded string to UTF-8
 */
function decodeBase64Url(data: string): string {
  try {
    // Replace base64url characters with standard base64
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
    const buffer = Buffer.from(base64, 'base64')
    return buffer.toString('utf-8')
  } catch (error) {
    logger.warn('Failed to decode base64url data:', error)
    return ''
  }
}

/**
 * Extracts text content from message payload
 * Falls back to HTML if plain text is not available
 */
function extractMessageContent(payload: any): string {
  let plainTextContent = ''
  let htmlContent = ''

  // Check main body first
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }

  // Search through parts for text/plain and text/html
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.body?.data) {
        if (part.mimeType === 'text/plain' && !plainTextContent) {
          plainTextContent = decodeBase64Url(part.body.data)
        } else if (part.mimeType === 'text/html' && !htmlContent) {
          htmlContent = decodeBase64Url(part.body.data)
        }
      }

      // Check nested parts
      if (part.parts && Array.isArray(part.parts)) {
        for (const nestedPart of part.parts) {
          if (nestedPart.body?.data) {
            if (nestedPart.mimeType === 'text/plain' && !plainTextContent) {
              plainTextContent = decodeBase64Url(nestedPart.body.data)
            } else if (nestedPart.mimeType === 'text/html' && !htmlContent) {
              htmlContent = decodeBase64Url(nestedPart.body.data)
            }
          }
        }
      }
    }
  }

  // Return plain text if available, otherwise fall back to HTML
  return plainTextContent || htmlContent || ''
}

/**
 * Downloads and parses attachment content using file parsers (similar to Google Drive search)
 */
async function downloadAndParseAttachment(
  messageId: string,
  attachmentId: string,
  _filename: string,
  _mimeType: string,
  accessToken: string
): Promise<Buffer> {
  try {
    const attachmentResponse = await fetch(
      `${GMAIL_API_BASE}/messages/${messageId}/attachments/${attachmentId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    )

    if (!attachmentResponse.ok) {
      throw new Error(`Failed to download attachment ${attachmentId}`)
    }

    const attachmentData = (await attachmentResponse.json()) as { data: string; size: number }

    // Decode base64url data to buffer
    const base64 = attachmentData.data.replace(/-/g, '+').replace(/_/g, '/')
    return Buffer.from(base64, 'base64')
  } catch (error) {
    logger.error(`Error downloading attachment ${attachmentId}:`, error)
    throw error
  }
}

/**
 * Extracts content from attachment using file parsers (similar to Google Drive search)
 */
async function extractAttachmentContent(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string | null> {
  // Only attempt to parse files on the server side
  if (typeof window !== 'undefined') {
    logger.warn('File parsing skipped on client side', { filename, mimeType })
    return null
  }

  // Get file extension from filename
  let extension: string | null = null
  if (filename) {
    const lastDot = filename.lastIndexOf('.')
    if (lastDot !== -1) {
      extension = filename.slice(lastDot + 1).toLowerCase()
    }
  }

  // For text-based files, extract content directly
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-javascript'
  ) {
    try {
      const content = buffer.toString('utf-8')
      return content
    } catch (error) {
      logger.warn('Failed to read file as UTF-8 text', { filename, mimeType, error })
    }
  }

  // For binary files (PDF, DOCX, etc.), try to use file parsers
  if (extension) {
    try {
      // Use a runtime string to prevent Next.js from statically analyzing
      const fileParsersModulePath = '@' + '/lib/file-parsers'
      const fileParsersModule = await import(fileParsersModulePath)

      if (fileParsersModule.isSupportedFileType(extension)) {
        logger.info('Parsing attachment with specialized parser', {
          filename,
          extension,
          mimeType,
        })
        const parseResult = await fileParsersModule.parseBuffer(buffer, extension)
        return parseResult.content
      }
    } catch (parseError) {
      logger.warn('File parser not available or failed', {
        filename,
        mimeType,
        extension,
        error: parseError,
      })
    }
  }

  return null
}

/**
 * Processes a single message and its attachments
 */
async function processMessage(
  message: any,
  accessToken: string,
  includeAttachments: boolean,
  execContext: ExecutionContext | undefined
): Promise<Omit<ThreadedEmailMessage, 'replies'> & { messageId?: string; inReplyTo?: string }> {
  const headers = message.payload?.headers || []
  const subject = headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || ''
  const from = headers.find((h: any) => h.name.toLowerCase() === 'from')?.value || ''
  const to = headers.find((h: any) => h.name.toLowerCase() === 'to')?.value || ''
  const date = headers.find((h: any) => h.name.toLowerCase() === 'date')?.value || ''

  // Extract Message-ID and In-Reply-To for threading
  const messageId = headers.find((h: any) => h.name.toLowerCase() === 'message-id')?.value || ''
  const inReplyTo = headers.find((h: any) => h.name.toLowerCase() === 'in-reply-to')?.value || ''

  // Extract email content with fallback to HTML
  const content = extractMessageContent(message.payload)

  // Process attachments if requested
  const attachments: any[] = []
  if (includeAttachments && message.payload) {
    const attachmentInfo = extractAttachmentInfo(message.payload)
    if (attachmentInfo.length > 0) {
      for (const attachment of attachmentInfo) {
        try {
          // Download attachment
          const buffer = await downloadAndParseAttachment(
            message.id,
            attachment.attachmentId,
            attachment.filename,
            attachment.mimeType,
            accessToken
          )

          // Extract content from attachment
          const attachmentContent = await extractAttachmentContent(
            buffer,
            attachment.filename,
            attachment.mimeType
          )

          // Upload attachment to S3/execution storage if we have execution context
          let userFile: any = null
          if (execContext && typeof window === 'undefined') {
            try {
              // Dynamic import to avoid client-side bundling of server-only modules
              const { uploadExecutionFile } = await import(
                '@/lib/uploads/contexts/execution/file-manager'
              )
              userFile = await uploadExecutionFile(
                execContext,
                buffer,
                attachment.filename,
                attachment.mimeType
              )
            } catch (uploadError) {
              logger.warn('Failed to upload attachment to execution storage', {
                filename: attachment.filename,
                error: uploadError,
              })
            }
          }

          attachments.push({
            id: userFile?.id || attachment.attachmentId,
            name: attachment.filename,
            size: attachment.size,
            type: attachment.mimeType,
            url: userFile?.url || null,
            key: userFile?.key || null,
            context: userFile?.context || null,
            content: attachmentContent || null,
          })
        } catch (error: any) {
          logger.error(`Error processing attachment ${attachment.filename}:`, error)
          // Continue with other attachments
        }
      }
    }
  }

  return {
    id: message.id,
    threadId: message.threadId,
    subject,
    from,
    to,
    date,
    content: content || '',
    attachments: attachments.length > 0 ? attachments : undefined,
    messageId,
    inReplyTo,
  }
}

/**
 * Builds hierarchical threaded message structure from flat array of messages
 * Uses In-Reply-To headers to determine parent-child relationships
 */
async function buildThreadedStructure(
  messages: any[],
  accessToken: string,
  includeAttachments: boolean,
  execContext: ExecutionContext | undefined
): Promise<ThreadedEmailMessage | null> {
  if (!messages || messages.length === 0) {
    return null
  }

  /**
   * Gmail threads API returns a flat `messages[]` array for a thread.
   * Per expected contract in this tool:
   * - `messages[0]` is treated as the parent/root message
   * - every other message is a direct reply under `parent.replies[]`
   *
   * This avoids over-nesting when headers like `In-Reply-To` / `References`
   * are missing, inconsistent, or not aligned with the expected UI structure.
   */
  const processedMessages = await Promise.all(
    messages.map((msg) => processMessage(msg, accessToken, includeAttachments, execContext))
  )

  const root = processedMessages[0]
  const replies = processedMessages.slice(1)

  const { messageId: _rootMessageId, inReplyTo: _rootInReplyTo, ...cleanRoot } = root

  const cleanReplies: ThreadedEmailMessage[] = replies.map((reply) => {
    const { messageId: _replyMessageId, inReplyTo: _replyInReplyTo, ...cleanReply } = reply
    return {
      ...cleanReply,
      replies: undefined,
    }
  })

  return {
    ...cleanRoot,
    replies: cleanReplies.length > 0 ? cleanReplies : undefined,
  }
}

export async function executeGmailAdvancedSearchDirect(
  params: GmailAdvancedSearchParams
): Promise<GmailAdvancedSearchResponse> {
  const { query, accessToken, maxResults = 5, includeAttachments = false } = params

  // Search for messages
  const searchParams = new URLSearchParams()
  searchParams.append('q', query)
  searchParams.append('maxResults', maxResults.toString())

  const searchResponse = await fetch(`${GMAIL_API_BASE}/messages?${searchParams.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  })

  if (!searchResponse.ok) {
    const errorData = await searchResponse.json().catch(() => ({}))
    logger.error('Failed to search Gmail messages', {
      status: searchResponse.status,
      error: errorData,
    })
    throw new Error(errorData.error?.message || 'Failed to search Gmail messages')
  }

  const data = await searchResponse.json()

  if (!data.messages || data.messages.length === 0) {
    return {
      success: true,
      output: {
        results: [],
      },
    }
  }

  const messagesToProcess = data.messages.slice(0, maxResults)

  try {
    // Get unique thread IDs from search results to avoid duplicate API calls
    const uniqueThreadIds = new Set<string>()
    messagesToProcess.forEach((msg: any) => {
      if (msg.threadId) {
        uniqueThreadIds.add(msg.threadId)
      }
    })

    logger.info(
      `Found ${uniqueThreadIds.size} unique threads from ${messagesToProcess.length} search results`
    )

    // Fetch full thread details for each unique thread ID
    const threadPromises = Array.from(uniqueThreadIds).map(async (threadId: string) => {
      try {
        const threadResponse = await fetch(`${GMAIL_API_BASE}/threads/${threadId}?format=full`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        })

        if (!threadResponse.ok) {
          const errorData = await threadResponse.json().catch(() => ({}))
          logger.error(`Failed to fetch thread ${threadId}`, {
            status: threadResponse.status,
            statusText: threadResponse.statusText,
            error: errorData,
          })
          return null
        }

        const threadData = await threadResponse.json()
        return {
          threadId,
          messages: threadData.messages || [],
        }
      } catch (error: any) {
        logger.error(`Error fetching thread ${threadId}:`, error)
        return null
      }
    })

    const threads = (await Promise.all(threadPromises)).filter((t) => t !== null)

    // Get execution context if available
    const execContext = (params as any)._executionContext as ExecutionContext | undefined

    // Build threaded structure for each thread
    const processedResults: ThreadedEmailMessage[] = []

    if (threads.length > 0) {
      // Process threads successfully fetched
      for (const thread of threads) {
        const threadedMessage = await buildThreadedStructure(
          thread.messages,
          accessToken,
          includeAttachments,
          execContext
        )
        if (threadedMessage) {
          processedResults.push(threadedMessage)
        }
      }
    } else {
      // Fallback: If thread API fails, fetch individual messages
      logger.warn('Thread API calls failed, falling back to individual message fetching')
      const messagePromises = messagesToProcess.map(async (msg: any) => {
        try {
          const messageResponse = await fetch(`${GMAIL_API_BASE}/messages/${msg.id}?format=full`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          })

          if (!messageResponse.ok) {
            logger.warn(`Failed to fetch message ${msg.id}`)
            return null
          }

          const messageData = await messageResponse.json()
          return await processMessage(messageData, accessToken, includeAttachments, execContext)
        } catch (error: any) {
          logger.error(`Error fetching message ${msg.id}:`, error)
          return null
        }
      })

      const individualMessages = (await Promise.all(messagePromises)).filter((m) => m !== null)
      for (const msg of individualMessages) {
        processedResults.push({
          ...msg,
          replies: undefined,
        })
      }
    }

    logger.info(`Returning ${processedResults.length} email results`)

    return {
      success: true,
      output: {
        results: processedResults,
      },
    }
  } catch (error: any) {
    logger.error('Error processing advanced search results:', error)

    return {
      success: false,
      output: {
        results: [],
      },
      error: error.message || 'Failed to process search results',
    }
  }
}

export const gmailAdvancedSearchTool: ToolConfig<
  GmailAdvancedSearchParams,
  GmailAdvancedSearchResponse
> = {
  id: 'gmail_advanced_search',
  name: 'Gmail Advanced Search',
  description:
    'Search emails in Gmail with full content and attachment parsing, returning threaded conversations',
  version: '1.0.0',

  oauth: {
    required: true,
    provider: 'google-email',
  },

  params: {
    accessToken: {
      type: 'string',
      required: true,
      visibility: 'hidden',
      description: 'Access token for Gmail API',
    },
    query: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Search query for emails',
    },
    maxResults: {
      type: 'number',
      required: false,
      visibility: 'user-only',
      description: 'Maximum number of results to return (default: 5)',
    },
    includeAttachments: {
      type: 'boolean',
      required: false,
      visibility: 'user-only',
      description: 'Include and parse attachments (default: false)',
    },
    clientName: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Client name for tracking and summarization',
    },
  },

  request: {
    url: '/api/tools/gmail/advanced_search',
    method: 'GET',
    headers: () => ({}),
  },

  outputs: {
    results: {
      type: 'json',
      description:
        'Array of email search results with threaded conversations. Each result includes id, threadId, subject, from, to, date, content, attachments (if includeAttachments is true), and replies array containing all reply messages in the same structure.',
    },
  },
}

export const gmailAdvancedSearchV2Tool: ToolConfig<
  GmailAdvancedSearchParams,
  GmailAdvancedSearchResponse
> = {
  id: 'gmail_advanced_search_v2',
  name: 'Gmail Advanced Search',
  description:
    'Search emails in Gmail with full content and attachment parsing, returning threaded conversations',
  version: '2.0.0',
  oauth: gmailAdvancedSearchTool.oauth,
  params: gmailAdvancedSearchTool.params,
  request: gmailAdvancedSearchTool.request,
  outputs: gmailAdvancedSearchTool.outputs,
}
