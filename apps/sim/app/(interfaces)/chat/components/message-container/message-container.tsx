'use client'

import {
  type Dispatch,
  type Ref,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Button, cn } from '@sim/emcn'
import { ArrowDown } from '@sim/emcn/icons'
import { MessageCircle } from 'lucide-react'
import {
  CONVERSATION_TIMELINE_GUTTER_CLASS,
  ConversationTimeline,
  shouldShowConversationTimeline,
} from '@/components/conversation-timeline/conversation-timeline'
import { DeployedResponseLoader } from '@/app/(interfaces)/chat/components/message/components/deployed-response-loader'
import { DEPLOYED_CHAT_CONTENT_MAX_WIDTH_CLASS } from '@/app/(interfaces)/chat/constants'
import { ArenaClientChatMessage, type ChatMessage } from '../message/ArenaClientChatMessage'

interface ChatMessageContainerProps {
  messages: ChatMessage[]
  isLoading: boolean
  /** When true, response is streaming (show "Fetching..." instead of "Thinking...") */
  isStreaming?: boolean
  showScrollButton: boolean
  messagesContainerRef: Ref<HTMLDivElement>
  messagesEndRef: RefObject<HTMLDivElement | null>
  scrollToBottom: () => void
  /** Jump the scroll container to a message by id (used by the conversation timeline). */
  scrollToMessage?: (messageId: string) => void
  chatConfig: {
    description?: string
  } | null
  setMessages?: Dispatch<SetStateAction<ChatMessage[]>>
  /** When set, "View in Knowledge Base" links are shown for refs whose workspaceId is in this list (user has workspace access) */
  workspaceIdsForKbLinks?: string[]
  /** When user selects text and clicks "Ask this in chat", this is called with the selected text */
  onAskInChat?: (text: string) => void
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
  /** When welcome message query chips are clicked, trigger execution with this query */
  onWelcomeQueryClick?: (text: string) => void
  /** Regenerate the last assistant response */
  onRegenerateMessage?: () => void
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return
  if (typeof ref === 'function') {
    return ref(value)
  }
  ref.current = value
}

export function ChatMessageContainer({
  messages,
  isLoading,
  isStreaming = false,
  showScrollButton,
  messagesContainerRef,
  messagesEndRef,
  scrollToBottom,
  scrollToMessage,
  chatConfig,
  setMessages,
  workspaceIdsForKbLinks,
  onAskInChat,
  onToggleGeneratedImage,
  selectedGeneratedImageIds,
  selectedGeneratedImageIdsKey,
  onWelcomeQueryClick,
  onRegenerateMessage,
}: ChatMessageContainerProps) {
  const [selectionTip, setSelectionTip] = useState<{
    text: string
    top: number
    left: number
  } | null>(null)
  const tipRef = useRef<HTMLButtonElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  const setScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollContainerRef.current = node
      return assignRef(messagesContainerRef, node)
    },
    [messagesContainerRef]
  )

  const handleMouseUp = useCallback(() => {
    if (!onAskInChat || !scrollContainerRef.current) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      setSelectionTip(null)
      return
    }
    const text = selection.toString().trim()
    if (!text) {
      setSelectionTip(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!range) return
    const rect = range.getBoundingClientRect()
    const container = scrollContainerRef.current
    const containerRect = container.getBoundingClientRect()
    if (
      rect.top < containerRect.top ||
      rect.bottom > containerRect.bottom ||
      rect.left < containerRect.left ||
      rect.right > containerRect.right
    ) {
      setSelectionTip(null)
      return
    }
    setSelectionTip({
      text,
      top: rect.top,
      left: rect.left,
    })
  }, [onAskInChat])

  const handleAskInChatClick = useCallback(() => {
    if (!selectionTip) return
    onAskInChat?.(selectionTip.text)
    window.getSelection()?.removeAllRanges()
    setSelectionTip(null)
  }, [selectionTip, onAskInChat])

  /**
   * Center the jumped-to message in the local scroller. Falls back to the
   * parent `scrollToMessage` helper when the DOM node is not found.
   */
  const handleTimelineJump = useCallback(
    (messageId: string) => {
      const container = scrollContainerRef.current
      const messageElement = container?.querySelector(`[data-message-id="${messageId}"]`)
      if (container && messageElement instanceof HTMLElement) {
        const containerRect = container.getBoundingClientRect()
        const messageRect = messageElement.getBoundingClientRect()
        const centeredTop =
          container.scrollTop +
          messageRect.top -
          containerRect.top -
          container.clientHeight / 2 +
          messageRect.height / 2

        container.scrollTo({
          top: Math.max(0, centeredTop),
          behavior: 'smooth',
        })
        return
      }

      scrollToMessage?.(messageId)
    },
    [scrollToMessage]
  )

  useEffect(() => {
    if (!onAskInChat) return
    const container = scrollContainerRef.current
    if (!container) return
    container.addEventListener('mouseup', handleMouseUp)
    return () => container.removeEventListener('mouseup', handleMouseUp)
  }, [onAskInChat, handleMouseUp, messages])

  useEffect(() => {
    if (!onAskInChat) return

    const handleSelectionChange = () => {
      const container = scrollContainerRef.current
      if (!container) return

      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        setSelectionTip(null)
        return
      }

      const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      const anchor = range?.commonAncestorContainer
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
      if (!anchorElement || !container.contains(anchorElement)) {
        setSelectionTip(null)
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [onAskInChat])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (tipRef.current && !tipRef.current.contains(e.target as Node)) {
        setSelectionTip(null)
      }
    }
    if (selectionTip) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [selectionTip])

  const showTimeline = Boolean(scrollToMessage) && shouldShowConversationTimeline(messages)

  return (
    <div className='relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]'>
      {selectionTip && onAskInChat && (
        <button
          ref={tipRef}
          type='button'
          onClick={handleAskInChatClick}
          className='fixed z-50 flex items-center gap-2 overflow-hidden rounded-lg border border-gray-200 bg-gradient-to-b from-white/60 via-gray-50 to-gray-100 px-3 py-2 font-semibold text-gray-800 shadow-md transition-colors hover:from-white/70 hover:via-gray-100 hover:to-gray-200 hover:text-gray-900'
          style={{
            top: selectionTip.top,
            left: selectionTip.left,
            transform: 'translateY(calc(-100% - 8px))',
          }}
        >
          <MessageCircle className='h-4 w-4 shrink-0 text-gray-700' />
          <span className='whitespace-nowrap text-base'>Ask this in chat</span>
        </button>
      )}

      <div
        ref={setScrollContainerRef}
        className={cn(
          '!scroll-smooth min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-auto',
          showTimeline && CONVERSATION_TIMELINE_GUTTER_CLASS
        )}
      >
        <div className='px-3 py-4 md:px-4'>
          <div className={`mx-auto w-full ${DEPLOYED_CHAT_CONTENT_MAX_WIDTH_CLASS} pb-8`}>
            {messages.length === 0 ? (
              <div className='flex min-h-full flex-col items-center justify-center py-10'>
                <div className='space-y-2 text-center'>
                  <h3 className='font-medium text-[var(--text-primary)] text-base'>
                    How can I help you today?
                  </h3>
                  <p className='text-[var(--text-muted)] text-sm'>
                    {chatConfig?.description || 'Ask me anything.'}
                  </p>
                </div>
              </div>
            ) : (
              (() => {
                const lastAssistantId = [...messages]
                  .reverse()
                  .find((m) => m.type === 'assistant' && !m.isInitialMessage)?.id
                return messages.map((message, index) => (
                  <div
                    key={message.id}
                    className={message.type === 'user' && index > 0 ? 'mt-10' : undefined}
                  >
                    <ArenaClientChatMessage
                      message={message}
                      setMessages={setMessages}
                      workspaceIdsForKbLinks={workspaceIdsForKbLinks}
                      onCopySegmentToInput={onAskInChat}
                      onToggleGeneratedImage={onToggleGeneratedImage}
                      selectedGeneratedImageIds={selectedGeneratedImageIds}
                      selectedGeneratedImageIdsKey={selectedGeneratedImageIdsKey}
                      onWelcomeQueryClick={onWelcomeQueryClick}
                      isLastAssistantMessage={message.id === lastAssistantId}
                      onRegenerateMessage={onRegenerateMessage}
                    />
                  </div>
                ))
              })()
            )}

            {isLoading &&
              !messages.some(
                (m) =>
                  m.type === 'assistant' &&
                  m.isStreaming &&
                  ((typeof m.thinking === 'string' && m.thinking.length > 0) ||
                    (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) ||
                    (Array.isArray(m.outputSegments) && m.outputSegments.length > 0))
              ) && <DeployedResponseLoader isStreaming={isStreaming} />}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {/* Shared ChatGPT-style tick timeline — gated on jump support. */}
      {scrollToMessage ? (
        <ConversationTimeline
          messages={messages}
          scrollContainerRef={scrollContainerRef}
          onJumpToMessage={handleTimelineJump}
        />
      ) : null}

      {showScrollButton && (
        <div className='-translate-x-1/2 absolute bottom-4 left-1/2 z-20 md:bottom-16'>
          <Button
            onClick={scrollToBottom}
            size='sm'
            className='gap-1 rounded-full px-3 shadow-medium'
          >
            <ArrowDown className='size-3.5' />
            <span className='sr-only'>Scroll to bottom</span>
          </Button>
        </div>
      )}
    </div>
  )
}
