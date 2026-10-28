'use client'

import { memo, useState } from 'react'
import { Button, Check, cn, Duplicate, handleKeyboardActivation, Tooltip } from '@sim/emcn'
import { File as FileIcon, FileText, ImageUp as ImageIcon } from '@sim/emcn/icons'
import {
  AgentStreamThinkingChrome,
  AgentStreamToolCallsChrome,
} from '@/components/agent-stream/agent-stream-chrome'
import type { AgentStreamToolCall } from '@/components/agent-stream/tool-call-lifecycle'
import type {
  AssistantGeneratedImage,
  AssistantChatFile as ChatFile,
} from '@/lib/chat/assistant-assets'
import {
  ChatFileDownload,
  ChatFileDownloadAll,
} from '@/app/(interfaces)/chat/components/message/components/file-download'
import MarkdownRenderer from '@/app/(interfaces)/chat/components/message/components/markdown-renderer'

export interface ChatAttachment {
  id: string
  name: string
  type: string
  dataUrl: string
  key?: string
  size?: number
}

/** Single chunk from knowledge base search (used when deployment outputs "Knowledge base results") */
export interface KnowledgeResultChunk {
  documentId: string
  documentName: string
  content: string
  chunkIndex: number
  metadata?: Record<string, unknown>
  similarity?: number
  /** Chunk UUID for "View in Knowledge Base" link; only present when user has workspace access */
  chunkId?: string
  knowledgeBaseId?: string
  workspaceId?: string | null
}

/**
 * Minimal reference persisted in chat history (no chunk content).
 * One ref per chunk; used to show document name, chunk index, and open-in-KB link when loading from history.
 * chunkIndex is optional for backward compatibility with refs saved before per-chunk indexing.
 */
export interface KnowledgeRef {
  documentId: string
  documentName: string
  chunkId: string
  /** 0-based; may be missing on refs persisted before this field was added. */
  chunkIndex?: number
  knowledgeBaseId: string
  workspaceId: string | null
}

/** Chat surface tool chip — the shared lifecycle chip plus its block id. */
export interface ChatToolCall extends AgentStreamToolCall {
  blockId: string
  displayName: string
}

/** Live-stream status of one selected chat output. */
export type ChatOutputSegmentStatus = 'waiting' | 'streaming' | 'done'

/**
 * One selected block output while a deployed-chat turn is still streaming.
 * Dropped on `final` so the settled bubble renders the combined `content`.
 */
export interface ChatOutputSegment {
  blockId: string
  content: string
  status: ChatOutputSegmentStatus
  thinking?: string
  isThinkingStreaming?: boolean
  toolCalls?: ChatToolCall[]
  isToolStreaming?: boolean
}

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
  /**
   * Per selected-output live state. Present only while `isStreaming` is true
   * when the deployment selected one or more block outputs.
   */
  outputSegments?: ChatOutputSegment[]
  attachments?: ChatAttachment[]
  executionId?: string
  files?: ChatFile[]
  generatedImages?: AssistantGeneratedImage[]
  /** Knowledge base search results when workflow outputs "results"; used for clickable references and modal (live only, not in history) */
  knowledgeResults?: KnowledgeResultChunk[]
  /** Persisted refs for history: document name + chunk link only; no chunks */
  knowledgeRefs?: KnowledgeRef[]
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
} as const

/**
 * Escapes HTML entities so untrusted strings are safe to interpolate into markup.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] || c)
}

/**
 * Opens an image attachment preview in a new tab via a blob URL,
 * escaping the user-controlled filename and data URL to prevent XSS.
 */
function openAttachmentPreview(name: string, dataUrl: string): void {
  const safeName = escapeHtml(name)
  const safeUrl = escapeHtml(dataUrl)
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${safeName}</title>
        <style>
          body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #000; }
          img { max-width: 100%; max-height: 100vh; object-fit: contain; }
        </style>
      </head>
      <body>
        <img src="${safeUrl}" alt="${safeName}" />
      </body>
    </html>
  `
  const blob = new Blob([html], { type: 'text/html' })
  const blobUrl = URL.createObjectURL(blob)
  window.open(blobUrl, '_blank', 'noopener,noreferrer')
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
}

interface ClientChatMessageProps {
  message: ChatMessage
}

export const ClientChatMessage = memo(function ClientChatMessage({
  message,
}: ClientChatMessageProps) {
  const [isCopied, setIsCopied] = useState(false)

  const isJsonObject = typeof message.content === 'object' && message.content !== null

  // Answer text is streamed separately from thinking / tool lifecycle events.
  const cleanTextContent = message.content
  const hasThinking = typeof message.thinking === 'string' && message.thinking.length > 0
  const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0
  const hasContent = isJsonObject || Boolean((message.content as string).trim())
  const hasFiles = Boolean(message.files?.length)

  if (message.type === 'assistant' && !hasContent && !hasFiles && !hasThinking && !hasToolCalls) {
    return null
  }

  const content =
    message.type === 'user' ? (
      <div className='py-5 md:px-4' data-message-id={message.id}>
        <div className='mx-auto max-w-3xl'>
          {message.attachments && message.attachments.length > 0 && (
            <div className='mb-2 flex justify-end'>
              <div className='flex flex-wrap gap-2'>
                {message.attachments.map((attachment) => {
                  const isImage = attachment.type.startsWith('image/')
                  const getFileIcon = (type: string) => {
                    if (type.includes('pdf'))
                      return <FileText className='size-5 text-[var(--text-muted)] md:size-6' />
                    if (type.startsWith('image/'))
                      return <ImageIcon className='size-5 text-[var(--text-muted)] md:size-6' />
                    if (type.includes('text') || type.includes('json'))
                      return <FileText className='size-5 text-[var(--text-muted)] md:size-6' />
                    return <FileIcon className='size-5 text-[var(--text-muted)] md:size-6' />
                  }
                  const formatFileSize = (bytes?: number) => {
                    if (!bytes || bytes === 0) return ''
                    const k = 1024
                    const sizes = ['B', 'KB', 'MB', 'GB']
                    const i = Math.floor(Math.log(bytes) / Math.log(k))
                    return `${Math.round((bytes / k ** i) * 10) / 10} ${sizes[i]}`
                  }

                  const isInteractive =
                    !!attachment.dataUrl?.trim() && attachment.dataUrl.startsWith('data:')

                  const handleOpenPreview = () => {
                    const validDataUrl = attachment.dataUrl?.trim()
                    if (!validDataUrl?.startsWith('data:')) return
                    openAttachmentPreview(attachment.name, validDataUrl)
                  }

                  return (
                    <div
                      key={attachment.id}
                      role={isInteractive ? 'button' : undefined}
                      aria-disabled={!isInteractive}
                      tabIndex={isInteractive ? 0 : undefined}
                      className={cn(
                        'relative overflow-hidden rounded-2xl border border-[var(--border-1)] bg-[var(--surface-2)]',
                        isInteractive && 'cursor-pointer',
                        isImage
                          ? 'size-16 md:size-20'
                          : 'flex h-16 min-w-[140px] max-w-[220px] items-center gap-2 px-3 md:h-20 md:min-w-[160px] md:max-w-[240px]'
                      )}
                      onClick={(e) => {
                        if (!isInteractive) return
                        e.preventDefault()
                        e.stopPropagation()
                        handleOpenPreview()
                      }}
                      onKeyDown={(e) => {
                        if (!isInteractive) return
                        handleKeyboardActivation(e, handleOpenPreview, { stopPropagation: true })
                      }}
                    >
                      {isImage &&
                      attachment.dataUrl?.trim() &&
                      attachment.dataUrl.startsWith('data:') ? (
                        <img
                          src={attachment.dataUrl}
                          alt={attachment.name}
                          className='size-full object-cover'
                        />
                      ) : (
                        <>
                          <div className='flex size-10 shrink-0 items-center justify-center rounded bg-[var(--surface-3)] md:size-12'>
                            {getFileIcon(attachment.type)}
                          </div>
                          <div className='min-w-0 flex-1'>
                            <div className='truncate text-[var(--text-primary)] text-xs md:text-sm'>
                              {attachment.name}
                            </div>
                            {attachment.size && (
                              <div className='text-[var(--text-muted)] text-micro md:text-xs'>
                                {formatFileSize(attachment.size)}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* `Sent N file(s)` is a placeholder for attachment-only sends, not user text. */}
          {message.content && !String(message.content).startsWith('Sent') && (
            <div className='flex justify-end'>
              <div className='min-w-0 max-w-[90%] rounded-3xl bg-[var(--surface-3)] px-4 py-3 md:max-w-[80%]'>
                <div className='whitespace-pre-wrap text-[var(--text-primary)] text-base leading-relaxed [overflow-wrap:anywhere]'>
                  {isJsonObject ? (
                    <pre className='overflow-x-auto'>
                      {JSON.stringify(message.content, null, 2)}
                    </pre>
                  ) : (
                    <span>{message.content as string}</span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    ) : (
      <div className='pt-5 pb-2 md:px-4' data-message-id={message.id}>
        <div className='mx-auto max-w-3xl'>
          <div className='flex flex-col space-y-3'>
            <div>
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
              {hasContent && (
                <div className='min-w-0 text-base [overflow-wrap:anywhere]'>
                  {isJsonObject ? (
                    <pre className='overflow-x-auto text-[var(--text-primary)]'>
                      {JSON.stringify(cleanTextContent, null, 2)}
                    </pre>
                  ) : (
                    <MarkdownRenderer content={cleanTextContent as string} />
                  )}
                </div>
              )}
            </div>
            {message.files && message.files.length > 0 && (
              <div className='flex flex-wrap gap-2'>
                {message.files.map((file) => (
                  <ChatFileDownload key={file.id} file={file} />
                ))}
              </div>
            )}
            {message.type === 'assistant' && !isJsonObject && !message.isInitialMessage && (
              <div className='flex items-center justify-start space-x-2'>
                {!message.isStreaming && hasContent && (
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <Button
                        aria-label={isCopied ? 'Copied!' : 'Copy to clipboard'}
                        variant='ghost-secondary'
                        className='p-0'
                        onClick={() => {
                          const contentToCopy =
                            typeof cleanTextContent === 'string'
                              ? cleanTextContent
                              : JSON.stringify(cleanTextContent, null, 2)
                          navigator.clipboard.writeText(contentToCopy)
                          setIsCopied(true)
                          setTimeout(() => setIsCopied(false), 2000)
                        }}
                      >
                        {isCopied ? <Check className='size-3' /> : <Duplicate className='size-3' />}
                      </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content side='top' align='center' sideOffset={5}>
                      {isCopied ? 'Copied!' : 'Copy to clipboard'}
                    </Tooltip.Content>
                  </Tooltip.Root>
                )}
                {!message.isStreaming && message.files && (
                  <ChatFileDownloadAll files={message.files} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    )

  return <>{content}</>
})
