'use client'

import {
  type Dispatch,
  Fragment,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Tooltip } from '@sim/emcn'
// import MarkdownRenderer from './components/markdown-renderer'
// import { toastError, toastSuccess } from '@/components/ui'
import { createLogger } from '@sim/logger'
import { formatRelativeTime } from '@sim/utils/formatting'
import { RefreshCw } from 'lucide-react'
import {
  AgentStreamThinkingChrome,
  AgentStreamToolCallsChrome,
} from '@/components/agent-stream/agent-stream-chrome'
import { getDocumentIcon } from '@/components/icons/document-icons'
import {
  resolveEChartsOptionsFromContent,
  stripEChartsJsonFromContent,
  stripIncompleteTrailingChartJson,
} from '@/lib/chart-generation/echarts-option'
import type { AssistantGeneratedImage } from '@/lib/chat/assistant-assets'
import { resolveSelectableGeneratedImage } from '@/lib/chat/assistant-assets'
import { ChatEChartsRenderer } from '@/app/(interfaces)/chat/components/message/components/chat-echarts-renderer'
import { DeployedInlineLoader } from '@/app/(interfaces)/chat/components/message/components/deployed-response-loader'
import { FeedbackBox } from '@/app/(interfaces)/chat/components/message/components/feedback-box'
import { KnowledgeResultsModal } from '@/app/(interfaces)/chat/components/message/components/knowledge-results-modal'
import {
  CopiedMessageIcon,
  CopyMessageIcon,
  DislikeMessageIcon,
  LikeMessageIcon,
  messageActionIconButtonClass,
} from '@/app/(interfaces)/chat/components/message/components/message-action-icons'
import { StreamingIndicator } from '@/app/(interfaces)/chat/components/message/components/streaming-indicator'
import { WelcomeMessageWithCtas } from '@/app/(interfaces)/chat/components/message/components/welcome-message-with-ctas'
import type {
  ChatAttachment,
  ChatToolCall,
  KnowledgeRef,
  KnowledgeResultChunk,
} from '@/app/(interfaces)/chat/components/message/message'
import { CHAT_ERROR_MESSAGES } from '@/app/(interfaces)/chat/constants'
import {
  downloadImage,
  extractAllBase64Images,
  extractBase64Image,
  getImageUrlFromContent,
  hasBase64Images,
  ImageWithViewFullOverlay,
  isBase64,
  isRenderableImageUrl,
  mergeToolOutputImageUrls,
  normalizeImageUrlForCompare,
  renderBs64Img,
  renderChatMessageImage,
  resolveMessageImagesAndProse,
  S3UploadFailedAlert,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components/chat-message/constants'
import ArenaCopilotMarkdownRenderer from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/copilot/components/copilot-message/components/arena-markdown-renderer'

const arenaChatMessageLogger = createLogger('ArenaClientChatMessage')

function formatAttachmentSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${Math.round((bytes / 1024 ** index) * 10) / 10} ${units[index]}`
}

function servableAttachmentUrl(dataUrl: string | undefined): string | undefined {
  const value = dataUrl?.trim()
  if (!value || value.startsWith('data:')) return undefined
  if (value.startsWith('/') || value.startsWith('http://') || value.startsWith('https://')) {
    return value
  }
  return undefined
}

function DeployedUserFileChip({ attachment }: { attachment: ChatAttachment }) {
  const Icon = getDocumentIcon(attachment.type || '', attachment.name || '')
  const href = servableAttachmentUrl(attachment.dataUrl)
  const sizeLabel = formatAttachmentSize(attachment.size)
  const chip = (
    <div className='flex h-16 min-w-[140px] max-w-[220px] items-center gap-2 rounded-2xl border border-[var(--border-1)] bg-[var(--surface-2)] px-3'>
      <div className='flex size-10 shrink-0 items-center justify-center rounded bg-[var(--surface-3)] text-[var(--text-muted)]'>
        <Icon className='size-5' />
      </div>
      <div className='min-w-0 flex-1'>
        <div className='truncate text-[var(--text-primary)] text-xs'>{attachment.name}</div>
        {sizeLabel ? <div className='text-[var(--text-muted)] text-micro'>{sizeLabel}</div> : null}
      </div>
    </div>
  )

  if (!href) return chip

  return (
    <a href={href} target='_blank' rel='noopener noreferrer' className='inline-flex'>
      {chip}
    </a>
  )
}

const DEPLOYED_MARKDOWN_PROPS = {
  fontClassName: 'font-[family-name:var(--font-inter)] font-normal antialiased tracking-[0]',
  bodyTextClassName: 'text-base leading-[25px] text-[var(--text-primary)]',
  headingTextClassName: 'font-semibold tracking-[0] text-[var(--text-primary)]',
} as const

export interface ChatMessage {
  id: string
  content: string | Record<string, unknown>
  type: 'user' | 'assistant'
  timestamp: Date
  isInitialMessage?: boolean
  /** User bubble summarizing Start Block form values (not a typed chat query) */
  isStartBlockInputsSummary?: boolean
  isStreaming?: boolean
  /** Model thinking text (agent-events-v1). Chrome only when non-empty. */
  thinking?: string
  /** True while thinking deltas are still arriving (before first answer chunk / final). */
  isThinkingStreaming?: boolean
  /** Tool lifecycle chips (name + status only). Chrome only when non-empty. */
  toolCalls?: ChatToolCall[]
  /** True while any tool chip is still `running`. */
  isToolStreaming?: boolean
  executionId?: string
  liked?: boolean | null
  attachments?: ChatAttachment[]
  generatedImages?: AssistantGeneratedImage[]
  knowledgeResults?: KnowledgeResultChunk[]
  knowledgeRefs?: KnowledgeRef[]
}

// function EnhancedMarkdownRenderer({ content }: { content: string }) {
//   return (
//     <TooltipProvider>
//       <MarkdownRenderer content={content} />
//     </TooltipProvider>
//   )
// }

/**
 * Returns true if the content looks like a GFM markdown table (has a separator line of dashes/colons between pipes).
 * When true, we skip pipe-segment split so the table renders correctly.
 */
function isLikelyMarkdownTable(str: string): boolean {
  const lines = str.trim().split(/\r?\n/)
  if (lines.length < 2) return false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (cells.length === 0) continue
    const onlySeparatorChars = new RegExp('^[' + '\\-' + ':' + '\\s' + ']+$')
    const isSeparatorLine = cells.every((cell) => onlySeparatorChars.test(cell) && cell.length > 0)
    if (isSeparatorLine) return true
  }
  return false
}

/**
 * Returns true if the content contains a fenced code block (```).
 * When true, we skip pipe-segment split so code blocks and any pipes inside them are preserved.
 */
function hasFencedCodeBlock(str: string): boolean {
  return /```/.test(str)
}

/**
 * Pipe column is copyable when it sits strictly between two other columns (matches `trim` of that segment non-empty).
 */
function isPipeSegmentCopyable(partsLen: number, index: number, part: string): boolean {
  return partsLen >= 3 && index >= 1 && index <= partsLen - 2 && part.trim().length > 0
}

/**
 * True for a `| cell | cell |` row. A single pipe, as in `iPhone | 128GB`, stays prose
 * so the rest of the message is not parsed one line at a time.
 */
function isPipeDataRow(line: string): boolean {
  if (!line.includes('|')) return false
  const parts = line.split('|')
  for (let index = 0; index < parts.length; index++) {
    if (isPipeSegmentCopyable(parts.length, index, parts[index])) return true
  }
  return false
}

interface LineWithPipeHoverProps {
  line: string
  onCopySegment: (text: string) => void
  renderImage?: (args: { src: string; alt?: string }) => ReactNode
}

function LineWithPipeHover({ line, onCopySegment, renderImage }: LineWithPipeHoverProps) {
  const parts = line.split('|')
  const handleCopy = useCallback(
    (text: string) => {
      onCopySegment(text.trim())
    },
    [onCopySegment]
  )

  return (
    <Tooltip.Provider>
      <span className='whitespace-pre-wrap'>
        {parts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 ? '|' : null}
            {isPipeSegmentCopyable(parts.length, i, part) ? (
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    type='button'
                    onClick={() => handleCopy(part)}
                    className='inline cursor-pointer rounded border-0 bg-transparent px-0.5 py-0 font-inherit text-inherit no-underline transition-colors hover:underline hover:decoration-2 hover:decoration-gray-400 hover:underline-offset-2'
                  >
                    <ArenaCopilotMarkdownRenderer
                      content={part}
                      variant='inline'
                      renderImage={renderImage}
                      fontClassName={DEPLOYED_MARKDOWN_PROPS.fontClassName}
                      bodyTextClassName={DEPLOYED_MARKDOWN_PROPS.bodyTextClassName}
                      headingTextClassName={DEPLOYED_MARKDOWN_PROPS.headingTextClassName}
                    />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Content side='top'>Click to copy</Tooltip.Content>
              </Tooltip.Root>
            ) : (
              <ArenaCopilotMarkdownRenderer
                content={part}
                variant='inline'
                renderImage={renderImage}
                fontClassName={DEPLOYED_MARKDOWN_PROPS.fontClassName}
                bodyTextClassName={DEPLOYED_MARKDOWN_PROPS.bodyTextClassName}
                headingTextClassName={DEPLOYED_MARKDOWN_PROPS.headingTextClassName}
              />
            )}
          </Fragment>
        ))}
      </span>
    </Tooltip.Provider>
  )
}

export const ArenaClientChatMessage = memo(
  function ArenaClientChatMessage({
    message,
    setMessages,
    workspaceIdsForKbLinks,
    onCopySegmentToInput,
    onToggleGeneratedImage,
    selectedGeneratedImageIds,
    selectedGeneratedImageIdsKey,
    onWelcomeQueryClick,
    isLastAssistantMessage = false,
    onRegenerateMessage,
  }: {
    message: ChatMessage
    setMessages?: Dispatch<SetStateAction<ChatMessage[]>>
    /** When set, show "View in Knowledge Base" link for refs whose workspaceId is in this list */
    workspaceIdsForKbLinks?: string[]
    /** When set, text between pipes (| text |) is clickable and copies to chat input */
    onCopySegmentToInput?: (text: string) => void
    onToggleGeneratedImage?: (
      messageId: string,
      image: {
        id: string
        name: string
        url: string
        key?: string
        type: string
        size?: number
        context?: string
      }
    ) => void
    selectedGeneratedImageIds?: Set<string>
    selectedGeneratedImageIdsKey?: string
    /** When set, welcome-message {{query}} tokens are clickable and execute query */
    onWelcomeQueryClick?: (text: string) => void
    isLastAssistantMessage?: boolean
    onRegenerateMessage?: () => void
  }) {
    const [isCopied, setIsCopied] = useState(false)
    const [isFeedbackOpen, setIsFeedbackOpen] = useState(false)
    const [isLikeFeedbackOpen, setIsLikeFeedbackOpen] = useState(false)
    const [isFeedbackPending, setIsFeedbackPending] = useState(false)

    const isJsonObject = useMemo(() => {
      return typeof message.content === 'object' && message.content !== null
    }, [message.content])

    // Since tool calls are now handled via SSE events and stored in message.toolCalls,
    // we can use the content directly without parsing. While streaming, hide a
    // partially received trailing chart JSON payload so raw JSON never flashes
    // as text; the chart renders as soon as its payload completes.
    const cleanTextContent = useMemo(() => {
      if (message.isStreaming && typeof message.content === 'string') {
        return stripIncompleteTrailingChartJson(message.content)
      }
      return message.content
    }, [message.content, message.isStreaming])

    const messageChartOptions = useMemo(
      () => resolveEChartsOptionsFromContent(cleanTextContent),
      [cleanTextContent]
    )

    // Close this feedback box when another message opens theirs
    useEffect(() => {
      if (typeof window === 'undefined') return
      const handleCloseFeedback = () => {
        setIsFeedbackOpen(false)
        setIsLikeFeedbackOpen(false)
      }
      window.addEventListener('p2-close-feedback', handleCloseFeedback)
      return () => {
        window.removeEventListener('p2-close-feedback', handleCloseFeedback)
      }
    }, [])

    const renderWelcomeMessage = useCallback(
      (str: string) => (
        <WelcomeMessageWithCtas content={str} variant='chat' onQueryClick={onWelcomeQueryClick} />
      ),
      [onWelcomeQueryClick]
    )

    const generatedImagesByUrl = useMemo(() => {
      const entries = (message.generatedImages ?? []).map(
        (image): [string, AssistantGeneratedImage] => [
          normalizeImageUrlForCompare(image.url),
          image,
        ]
      )
      return new Map(entries)
    }, [message.generatedImages])

    const getGeneratedImageSelectionProps = useCallback(
      (imageUrl?: string) => {
        if (!imageUrl || !onToggleGeneratedImage) {
          return {}
        }

        const matchedImage = resolveSelectableGeneratedImage(imageUrl, generatedImagesByUrl)
        if (!matchedImage) {
          return {}
        }

        const isSelected = selectedGeneratedImageIds?.has(matchedImage.id) ?? false

        return {
          onSelect: () =>
            onToggleGeneratedImage(message.id, {
              id: matchedImage.id,
              name: matchedImage.name || 'Generated image',
              url: matchedImage.url,
              key: matchedImage.key,
              type: matchedImage.type,
              size: matchedImage.size,
              context: matchedImage.context,
            }),
          selectLabel: isSelected ? 'Selected' : 'Select',
          isSelected,
        }
      },
      [generatedImagesByUrl, message.id, onToggleGeneratedImage, selectedGeneratedImageIds]
    )

    const renderMarkdownImage = useCallback(
      ({ src }: { src: string; alt?: string }) =>
        renderChatMessageImage(src, getGeneratedImageSelectionProps(src)),
      [getGeneratedImageSelectionProps]
    )

    const renderDeployedMarkdown = useCallback(
      (content: string) => (
        <ArenaCopilotMarkdownRenderer
          content={content}
          renderImage={renderMarkdownImage}
          fontClassName={DEPLOYED_MARKDOWN_PROPS.fontClassName}
          bodyTextClassName={DEPLOYED_MARKDOWN_PROPS.bodyTextClassName}
          headingTextClassName={DEPLOYED_MARKDOWN_PROPS.headingTextClassName}
        />
      ),
      [renderMarkdownImage]
    )

    /**
     * Renders string content. Fenced code and markdown tables stay one document.
     * Pipe-copy applies only to `| cell | cell |` rows; surrounding lines stay together
     * so indented code is not turned into a code block per line.
     */
    const renderStringContent = useCallback(
      (str: string) => {
        if (message.isInitialMessage) {
          return renderWelcomeMessage(str)
        }

        if (
          !onCopySegmentToInput ||
          !str.includes('|') ||
          isLikelyMarkdownTable(str) ||
          hasFencedCodeBlock(str)
        ) {
          return renderDeployedMarkdown(str)
        }

        const lines = str.split(/\r?\n/)
        const chunks: Array<{ type: 'markdown'; text: string } | { type: 'pipe'; line: string }> =
          []
        let markdownLines: string[] = []
        const flushMarkdown = () => {
          if (markdownLines.length === 0) return
          chunks.push({ type: 'markdown', text: markdownLines.join('\n') })
          markdownLines = []
        }
        for (const line of lines) {
          if (isPipeDataRow(line)) {
            flushMarkdown()
            chunks.push({ type: 'pipe', line })
            continue
          }
          markdownLines.push(line)
        }
        flushMarkdown()

        if (chunks.every((chunk) => chunk.type === 'markdown')) {
          return renderDeployedMarkdown(str)
        }

        return (
          <span className='whitespace-normal'>
            {chunks.map((chunk, i) => (
              <span key={i}>
                {i > 0 && '\n'}
                {chunk.type === 'pipe' ? (
                  <LineWithPipeHover
                    line={chunk.line}
                    onCopySegment={onCopySegmentToInput}
                    renderImage={renderMarkdownImage}
                  />
                ) : (
                  renderDeployedMarkdown(chunk.text)
                )}
              </span>
            ))}
          </span>
        )
      },
      [
        message.isInitialMessage,
        onCopySegmentToInput,
        renderDeployedMarkdown,
        renderMarkdownImage,
        renderWelcomeMessage,
      ]
    )

    const handleUserAttachmentDownload = useCallback((attachment: { dataUrl: string }) => {
      if (attachment.dataUrl.startsWith('data:image/')) {
        const [, base64Data = ''] = attachment.dataUrl.split(',', 2)
        void downloadImage(true, base64Data || undefined)
        return
      }

      void downloadImage(false, undefined, attachment.dataUrl)
    }, [])

    const renderContent = (content: unknown) => {
      if (!content) {
        return null
      }

      if (content === cleanTextContent && messageChartOptions) {
        const prose = typeof content === 'string' ? stripEChartsJsonFromContent(content) : ''
        return (
          <>
            {prose ? renderStringContent(prose) : null}
            {messageChartOptions.map((option, index) => (
              <ChatEChartsRenderer key={index} option={option} />
            ))}
          </>
        )
      }

      try {
        if (typeof content === 'object' && content !== null) {
          const o = content as Record<string, unknown>
          const imgRaw = typeof o.image === 'string' ? o.image : ''
          const txtRaw = typeof o.content === 'string' ? o.content : ''

          const imageBase64 =
            imgRaw.trim() && isBase64(imgRaw) && !isRenderableImageUrl(imgRaw)
              ? imgRaw.replace(/\s+/g, '')
              : ''

          const { uniqueUrls, prose: proseWithoutUrlLines } = mergeToolOutputImageUrls(
            imgRaw,
            txtRaw,
            o.images
          )
          const proseTrim = proseWithoutUrlLines.trim()
          const txtTrim = txtRaw.trim()

          const showS3 =
            o.s3UploadFailed === true && (uniqueUrls.length > 0 || Boolean(imageBase64))

          if (uniqueUrls.length > 0 || imageBase64) {
            return (
              <>
                {proseTrim ? renderStringContent(proseTrim) : null}
                {showS3 && <S3UploadFailedAlert />}
                {uniqueUrls.map((url) => (
                  <div key={normalizeImageUrlForCompare(url)} className='w-full'>
                    {renderBs64Img({
                      isBase64: false,
                      imageData: '',
                      imageUrl: url,
                      ...getGeneratedImageSelectionProps(url),
                    })}
                  </div>
                ))}
                {imageBase64 && (
                  <div className='w-full'>
                    {renderBs64Img({
                      isBase64: true,
                      imageData: imageBase64,
                      ...getGeneratedImageSelectionProps(imgRaw),
                    })}
                  </div>
                )}
              </>
            )
          }

          if (txtTrim) {
            return renderStringContent(txtTrim)
          }

          return (
            <ArenaCopilotMarkdownRenderer
              content={JSON.stringify(content, null, 2)}
              renderImage={renderMarkdownImage}
              fontClassName={DEPLOYED_MARKDOWN_PROPS.fontClassName}
              bodyTextClassName={DEPLOYED_MARKDOWN_PROPS.bodyTextClassName}
              headingTextClassName={DEPLOYED_MARKDOWN_PROPS.headingTextClassName}
            />
          )
        }

        if (typeof content === 'string') {
          const { urls, prose } = resolveMessageImagesAndProse(content)
          if (urls.length > 0) {
            return (
              <>
                {prose ? renderStringContent(prose) : null}
                {urls.map((url) => (
                  <div key={normalizeImageUrlForCompare(url)} className='w-full'>
                    {renderBs64Img({
                      isBase64: false,
                      imageData: '',
                      imageUrl: url,
                      ...getGeneratedImageSelectionProps(url),
                    })}
                  </div>
                ))}
              </>
            )
          }
        }

        if (typeof content === 'string' && isBase64(content)) {
          const cleanedContent = content.replace(/\s+/g, '')
          return renderBs64Img({
            isBase64: true,
            imageData: cleanedContent,
            ...getGeneratedImageSelectionProps(content),
          })
        }

        if (typeof content === 'string') {
          const trimmed = content.trim()
          if (isRenderableImageUrl(trimmed)) {
            return (
              <div className='w-full'>
                {renderBs64Img({
                  isBase64: false,
                  imageData: '',
                  imageUrl: trimmed,
                  ...getGeneratedImageSelectionProps(trimmed),
                })}
              </div>
            )
          }
        }

        if (typeof content === 'string') {
          const { textParts, base64Images } = extractBase64Image(content)

          if (base64Images.length > 0) {
            return (
              <>
                {textParts.length > 0 && renderStringContent(textParts.join('\n\n'))}
                {base64Images.map((imageData, index) => (
                  <div key={index}>
                    {renderBs64Img({
                      isBase64: true,
                      imageData,
                      ...getGeneratedImageSelectionProps(imageData),
                    })}
                  </div>
                ))}
              </>
            )
          }

          return renderStringContent(content)
        }

        return (
          <ArenaCopilotMarkdownRenderer
            content={String(content)}
            renderImage={renderMarkdownImage}
            fontClassName={DEPLOYED_MARKDOWN_PROPS.fontClassName}
            bodyTextClassName={DEPLOYED_MARKDOWN_PROPS.bodyTextClassName}
            headingTextClassName={DEPLOYED_MARKDOWN_PROPS.headingTextClassName}
          />
        )
      } catch (error) {
        arenaChatMessageLogger.error('Error rendering message content', { error })
        return (
          <div className='rounded-lg border border-[var(--color-ds-status-error-border)] bg-[var(--color-ds-status-error-surface)] p-3 text-[var(--color-ds-status-error-text)]'>
            <p className='text-sm'>⚠️ Error displaying content. Please try refreshing the chat.</p>
          </div>
        )
      }
    }

    const hasRenderableText = useMemo(() => {
      if (typeof cleanTextContent === 'string') {
        return cleanTextContent.trim().length > 0
      }
      return !!cleanTextContent && !isBase64(cleanTextContent)
    }, [cleanTextContent])

    const isErrorResponse = useMemo(() => {
      if (typeof cleanTextContent !== 'string') return false
      return (
        cleanTextContent.includes(CHAT_ERROR_MESSAGES.GENERIC_ERROR) ||
        cleanTextContent.toLowerCase().includes('sorry, there was an error')
      )
    }, [cleanTextContent])

    const timestampLabel = formatRelativeTime(message.timestamp)

    const handleCopy = () => {
      const contentToCopy =
        typeof cleanTextContent === 'string'
          ? cleanTextContent
          : JSON.stringify(cleanTextContent, null, 2)
      navigator.clipboard.writeText(contentToCopy)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    }

    const handleDownload = () => {
      const imageUrl = getImageUrlFromContent(cleanTextContent)
      if (imageUrl) {
        downloadImage(false, undefined, imageUrl)
        return
      }
      const base64Images = extractAllBase64Images(cleanTextContent)
      if (base64Images.length > 0) {
        base64Images.forEach((imageData) => {
          downloadImage(true, imageData)
        })
      }
    }

    const containsBase64Images = hasBase64Images(cleanTextContent)
    const hasImageUrl = !!getImageUrlFromContent(cleanTextContent)

    const [knowledgeModalDoc, setKnowledgeModalDoc] = useState<{
      documentName: string
      chunks: KnowledgeResultChunk[]
      viewInKbUrl?: string
    } | null>(null)

    /** Build KB chunk URL from KnowledgeRef (history). */
    const getKbLinkUrlFromRef = useCallback((ref: KnowledgeRef): string => {
      const params = new URLSearchParams()
      params.set('chunk', ref.chunkId)
      if (typeof ref.chunkIndex === 'number') {
        params.set('chunkIndex', String(ref.chunkIndex))
      }
      return `/workspace/${ref.workspaceId}/knowledge/${ref.knowledgeBaseId}/${ref.documentId}?${params.toString()}`
    }, [])

    /** One ref per chunk: from live (knowledgeResults) or history (knowledgeRefs). */
    const uniqueChunkRefs = useMemo(() => {
      type ChunkRefItem = {
        key: string
        documentId: string
        documentName: string
        chunkIndex: number
        chunks?: KnowledgeResultChunk[]
        linkUrl: string | null
        workspaceId: string | null
        knowledgeBaseId?: string
        fromHistory: boolean
      }
      const results = message.knowledgeResults ?? []
      const refsFromHistory = message.knowledgeRefs ?? []

      if (results.length > 0) {
        const seen = new Set<string>()
        return results
          .filter((r) => {
            const kb = r.knowledgeBaseId ?? ''
            const key = `${kb}-${r.documentId}-${r.chunkId ?? `i-${r.chunkIndex}`}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .map((r) => {
            const linkUrl =
              r.chunkId && r.knowledgeBaseId && r.workspaceId != null
                ? (() => {
                    const params = new URLSearchParams()
                    params.set('chunk', r.chunkId)
                    params.set('chunkIndex', String(r.chunkIndex))
                    return `/workspace/${r.workspaceId}/knowledge/${r.knowledgeBaseId}/${r.documentId}?${params.toString()}`
                  })()
                : null
            return {
              key: `${r.knowledgeBaseId ?? ''}-${r.documentId}-${r.chunkId ?? r.chunkIndex}`,
              documentId: r.documentId,
              documentName: r.documentName || r.documentId,
              chunkIndex: r.chunkIndex,
              chunks: [r],
              linkUrl,
              workspaceId: r.workspaceId ?? null,
              knowledgeBaseId: r.knowledgeBaseId,
              fromHistory: false,
            }
          })
      }

      if (refsFromHistory.length > 0) {
        return refsFromHistory.map((r) => ({
          key: `${r.knowledgeBaseId}-${r.documentId}-${r.chunkId}`,
          documentId: r.documentId,
          documentName: r.documentName || r.documentId,
          chunkIndex: typeof r.chunkIndex === 'number' ? r.chunkIndex : 0,
          chunks: undefined as KnowledgeResultChunk[] | undefined,
          linkUrl: r.workspaceId ? getKbLinkUrlFromRef(r) : null,
          workspaceId: r.workspaceId,
          knowledgeBaseId: r.knowledgeBaseId,
          fromHistory: true,
        }))
      }

      return []
    }, [message.knowledgeResults, message.knowledgeRefs, getKbLinkUrlFromRef])

    const canShowKbLink = (ref: { linkUrl: string | null; workspaceId: string | null }) => {
      if (!ref.linkUrl || !workspaceIdsForKbLinks?.length) return false
      return ref.workspaceId !== null && workspaceIdsForKbLinks.includes(ref.workspaceId)
    }

    /** Only refs the user can open (has workspace access). Chat-only users see no references. */
    const visibleChunkRefs = useMemo(() => {
      if (!workspaceIdsForKbLinks?.length) return []
      return uniqueChunkRefs.filter((ref) => canShowKbLink(ref))
    }, [uniqueChunkRefs, workspaceIdsForKbLinks])

    /** Refs grouped by document (per knowledge base when multiple KBs): document name once, then sorted chunk indices. */
    const refsGroupedByDocument = useMemo(() => {
      const groupKey = (ref: (typeof visibleChunkRefs)[0]) =>
        `${ref.knowledgeBaseId ?? ''}-${ref.documentId}`
      const byDoc = new Map<string, { documentName: string; chunks: typeof visibleChunkRefs }>()
      for (const ref of visibleChunkRefs) {
        const key = groupKey(ref)
        const existing = byDoc.get(key)
        if (existing) {
          existing.chunks.push(ref)
        } else {
          byDoc.set(key, { documentName: ref.documentName, chunks: [ref] })
        }
      }
      return Array.from(byDoc.entries()).map(([documentId, { documentName, chunks }]) => ({
        documentId,
        documentName,
        chunks: [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex),
      }))
    }, [visibleChunkRefs])

    /** Hide during streaming; show only when done and user has access to at least one ref (streaming + history). */
    const showReferencesSection = !message.isStreaming && visibleChunkRefs.length > 0

    const openKnowledgeModal = useCallback(
      (documentName: string, chunks: KnowledgeResultChunk[], viewInKbUrl?: string) => {
        setKnowledgeModalDoc({ documentName, chunks, viewInKbUrl })
      },
      []
    )

    const handleLike = async (currentExecutionId: string) => {
      if (!currentExecutionId) return

      // If already liked, unlike it (send null to backend)
      if (message.liked === true) {
        setIsFeedbackPending(true)
        try {
          await fetch(`/api/chat/feedback/${currentExecutionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              comment: '',
              inComplete: false,
              inAccurate: false,
              outOfDate: false,
              tooLong: false,
              tooShort: false,
              liked: null,
            }),
          })
          setMessages?.((prev: any) =>
            prev.map((msg: any) =>
              msg.executionId === currentExecutionId ? { ...msg, liked: null } : msg
            )
          )
        } catch {
          // toastError('Error', {
          //   description: 'Something went wrong!',
          // })
        } finally {
          setIsLikeFeedbackOpen(false)
          setIsFeedbackPending(false)
        }
        return
      }

      // Otherwise, open feedback popover for like feedback
      try {
        // Close any other open feedback boxes across messages
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('p2-close-feedback'))
        }
      } catch {}
      setIsLikeFeedbackOpen(true)
    }

    const handleSubmitLikeFeedback = async (feedback: any, currentExecutionId: string) => {
      if (!currentExecutionId) return

      setIsFeedbackPending(true)
      try {
        await fetch(`/api/chat/feedback/${currentExecutionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            comment: feedback.comment?.trim() || '',
            inComplete: false,
            inAccurate: false,
            outOfDate: false,
            tooLong: false,
            tooShort: false,
            liked: true, // This is a like feedback
          }),
        })
        setMessages?.((prev: any) =>
          prev.map((msg: any) =>
            msg.executionId === currentExecutionId ? { ...msg, liked: true } : msg
          )
        )
        // toastSuccess('Success', {
        //   description: 'Thanks for your feedback!',
        // })
      } catch {
        // toastError('Error', {
        //   description: 'Something went wrong!',
        // })
      } finally {
        setIsLikeFeedbackOpen(false)
        setIsFeedbackPending(false)
      }
    }

    const handleDislike = async (currentExecutionId: string) => {
      // If already disliked, undislike it (send null to backend)
      if (message.liked === false) {
        setIsFeedbackPending(true)
        try {
          await fetch(`/api/chat/feedback/${currentExecutionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              comment: '',
              inComplete: false,
              inAccurate: false,
              outOfDate: false,
              tooLong: false,
              tooShort: false,
              liked: null,
            }),
          })
          setMessages?.((prev: any) =>
            prev.map((msg: any) =>
              msg.executionId === currentExecutionId ? { ...msg, liked: null } : msg
            )
          )
        } catch {
          // toastError('Error', {
          //   description: 'Something went wrong!',
          // })
        } finally {
          setIsFeedbackOpen(false)
          setIsFeedbackPending(false)
        }
        return
      }

      // Otherwise, open feedback popover
      try {
        // Close any other open feedback boxes across messages
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('p2-close-feedback'))
        }
      } catch {}
      setIsFeedbackOpen(true)
    }

    const handleSubmitFeedback = async (feedback: any, currentExecutionId: string) => {
      if (!currentExecutionId) return

      setIsFeedbackPending(true)
      try {
        await fetch(`/api/chat/feedback/${currentExecutionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            comment: feedback.comment?.trim() || '',
            inComplete: feedback.incomplete,
            inAccurate: feedback.inaccurate,
            outOfDate: feedback.outOfDate,
            tooLong: feedback.tooLong,
            tooShort: feedback.tooShort,
            liked: false, // This is a dislike feedback
          }),
        })
        setMessages?.((prev: any) =>
          prev.map((msg: any) =>
            msg.executionId === currentExecutionId ? { ...msg, liked: false } : msg
          )
        )
        // toastSuccess('Success', {
        //   description: 'Thanks for your feedback!',
        // })
      } catch {
        // toastError('Error', {
        //   description: 'Something went wrong!',
        // })
      } finally {
        setIsFeedbackOpen(false)
        setIsFeedbackPending(false)
      }
    }

    // For user messages (on the right)
    if (message.type === 'user') {
      const hasUserText =
        typeof message.content === 'string'
          ? message.content.trim().length > 0
          : Boolean(message.content)

      return (
        <div className='py-[5px]' data-message-id={message.id}>
          <div className='w-full'>
            {message.attachments && message.attachments.length > 0 && (
              <div className='mb-2 flex justify-end'>
                <div className='flex flex-wrap gap-2'>
                  {message.attachments.map((attachment, index) => {
                    const isImage = (attachment.type ?? '').startsWith('image/')
                    const isSelected = selectedGeneratedImageIds?.has(attachment.id) ?? false
                    return (
                      <div key={attachment.id}>
                        {isImage && attachment.dataUrl ? (
                          <div className='flex flex-col items-end'>
                            <ImageWithViewFullOverlay
                              src={attachment.dataUrl}
                              wrapperClassName={
                                isSelected
                                  ? 'h-32 w-32 overflow-hidden rounded-lg border border-[var(--color-ds-brand-default)] bg-[var(--color-ds-surface-subtle)] ring-1 ring-[var(--color-ds-brand-default)] transition-[border-color,box-shadow]'
                                  : 'h-32 w-32 overflow-hidden rounded-lg border border-[var(--color-ds-border-default)] bg-[var(--color-ds-surface-subtle)] transition-[border-color,box-shadow]'
                              }
                              onDownload={() => handleUserAttachmentDownload(attachment)}
                              onSelect={
                                onToggleGeneratedImage
                                  ? () =>
                                      onToggleGeneratedImage(message.id, {
                                        id: attachment.id,
                                        name: attachment.name || `Uploaded image ${index + 1}`,
                                        url: attachment.dataUrl,
                                        key: attachment.key,
                                        type: attachment.type,
                                      })
                                  : undefined
                              }
                              selectLabel={
                                onToggleGeneratedImage
                                  ? selectedGeneratedImageIds?.has(attachment.id)
                                    ? 'Selected'
                                    : 'Select'
                                  : undefined
                              }
                              compactActions
                            >
                              <img
                                src={attachment.dataUrl}
                                alt={attachment.name}
                                className='h-full w-full object-cover'
                              />
                            </ImageWithViewFullOverlay>
                          </div>
                        ) : (
                          <DeployedUserFileChip attachment={attachment} />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {hasUserText && (
              <div className='flex justify-end'>
                <div className='max-w-[70%]'>
                  <div className='overflow-hidden rounded-[16px] bg-[var(--surface-5)] px-3.5 py-2'>
                    <div className='whitespace-pre-wrap break-words font-[family-name:var(--font-inter)] text-[var(--text-primary)] text-base leading-[23px] tracking-[0] antialiased'>
                      {isJsonObject ? (
                        <span>{JSON.stringify(message.content as string)}</span>
                      ) : (
                        <span>{message.content as string}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )
    }

    // For assistant messages (on the left)
    const hasThinking = typeof message.thinking === 'string' && message.thinking.length > 0
    const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0
    const showStreamPlaceholder =
      message.isStreaming && !hasThinking && !hasToolCalls && !hasRenderableText

    return (
      <div className='py-[5px]' data-message-id={message.id}>
        <div className='w-full'>
          <div className='flex flex-col space-y-3'>
            {hasThinking && (
              <AgentStreamThinkingChrome
                thinking={message.thinking!}
                isStreaming={message.isThinkingStreaming}
              />
            )}
            {hasToolCalls && (
              <AgentStreamToolCallsChrome
                toolCalls={message.toolCalls!}
                isStreaming={message.isToolStreaming}
              />
            )}
            {(hasRenderableText || isJsonObject || containsBase64Images || hasImageUrl) && (
              <div className='py-1'>
                <div className='break-words font-[family-name:var(--font-inter)] text-[var(--text-primary)] text-base leading-[25px] tracking-[0] antialiased'>
                  {renderContent(cleanTextContent)}
                </div>
              </div>
            )}
            {showStreamPlaceholder && <DeployedInlineLoader label='Working…' />}
            {showReferencesSection && (
              <div className='mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm'>
                <span className='text-[var(--color-ds-text-tertiary)]'>References:</span>
                {refsGroupedByDocument.map((group, groupIndex) => {
                  const docChunks = group.chunks.flatMap((r) => r.chunks ?? [])
                  const hasModalChunks = docChunks.length > 0
                  return (
                    <span
                      key={group.documentId}
                      className='inline-flex flex-wrap items-center gap-x-0.5 gap-y-0.5'
                    >
                      {groupIndex > 0 && (
                        <span className='text-[var(--color-ds-text-disabled)]'>,</span>
                      )}
                      {hasModalChunks ? (
                        <button
                          type='button'
                          className='cursor-pointer rounded px-1 py-0.5 text-[var(--color-ds-text-link)] underline decoration-[var(--color-ds-text-link)]/50 underline-offset-2 transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                          onClick={() =>
                            openKnowledgeModal(
                              group.documentName,
                              docChunks,
                              group.chunks[0]?.linkUrl ?? undefined
                            )
                          }
                        >
                          {group.documentName}
                        </button>
                      ) : (
                        <span className='rounded px-1 py-0.5 text-[var(--color-ds-text-primary)]'>
                          {group.documentName}
                        </span>
                      )}
                      {group.chunks.map((ref) =>
                        ref.linkUrl ? (
                          <a
                            key={ref.key}
                            href={ref.linkUrl}
                            target='_blank'
                            rel='noopener noreferrer'
                            className='cursor-pointer rounded px-1 py-0.5 text-[var(--color-ds-text-link)] underline decoration-[var(--color-ds-text-link)]/50 underline-offset-2 transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                            aria-label={`Open chunk ${ref.chunkIndex} of ${group.documentName} in Knowledge Base`}
                          >
                            #{ref.chunkIndex}
                          </a>
                        ) : null
                      )}
                    </span>
                  )
                })}
              </div>
            )}
            {knowledgeModalDoc && (
              <KnowledgeResultsModal
                isOpen={!!knowledgeModalDoc}
                onClose={() => setKnowledgeModalDoc(null)}
                documentName={knowledgeModalDoc.documentName}
                chunks={knowledgeModalDoc.chunks}
                viewInKbUrl={knowledgeModalDoc.viewInKbUrl}
              />
            )}
            {message.type === 'assistant' &&
              !message.isStreaming &&
              !message.isInitialMessage &&
              (hasRenderableText ||
                isErrorResponse ||
                isJsonObject ||
                containsBase64Images ||
                hasImageUrl ||
                (message.generatedImages?.length ?? 0) > 0) && (
                <div className='flex flex-col gap-1'>
                  <p className='text-[var(--color-ds-text-tertiary)] text-xs'>{timestampLabel}</p>
                  {isErrorResponse && onRegenerateMessage && (
                    <button
                      type='button'
                      className='flex w-fit items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[var(--text-primary)] text-sm hover:bg-[var(--surface-hover)]'
                      onClick={onRegenerateMessage}
                    >
                      <RefreshCw className='size-3.5' />
                      Try again
                    </button>
                  )}
                  <div className='flex items-center justify-start gap-2'>
                    {!isJsonObject && hasRenderableText && !hasImageUrl && (
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              type='button'
                              className={messageActionIconButtonClass()}
                              onClick={() => {
                                handleCopy()
                              }}
                              aria-label={isCopied ? 'Copied message' : 'Copy message'}
                            >
                              {isCopied ? <CopiedMessageIcon /> : <CopyMessageIcon />}
                            </button>
                          </Tooltip.Trigger>

                          <Tooltip.Content side='top'>
                            {isCopied ? 'Copied message' : 'Copy message'}
                          </Tooltip.Content>
                        </Tooltip.Root>
                      </Tooltip.Provider>
                    )}
                    {isLastAssistantMessage && onRegenerateMessage && !isErrorResponse && (
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              type='button'
                              className={messageActionIconButtonClass()}
                              onClick={onRegenerateMessage}
                              aria-label='Regenerate response'
                            >
                              <RefreshCw className='size-[14px]' strokeWidth={2} />
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Content>Regenerate</Tooltip.Content>
                        </Tooltip.Root>
                      </Tooltip.Provider>
                    )}
                    {Boolean(message?.executionId) && (
                      <>
                        {isFeedbackPending ? (
                          <StreamingIndicator />
                        ) : (
                          <>
                            {message?.liked !== false && (
                              <Tooltip.Provider>
                                <Tooltip.Root>
                                  <Tooltip.Trigger asChild>
                                    <button
                                      type='button'
                                      className={messageActionIconButtonClass(
                                        message?.liked === true
                                      )}
                                      onClick={() => {
                                        handleLike(message?.executionId || '')
                                      }}
                                      aria-label={message?.liked === true ? 'Unlike' : 'Like'}
                                    >
                                      <LikeMessageIcon />
                                    </button>
                                  </Tooltip.Trigger>
                                  <Tooltip.Content side='top'>Good response</Tooltip.Content>
                                </Tooltip.Root>
                              </Tooltip.Provider>
                            )}
                            <FeedbackBox
                              isOpen={isLikeFeedbackOpen && message?.liked == null}
                              onClose={() => setIsLikeFeedbackOpen(false)}
                              onSubmit={handleSubmitLikeFeedback}
                              currentExecutionId={message?.executionId || ''}
                              isLikeFeedback={true}
                            />

                            {message?.liked !== true && (
                              <Tooltip.Provider>
                                <Tooltip.Root>
                                  <Tooltip.Trigger asChild>
                                    <button
                                      type='button'
                                      className={messageActionIconButtonClass(
                                        message?.liked === false
                                      )}
                                      onClick={() => {
                                        handleDislike(message?.executionId || '')
                                      }}
                                      aria-label={
                                        message?.liked === false ? 'Remove dislike' : 'Dislike'
                                      }
                                    >
                                      <DislikeMessageIcon />
                                    </button>
                                  </Tooltip.Trigger>
                                  <Tooltip.Content side='top'>Bad response</Tooltip.Content>
                                </Tooltip.Root>
                              </Tooltip.Provider>
                            )}
                            <FeedbackBox
                              isOpen={isFeedbackOpen && message?.liked !== false}
                              onClose={() => setIsFeedbackOpen(false)}
                              onSubmit={handleSubmitFeedback}
                              currentExecutionId={message?.executionId || ''}
                            />
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
          </div>
        </div>
      </div>
    )
  },
  // Memoization to prevent unnecessary re-renders
  (prevProps, nextProps) => {
    return (
      prevProps.message.id === nextProps.message.id &&
      prevProps.message.content === nextProps.message.content &&
      prevProps.message.isStreaming === nextProps.message.isStreaming &&
      prevProps.message.thinking === nextProps.message.thinking &&
      prevProps.message.isThinkingStreaming === nextProps.message.isThinkingStreaming &&
      prevProps.message.isToolStreaming === nextProps.message.isToolStreaming &&
      prevProps.message.toolCalls === nextProps.message.toolCalls &&
      prevProps.message.isInitialMessage === nextProps.message.isInitialMessage &&
      prevProps.message.executionId === nextProps.message.executionId &&
      prevProps.message.liked === nextProps.message.liked &&
      prevProps.message.generatedImages?.length === nextProps.message.generatedImages?.length &&
      prevProps.message.knowledgeResults?.length === nextProps.message.knowledgeResults?.length &&
      prevProps.message.knowledgeRefs?.length === nextProps.message.knowledgeRefs?.length &&
      prevProps.workspaceIdsForKbLinks?.length === nextProps.workspaceIdsForKbLinks?.length &&
      prevProps.onCopySegmentToInput === nextProps.onCopySegmentToInput &&
      prevProps.onToggleGeneratedImage === nextProps.onToggleGeneratedImage &&
      prevProps.selectedGeneratedImageIdsKey === nextProps.selectedGeneratedImageIdsKey &&
      prevProps.onWelcomeQueryClick === nextProps.onWelcomeQueryClick &&
      prevProps.isLastAssistantMessage === nextProps.isLastAssistantMessage &&
      prevProps.onRegenerateMessage === nextProps.onRegenerateMessage
    )
  }
)
