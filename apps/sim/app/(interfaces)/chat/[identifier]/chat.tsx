'use client'

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { usePrefersReducedMotion } from '@sim/emcn'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import { useRouter } from 'next/navigation'
import { LoadingAgentP2 } from '@/components/ui/loading-agent-arena'
import { getCustomInputFields, normalizeInputFormatValue } from '@/lib/workflows/input-format-utils'
import {
  AGENT_STREAM_PROTOCOL_HEADER,
  AGENT_STREAM_PROTOCOL_V1,
  CHAT_OUTPUT_PROTOCOL_V1,
} from '@/lib/workflows/streaming/agent-stream-protocol'
import { DesktopTitleBarLane } from '@/app/_shell/desktop-title-bar'
import {
  ChatErrorState,
  ChatHeader,
  ChatInput,
  ChatLoadingState,
  type ChatMessage,
  ChatMessageContainer,
  EmailAuth,
  GoldenQueriesModal,
  PasswordAuth,
} from '@/app/(interfaces)/chat/components'
import { CHAT_ERROR_MESSAGES, CHAT_REQUEST_TIMEOUT_MS } from '@/app/(interfaces)/chat/constants'
import { StartBlockInputModal } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components'
import LeftNavThread from './leftNavThread'

// interface ChatConfig {
//   id: string
//   title: string
//   description: string
//   customizations: {
//     primaryColor?: string
//     logoUrl?: string
//     imageUrl?: string
//     welcomeMessage?: string
//     headerText?: string
//     goldenQueries?: Array<{ id?: string; query: string }>
//   }
//   authType?: 'public' | 'password' | 'email' | 'sso'
//   outputConfigs?: Array<{ blockId: string; path?: string }>
//   inputFormat?: InputFormatField[]
//   /** Workspace IDs the current user can access; when set, "View in Knowledge Base" links are shown for KB refs in that workspace */
//   userWorkspaceIds?: string[]
// }

interface ThreadRecord {
  chatId: string
  title: string
  workflowId: string
  createdAt: string
  updatedAt: string
}

import { useChatStreaming } from '@/app/(interfaces)/chat/hooks'
import SSOAuth from '@/ee/sso/components/sso-auth'
import { useDeployedChatConfig } from '@/hooks/queries/chats'
import { useGitHubStars } from '@/hooks/queries/github-stars'
import { useMobileViewport } from '@/hooks/use-mobile-viewport'

const logger = createLogger('ChatClient')

const NEAR_BOTTOM_THRESHOLD_PX = 100

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

interface ChatViewportProps {
  children: ReactNode
}

function ChatViewport({ children }: ChatViewportProps) {
  const ref = useRef<HTMLDivElement>(null)
  useMobileViewport({ ref })
  return (
    <div
      ref={ref}
      className='light desktop-title-bar-page fixed inset-0 z-[var(--z-dropdown)] flex flex-col bg-[var(--bg)] text-[var(--text-primary)] max-md:top-[var(--mobile-viewport-top,0px)] max-md:bottom-auto max-md:h-[var(--mobile-viewport-height,100dvh)] max-md:min-h-0!'
    >
      {children}
    </div>
  )
}

export default function ChatClient({ identifier }: { identifier: string }) {
  const router = useRouter()
  const prefersReducedMotion = usePrefersReducedMotion()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [conversationId] = useState(() => generateId())

  // Left threads state managed here
  const [currentChatId, setCurrentChatId] = useState<string | null>(identifier)
  const [threads, setThreads] = useState<ThreadRecord[]>([])
  const [isThreadsLoading, setIsThreadsLoading] = useState<boolean>(true)
  const [threadsError, setThreadsError] = useState<string | null>(null)
  const [isHistoryLoading, setIsHistoryLoading] = useState<any>(false)
  const [isConversationFinished, setIsConversationFinished] = useState<any>(false)

  const [showScrollButton, setShowScrollButton] = useState(false)
  /** ChatGPT-style: follow new tokens only while the viewport is near the bottom. */
  const stickToBottomRef = useRef(true)
  const ignoreScrollRef = useRef(false)

  // Start Block input modal state
  const [isInputModalOpen, setIsInputModalOpen] = useState(false)
  const [startBlockInputs, setStartBlockInputs] = useState<Record<string, unknown>>({})
  const hasShownModalRef = useRef<boolean>(false)

  const [isGoldenQueriesOpen, setIsGoldenQueriesOpen] = useState(false)
  const [goldenQueries, setGoldenQueries] = useState<Array<{ id?: string; query: string }>>([])
  const [isGoldenQueriesSaving, setIsGoldenQueriesSaving] = useState(false)
  const [askInChatText, setAskInChatText] = useState('')

  const { data: chatConfigResult, error: chatConfigError } = useDeployedChatConfig(identifier)
  const { data: starCount } = useGitHubStars()

  const authRequired = chatConfigResult?.kind === 'auth' ? chatConfigResult.authType : null
  const chatConfig = chatConfigResult?.kind === 'config' ? chatConfigResult.config : null

  const welcomeMessage = chatConfig?.customizations?.welcomeMessage
  const welcomeChatMessage = useMemo<ChatMessage | null>(
    () =>
      welcomeMessage
        ? {
            id: 'welcome',
            content: welcomeMessage,
            type: 'assistant',
            timestamp: new Date(),
            isInitialMessage: true,
          }
        : null,
    [welcomeMessage]
  )
  const displayMessages: ChatMessage[] = welcomeChatMessage
    ? [welcomeChatMessage, ...messages]
    : messages

  const { isStreamingResponse, abortControllerRef, stopStreaming, handleStreamedResponse } =
    useChatStreaming()

  /**
   * ChatGPT-style scroll. Without `force`, no-ops when the user has scrolled away.
   * With `force` (jump button), re-pins to bottom.
   */
  const scrollToBottom = (options?: { behavior?: ScrollBehavior; force?: boolean }) => {
    const behavior = prefersReducedMotion ? 'auto' : (options?.behavior ?? 'smooth')
    const force = options?.force === true
    if (!force && !stickToBottomRef.current) return
    if (!messagesEndRef.current) return

    if (force) {
      stickToBottomRef.current = true
      setShowScrollButton(false)
    }

    ignoreScrollRef.current = true
    messagesEndRef.current.scrollIntoView({ behavior })
    window.setTimeout(
      () => {
        ignoreScrollRef.current = false
      },
      behavior === 'smooth' ? 400 : 50
    )
  }

  useEffect(() => {
    const incoming = chatConfig?.customizations?.goldenQueries ?? []
    const normalized = incoming.map((item: any) =>
      typeof item === 'string' ? { query: item } : item
    )
    setGoldenQueries(normalized)
  }, [chatConfig?.customizations?.goldenQueries])

  // Fetch history messages
  useEffect(() => {
    const workflowId = identifier

    const fetchHistory = async (workflowId: string, chatId: string | null) => {
      // Only fetch history if we have a chatId
      if (!chatId) {
        setIsHistoryLoading(false)
        return
      }

      try {
        setIsHistoryLoading(true)
        const response = await fetch(`/api/chat/${workflowId}/history?chatId=${chatId}`)
        if (response.ok) {
          const data = await response.json()

          if (data?.logs?.length === 0) {
            setIsHistoryLoading(false)
          } else {
            // Flatten and process logs as before
            setMessages([
              ...(chatConfig?.customizations?.welcomeMessage
                ? [
                    {
                      id: 'welcome',
                      content: chatConfig.customizations.welcomeMessage,
                      type: 'assistant',
                      isInitialMessage: true,
                      timestamp: new Date(),
                    },
                  ]
                : []),
              ...data.logs.flatMap((log: any) => {
                const messages = []
                if (log.userInput) {
                  messages.push({
                    id: `${log.id}-user`,
                    content: log.userInput,
                    type: 'user',
                    timestamp: new Date(log.startedAt),
                  })
                }
                if (log.modelOutput) {
                  messages.push({
                    id: `${log.id}-assistant`,
                    content: log.modelOutput,
                    type: 'assistant',
                    timestamp: new Date(log.endedAt || log.startedAt),
                    isStreaming: false,
                    executionId: log?.executionId || '',
                    liked: log.liked,
                    knowledgeRefs: Array.isArray(log.knowledgeRefs) ? log.knowledgeRefs : undefined,
                  })
                }
                return messages
              }),
            ])
            // Reset modal ref when messages are loaded
            hasShownModalRef.current = false
            setTimeout(() => {
              setTimeout(() => {
                scrollToBottom()
              }, 100)
            }, 500)
            setIsHistoryLoading(false)
          }
        } else {
          // If history fetch fails (404, etc.), treat as no history to show input form
          logger.warn(`History fetch failed with status ${response.status}, treating as no history`)
          setIsHistoryLoading(false)
        }
      } catch (error) {
        // If history fetch errors, treat as no history to show input form
        logger.error('Error fetching history, treating as no history:', error)
        setIsHistoryLoading(false)
      }
    }

    if (workflowId && Object.keys(chatConfig || {}).length > 0 && currentChatId) {
      fetchHistory(workflowId, currentChatId)
    } else if (workflowId && Object.keys(chatConfig || {}).length > 0 && !currentChatId) {
      // Chat config loaded but no chatId yet - mark as no history to show input form
      setIsHistoryLoading(false)
    }
  }, [identifier, chatConfig, currentChatId])

  const scrollToMessage = (messageId: string) => {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`)
    if (!messageElement || !messagesContainerRef.current) return

    const container = messagesContainerRef.current
    const containerRect = container.getBoundingClientRect()
    const messageRect = messageElement.getBoundingClientRect()

    container.scrollTo({
      top: container.scrollTop + messageRect.top - containerRect.top,
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    })
  }

  /**
   * Attaches on mount via a ref callback rather than an effect: the container
   * renders only after the auth/loading early returns, so an effect would need
   * unrelated render values as a stand-in for "the node exists yet".
   */
  const attachMessagesContainer = useCallback((node: HTMLDivElement | null) => {
    messagesContainerRef.current = node
    if (!node) return

    const handleScroll = () => {
      if (ignoreScrollRef.current) return
      const { scrollTop, scrollHeight, clientHeight } = node
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      const nearBottom = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX
      stickToBottomRef.current = nearBottom
      setShowScrollButton(!nearBottom)
    }

    node.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      node.removeEventListener('scroll', handleScroll)
      messagesContainerRef.current = null
    }
  }, [])

  const fetchChatConfig = async () => {
    try {
      // boundary-raw-fetch: reads the 401 error body to decide auth UI (requestJson's thrown error does not expose structured error codes)
      const response = await fetch(`/api/chat/${identifier}`, {
        credentials: 'same-origin',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      })

      if (!response.ok) {
        // Check if auth is required or unauthorized
        if (response.status === 401 || response.status === 403) {
          const errorData = await response.json()

          // If user email is not authorized, show error and redirect
          if (
            errorData.error === 'Email not authorized' ||
            errorData.message === 'Email not authorized' ||
            errorData.error === 'You do not have access to this chat' ||
            errorData.message === 'You do not have access to this chat'
          ) {
            // Redirect after 3 seconds
            setTimeout(() => {
              if (typeof window !== 'undefined') {
                window.history.back()
              }
            }, 3000)
            return
          }
        }

        throw new Error(`Failed to load chat configuration: ${response.status}`)
      }

      const data = await response.json()

      if (data?.customizations?.welcomeMessage) {
        setMessages([
          {
            id: 'welcome',
            content: data.customizations.welcomeMessage,
            type: 'assistant',
            timestamp: new Date(),
            isInitialMessage: true,
          },
        ])
      }

      // Check if we should show modal on load (no messages and has inputFormat)
      if (data.inputFormat && Array.isArray(data.inputFormat) && data.inputFormat.length > 0) {
        const customFields = getCustomInputFields(data.inputFormat)

        if (customFields.length > 0 && messages.length === 0 && !hasShownModalRef.current) {
          hasShownModalRef.current = true
          setIsInputModalOpen(true)
        }
      }
    } catch (error) {
      logger.error('Error fetching chat config:', error)
    }
  }

  useEffect(() => {
    fetchChatConfig()
  }, [identifier])

  const handleSendMessage = async (
    messageToSend: string,
    files?: Array<{
      id: string
      name: string
      size: number
      type: string
      file: File
      dataUrl?: string
    }>,
    forceExecution = false, // Allow execution even with empty input (e.g., when form is submitted)
    overrideValues?: Record<string, unknown> // Override values for Start Block inputs (e.g., from form submission)
  ) => {
    // Allow execution if forceExecution is true (form submission) or if there's input/files
    if ((!messageToSend.trim() && (!files || files.length === 0) && !forceExecution) || isLoading)
      return

    logger.info('Sending message:', {
      messageToSend,
      conversationId,
      filesCount: files?.length,
    })

    stickToBottomRef.current = true
    setShowScrollButton(false)

    let userMessageId: string | null = null
    const userMessage: ChatMessage = {
      id: generateId(),
      content: messageToSend || (files && files.length > 0 ? `Sent ${files.length} file(s)` : ''),
      type: 'user',
      timestamp: new Date(),
      attachments: files?.map((file) => ({
        id: file.id,
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: file.dataUrl || '',
      })),
    }
    userMessageId = userMessage.id

    // Add the user's message to the chat
    setMessages((prev) => [...prev, userMessage])
    setIsLoading(true)

    // Scroll to show only the user's message and loading indicator (if message exists)
    if (userMessageId) {
      setTimeout(() => {
        scrollToMessage(userMessageId!)
      }, 100)
    }

    // One AbortController for fetch + SSE body reads so Stop cancels server work too.
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    const timeoutId = setTimeout(() => {
      abortController.abort()
    }, CHAT_REQUEST_TIMEOUT_MS)

    try {
      // Build complete workflow input with all Start Block fields
      // Use messageToSend directly (may be empty if form was submitted)
      // Pass overrideValues if provided (e.g., from form submission)
      const completeInput = buildCompleteWorkflowInput(
        messageToSend,
        conversationId,
        files,
        overrideValues
      )

      // Send structured payload to maintain chat context
      // Always include all Start Block inputs (even if empty) to ensure all fields are passed
      const startBlockInputsPayload: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(completeInput)) {
        if (key !== 'input' && key !== 'conversationId' && key !== 'files') {
          // Always include field, even if empty string - ensures all inputFormat fields are passed
          startBlockInputsPayload[key] = value
        }
      }

      logger.debug('Building payload with Start Block inputs:', {
        hasCustomFields: customFields.length > 0,
        startBlockInputsKeys: Object.keys(startBlockInputsPayload),
        completeInputKeys: Object.keys(completeInput),
      })

      const payload: any = {
        input: completeInput.input,
        conversationId: completeInput.conversationId,
        // Always include startBlockInputs if there are any custom fields in inputFormat
        // This ensures all Start Block fields are passed to execution, even if empty
        startBlockInputs: customFields.length > 0 ? startBlockInputsPayload : undefined,
      }

      if (files && files.length > 0) {
        payload.files = await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            size: file.size,
            type: file.type,
            data: file.dataUrl || (await fileToBase64(file.file)),
          }))
        )
      }

      logger.info('API payload:', {
        ...payload,
        files: payload.files ? `${payload.files.length} files` : undefined,
      })

      // boundary-raw-fetch: deployed chat endpoint returns an SSE stream consumed by handleStreamedResponse via response.body.getReader()
      const response = await fetch(`/api/chat/${identifier}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          [AGENT_STREAM_PROTOCOL_HEADER]: `${AGENT_STREAM_PROTOCOL_V1}, ${CHAT_OUTPUT_PROTOCOL_V1}`,
        },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        signal: abortController.signal,
      })

      // Clear timeout immediately once we get a response - the SSE stream will continue
      // until completion regardless of how long it takes
      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorData = await response.json()
        logger.error('API error response:', errorData)
        throw new Error(errorData.error || 'Failed to get response')
      }

      if (!response.body) {
        throw new Error('Response body is missing')
      }

      setIsConversationFinished(true)

      await handleStreamedResponse(
        response,
        setMessages,
        setIsLoading,
        () => scrollToBottom({ behavior: 'auto' }),
        {
          outputConfigs: chatConfig?.outputConfigs,
          abortController,
        }
      )
    } catch (error) {
      clearTimeout(timeoutId)

      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('Request aborted by user or timeout')
        setIsLoading(false)
        return
      }

      logger.error('Error sending message:', error)
      setIsLoading(false)
      const errorMessage: ChatMessage = {
        id: generateId(),
        content: CHAT_ERROR_MESSAGES.GENERIC_ERROR,
        type: 'assistant',
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, errorMessage])
    }
  }

  const handleWelcomeQueryClick = useCallback(
    (query: string) => {
      const trimmedQuery = query.trim()
      if (!trimmedQuery || isLoading || isStreamingResponse) return
      void handleSendMessage(trimmedQuery)
    },
    [handleSendMessage, isLoading, isStreamingResponse]
  )

  const handleGoldenQuerySelect = useCallback(
    (query: string) => {
      setIsGoldenQueriesOpen(false)
      void handleSendMessage(query)
    },
    [handleSendMessage]
  )

  const handleSaveGoldenQueries = useCallback(
    async (nextQueries: Array<{ id?: string; query: string }>, mode: 'hard' | 'soft') => {
      if (!identifier) {
        throw new Error('No chat identifier available')
      }

      setIsGoldenQueriesSaving(true)

      try {
        const response = await fetch(`/api/chat/${identifier}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ goldenQueries: nextQueries, deleteMode: mode }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.error || 'Failed to save golden queries')
        }

        setGoldenQueries(nextQueries)
      } catch (error: any) {
        logger.error('Error saving golden queries:', error)
        throw error
      } finally {
        setIsGoldenQueriesSaving(false)
      }
    },
    [identifier]
  )

  // Get custom fields from inputFormat (excluding reserved fields: input, conversationId, files)
  const customFields = useMemo(() => {
    return getCustomInputFields(chatConfig?.inputFormat)
  }, [chatConfig?.inputFormat])

  /**
   * Builds complete workflow input with all Start Block fields (including reserved ones)
   * Ensures all fields from inputFormat are present, with empty values when not provided
   */
  const buildCompleteWorkflowInput = useCallback(
    (
      userInput: string,
      conversationId: string,
      files?: Array<{
        id: string
        name: string
        size: number
        type: string
        file: File
        dataUrl?: string
      }>,
      overrideValues?: Record<string, unknown>
    ): Record<string, unknown> => {
      const normalizedFields = normalizeInputFormatValue(chatConfig?.inputFormat)
      const completeInput: Record<string, unknown> = {}

      // Read values from Start Block inputFormat field values (field.value)
      // Priority: overrideValues (temporary) > field.value (persisted) > startBlockInputs (state) > empty string
      for (const field of normalizedFields) {
        const fieldName = field.name?.trim()
        if (fieldName) {
          if (overrideValues && fieldName in overrideValues) {
            completeInput[fieldName] = overrideValues[fieldName] ?? ''
          } else if (field.value !== undefined && field.value !== null) {
            // Use the value from Start Block inputFormat field (persisted value)
            completeInput[fieldName] = field.value
          } else {
            // Fallback to state or empty string
            completeInput[fieldName] = startBlockInputs[fieldName] ?? ''
          }
        }
      }

      // Override with actual values for reserved fields
      completeInput.input = userInput
      completeInput.conversationId = conversationId

      // Handle files - only include if present
      if (files && files.length > 0) {
        // Files will be added separately in the payload
      }

      return completeInput
    },
    [chatConfig?.inputFormat, startBlockInputs]
  )

  /**
   * Handles Start Block input modal submission
   * Stores the values and immediately triggers workflow execution
   */
  const handleStartBlockInputsSubmit = useCallback(
    async (values: Record<string, unknown>) => {
      // Store the form values in local state
      setStartBlockInputs(values)
      setIsInputModalOpen(false)

      // Build complete workflow input with all Start Block fields
      // Pass empty string for input (user submitted form, not typed message)
      const completeInput = buildCompleteWorkflowInput('', conversationId, undefined, values)

      // Ensure input is explicitly empty string when submitting form
      completeInput.input = ''

      // Trigger workflow execution by sending a message with empty input
      // but with all Start Block inputs included
      // Pass values as overrideValues to ensure they're used immediately
      try {
        await handleSendMessage('', undefined, true, values) // forceExecution = true, overrideValues = values
      } catch (error) {
        logger.error('Error executing workflow from modal submit:', error)
      }
    },
    [buildCompleteWorkflowInput, conversationId, handleSendMessage]
  )

  // Handle Re-run button click
  const handleRerun = useCallback(() => {
    setIsInputModalOpen(true)
  }, [])

  const fetchThreads = useCallback(
    async (workflowId: string, isInitialLoad = false) => {
      try {
        if (isInitialLoad) {
          setIsThreadsLoading(true)
        }
        setThreadsError(null)
        const response = await fetch(`/api/chat/${workflowId}/all-history`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        })
        if (!response.ok) {
          throw new Error(`Failed to fetch threads: ${response.status}`)
        }
        const data = (await response.json()) as { records: ThreadRecord[]; total: number }
        const list = data.records || []
        setThreads(list)

        // Only handle initial navigation on first load
        if (isInitialLoad) {
          const params = new URLSearchParams(window.location.search)
          const urlChatId = params.get('chatId')

          // If no chatId in URL, decide default
          if (!urlChatId) {
            if (list.length > 0) {
              const firstId = list[0].chatId
              setCurrentChatId(firstId)
              params.set('chatId', firstId)
              const newUrl = `/chat/${workflowId}?${params.toString()}`
              router.replace(newUrl)
            } else {
              // No threads exist yet: generate a new UUID chatId for a fresh chat
              const newId = generateId()
              setCurrentChatId(newId)
              params.set('chatId', newId)
              const newUrl = `/chat/${workflowId}?${params.toString()}`
              router.replace(newUrl)
            }
          }
        }
      } catch (err) {
        logger.error('Error fetching threads:', err)
        setThreadsError(err instanceof Error ? err.message : 'Failed to fetch threads')
        setThreads([])
      } finally {
        setIsThreadsLoading(false)
      }
    },
    [router]
  )

  useEffect(() => {
    if (identifier && chatConfig && !authRequired) {
      fetchThreads(identifier, true)
    }
  }, [identifier, fetchThreads, chatConfig, authRequired])

  // Check if current chatId exists in threads when conversation is finished
  useEffect(() => {
    if (isConversationFinished && currentChatId) {
      const chatIdExists = threads.some((thread) => thread.chatId === currentChatId)

      if (!chatIdExists) {
        fetchThreads(identifier, false)
      }
      // Reset the flag
      setIsConversationFinished(false)
    }
  }, [isConversationFinished, currentChatId, threads, fetchThreads, identifier])

  const updateUrlChatId = useCallback(
    (newChatId: string) => {
      const params = new URLSearchParams(window.location.search)
      params.set('chatId', newChatId)
      const newUrl = `/chat/${identifier}?${params.toString()}`
      // Replace so browser Back leaves the deployed chat (e.g. to Arena hub),
      // matching Exit Agent — do not push a chatId-only history entry.
      router.replace(newUrl)
    },
    [router, identifier]
  )

  // Handle thread selection - must be defined before conditional returns
  const handleSelectThread = useCallback(
    (chatId: string) => {
      if (currentChatId === chatId) return
      setShowScrollButton(false)
      setCurrentChatId(chatId)
      // Clear messages except welcome
      setMessages((prev) => {
        const welcome = prev.find((m) => (m as any).isInitialMessage)
        return welcome ? [welcome] : []
      })
      updateUrlChatId(chatId)
    },
    [currentChatId]
  )

  const handleNewChat = useCallback(() => {
    setShowScrollButton(false)
    const id = generateId()
    setCurrentChatId(id)
    // Clear messages except welcome
    setMessages((prev) => {
      const welcome = prev.find((m) => (m as any).isInitialMessage)
      return welcome ? [welcome] : []
    })
    updateUrlChatId(id)
    // Clear form input values for new chat
    setStartBlockInputs({})
    // Open input modal if custom fields exist
    const hasCustomFields = getCustomInputFields(chatConfig?.inputFormat).length > 0
    if (hasCustomFields) {
      setIsInputModalOpen(true)
    }
  }, [updateUrlChatId, chatConfig?.inputFormat])

  const handleViewGoldenQueries = useCallback(() => {
    setIsGoldenQueriesOpen(true)
  }, [])

  // If error, show error message using the extracted component
  if (chatConfigError) {
    logger.error('Error fetching chat config:', chatConfigError)
    return <ChatErrorState error={CHAT_ERROR_MESSAGES.CHAT_UNAVAILABLE} />
  }

  if (authRequired) {
    if (authRequired === 'password') {
      return <PasswordAuth identifier={identifier} />
    }
    if (authRequired === 'email') {
      return <EmailAuth identifier={identifier} />
    }
    if (authRequired === 'sso') {
      return <SSOAuth identifier={identifier} />
    }
  }

  if (!chatConfig) {
    return <ChatLoadingState />
  }

  return (
    <ChatViewport>
      {isHistoryLoading && (
        <div className='absolute top-[72px] left-[276px] z-[105] flex h-[calc(100vh-85px)] w-[calc(100vw-286px)] items-center justify-center bg-white/60 pb-[6%]'>
          <LoadingAgentP2 size='lg' />
        </div>
      )}
      <DesktopTitleBarLane />
      <ChatHeader chatConfig={chatConfig} starCount={starCount} />

      <LeftNavThread
        threads={threads}
        isLoading={isThreadsLoading}
        error={threadsError || null}
        currentChatId={currentChatId || ''}
        onSelectThread={handleSelectThread}
        onNewChat={handleNewChat}
        isStreaming={isStreamingResponse || isLoading}
        showReRun={customFields.length > 0}
        onReRun={handleRerun}
        onViewGoldenQueries={handleViewGoldenQueries}
      />

      {/* Message Container component */}
      <ChatMessageContainer
        messages={displayMessages}
        isLoading={isLoading}
        isStreaming={isStreamingResponse}
        showScrollButton={showScrollButton}
        messagesContainerRef={attachMessagesContainer}
        messagesEndRef={messagesEndRef as RefObject<HTMLDivElement>}
        scrollToBottom={() => scrollToBottom({ behavior: 'smooth', force: true })}
        chatConfig={chatConfig}
        workspaceIdsForKbLinks={chatConfig?.userWorkspaceIds}
        onAskInChat={(text) => setAskInChatText(text)}
        onWelcomeQueryClick={handleWelcomeQueryClick}
      />

      <div className='relative shrink-0 md:p-4 md:pb-6'>
        <div className='relative mx-auto max-w-3xl md:max-w-[748px]'>
          <ChatInput
            onSubmit={(value, _isVoiceInput, files) => {
              void handleSendMessage(value, files)
            }}
            isStreaming={isStreamingResponse}
            onStopStreaming={() => stopStreaming(setMessages)}
            insertText={askInChatText}
            onInsertConsumed={() => setAskInChatText('')}
          />
        </div>
      </div>

      {/* Start Block Input Modal */}
      {customFields.length > 0 && (
        <StartBlockInputModal
          open={isInputModalOpen}
          onOpenChange={setIsInputModalOpen}
          inputFormat={chatConfig.inputFormat}
          onSubmit={handleStartBlockInputsSubmit}
          initialValues={startBlockInputs}
        />
      )}

      <GoldenQueriesModal
        open={isGoldenQueriesOpen}
        onOpenChange={setIsGoldenQueriesOpen}
        queries={goldenQueries}
        onSelectQuery={handleGoldenQuerySelect}
        onSaveQueries={handleSaveGoldenQueries}
        disabled={isStreamingResponse || isLoading || isGoldenQueriesSaving}
      />
    </ChatViewport>
  )
}
