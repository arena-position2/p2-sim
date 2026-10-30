'use client'

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ToastProvider, toast } from '@sim/emcn'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { generateId } from '@sim/utils/id'
import { useRouter } from 'next/navigation'
import { client } from '@/lib/auth/client'
import { useGeneratedImageReuse } from '@/lib/chat/use-generated-image-reuse'
import { getCustomInputFields, normalizeInputFormatValue } from '@/lib/workflows/input-format-utils'
import {
  AGENT_STREAM_PROTOCOL_HEADER,
  AGENT_STREAM_PROTOCOL_V1,
} from '@/lib/workflows/streaming/agent-stream-protocol'
import type { InputFormatField } from '@/lib/workflows/types'
import {
  ChatErrorState,
  ChatInput,
  ChatLoadingState,
  type ChatMessage,
  ChatMessageContainer,
  EmailAuth,
  GoldenQueriesModal,
  PasswordAuth,
  // SSOAuth,
  UnauthorizedEmailError,
} from '@/app/(interfaces)/chat/components'
import arenaLogo from '@/app/(interfaces)/chat/components/message/components/ArenaLogo.svg'
import { DeployedResponseLoader } from '@/app/(interfaces)/chat/components/message/components/deployed-response-loader'
import {
  CHAT_ERROR_MESSAGES,
  CHAT_REQUEST_TIMEOUT_MS,
  DEPLOYED_CHAT_CONTENT_MAX_WIDTH_CLASS,
  DEPLOYED_CHAT_INPUT_PLACEHOLDER,
} from '@/app/(interfaces)/chat/constants'
import { useChatKeyboardShortcuts, useChatStreaming } from '@/app/(interfaces)/chat/hooks'
import { downloadTextFile, exportChatAsMarkdown } from '@/app/(interfaces)/chat/utils/export-chat'
// import { getFormattedGitHubStars } from '@/app/(landing)/actions/github'
import {
  deployedChatPromptSentEvent,
  deployedChatThreadSelectedEvent,
  deployedNewChatEvent,
} from '@/app/arenaMixpanelEvents/mixpanelEvents'
import { StartBlockInputModal } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components'
import { useBrandConfig } from '@/ee/whitelabeling/branding'
import {
  useDeleteDeployedChatThread,
  useDeployedChatThreads,
  useRenameDeployedChatThread,
  useSetDeployedChatThreadPinned,
} from '@/hooks/queries/deployed-chat-threads'
import { DeployedChatLanding } from './DeployedChatLanding'
import { FeedbackView } from './FeedbackView'
import LeftNavThread, { type ThreadRecord } from './leftNavThread'

const logger = createLogger('ChatClient')

interface ChatConfig {
  id: string
  title: string
  description: string
  customizations: {
    primaryColor?: string
    logoUrl?: string
    imageUrl?: string
    welcomeMessage?: string
    headerText?: string
    goldenQueries?: Array<{ id?: string; query: string }>
  }
  authType?: 'public' | 'password' | 'email' | 'sso'
  outputConfigs?: Array<{ blockId: string; path?: string }>
  inputFormat?: InputFormatField[]
  /** Workspace IDs the current user can access; when set, "View in Knowledge Base" links are shown for KB refs in that workspace */
  userWorkspaceIds?: string[]
}

interface ChatFilePayload {
  name: string
  size: number
  type: string
  data?: string
  url?: string
}

/**
 * Builds the chat API file payload. Images already on this app are sent by URL so we do not
 * re-embed multi-megabyte base64 blobs in the JSON body.
 */
async function buildChatFilePayload(file: {
  name: string
  size: number
  type: string
  file: File
  dataUrl?: string
  url?: string
}): Promise<ChatFilePayload> {
  const normalizedSize = file.size > 0 ? file.size : 1
  const dataUrl = file.dataUrl?.trim() ?? ''
  const directUrl = file.url?.trim() ?? ''
  const serveUrl = [directUrl, dataUrl].find((value) => value.includes('/api/files/serve/'))
  if (serveUrl) {
    const url = serveUrl.startsWith('http')
      ? serveUrl
      : `${window.location.origin}${serveUrl.startsWith('/') ? serveUrl : `/${serveUrl}`}`
    return {
      name: file.name,
      size: normalizedSize,
      type: file.type,
      url,
    }
  }

  return {
    name: file.name,
    size: normalizedSize,
    type: file.type,
    data: dataUrl || (await fileToBase64(file.file)),
  }
}

/**
 * Converts a File object to a base64 data URL
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function throttle<T extends (...args: any[]) => any>(func: T, delay: number): T {
  let timeoutId: NodeJS.Timeout | null = null
  let lastExecTime = 0

  return ((...args: Parameters<T>) => {
    const currentTime = Date.now()

    if (currentTime - lastExecTime > delay) {
      func(...args)
      lastExecTime = currentTime
    } else {
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(
        () => {
          func(...args)
          lastExecTime = Date.now()
        },
        delay - (currentTime - lastExecTime)
      )
    }
  }) as T
}

export default function ChatClient({ identifier }: { identifier: string }) {
  const router = useRouter()
  const brand = useBrandConfig()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const threadSearchInputRef = useRef<HTMLInputElement>(null)
  const chatInputWrapperRef = useRef<HTMLDivElement>(null)
  const [conversationId, setConversationId] = useState('')

  const [currentChatId, setCurrentChatId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('chatId')
  })
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('deployed-chat-sidebar-collapsed') === 'true'
  })
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  const [isHistoryLoading, setIsHistoryLoading] = useState<any>(true) // Start as true to prevent early modal
  const [isConversationFinished, setIsConversationFinished] = useState<any>(false)
  const [hasCheckedHistory, setHasCheckedHistory] = useState<boolean>(false)
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)

  const [showScrollButton, setShowScrollButton] = useState(false)
  const isUserScrollingRef = useRef(false)

  const [authRequired, setAuthRequired] = useState<'password' | 'email' | 'sso' | null>(null)

  const threadsQuery = useDeployedChatThreads(identifier, Boolean(chatConfig) && !authRequired)
  const threads = threadsQuery.data ?? []
  const isThreadsLoading = threadsQuery.isLoading
  const threadsError = threadsQuery.error?.message ?? null
  const sidebarLogoUrl = useMemo(
    () =>
      chatConfig?.customizations?.logoUrl ||
      chatConfig?.customizations?.imageUrl ||
      brand.logoUrl ||
      arenaLogo,
    [chatConfig, brand.logoUrl]
  )
  const renameThreadMutation = useRenameDeployedChatThread(identifier)
  const deleteThreadMutation = useDeleteDeployedChatThread(identifier)
  const pinThreadMutation = useSetDeployedChatThreadPinned(identifier)

  // Start Block input modal state
  const [isInputModalOpen, setIsInputModalOpen] = useState(false)
  const [startBlockInputs, setStartBlockInputs] = useState<Record<string, unknown>>({})
  const hasShownModalRef = useRef<boolean>(false)
  const hasInitializedThreadNavigationRef = useRef(false)
  const historyAbortRef = useRef<AbortController | null>(null)
  const historyRequestChatIdRef = useRef<string | null>(null)
  const hasNonWelcomeMessages = useMemo(
    () => messages.some((message) => !message.isInitialMessage),
    [messages]
  )

  const { isStreamingResponse, stopStreaming, handleStreamedResponse } = useChatStreaming()

  const [chatDepartment, setChatDepartment] = useState<string | null>('Default')

  // Feedback view state
  const [showFeedbackView, setShowFeedbackView] = useState(false)
  const [feedbackData, setFeedbackData] = useState<any[]>([])
  const [isFeedbackLoading, setIsFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [feedbackPage, setFeedbackPage] = useState(1)
  const [feedbackPageSize] = useState(10)
  const [feedbackTotalPages, setFeedbackTotalPages] = useState(1)
  const [feedbackTotalCount, setFeedbackTotalCount] = useState(0)
  const [isGoldenQueriesOpen, setIsGoldenQueriesOpen] = useState(false)
  const [goldenQueries, setGoldenQueries] = useState<Array<{ id?: string; query: string }>>([])
  const [isGoldenQueriesSaving, setIsGoldenQueriesSaving] = useState(false)
  const [askInChatText, setAskInChatText] = useState('')
  const [userName, setUserName] = useState<string | null>(null)

  const showLandingView = useMemo(() => {
    if (showFeedbackView) return false

    const isExistingThread = Boolean(
      currentChatId && threads.some((thread) => thread.chatId === currentChatId)
    )
    if (isExistingThread && (isHistoryLoading || !hasCheckedHistory)) {
      return false
    }

    return !hasNonWelcomeMessages
  }, [
    showFeedbackView,
    hasNonWelcomeMessages,
    currentChatId,
    threads,
    isHistoryLoading,
    hasCheckedHistory,
  ])

  const isUnsavedChat = useMemo(() => {
    if (!currentChatId) return false
    return !threads.some((thread) => thread.chatId === currentChatId)
  }, [currentChatId, threads])

  const isNewChatActive = isUnsavedChat && !showFeedbackView && !isGoldenQueriesOpen

  const scrollToBottom = useCallback(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [])

  useEffect(() => {
    const incoming = chatConfig?.customizations?.goldenQueries ?? []
    const normalized = incoming.map((item: any) =>
      typeof item === 'string' ? { query: item } : item
    )
    setGoldenQueries(normalized)
  }, [chatConfig?.customizations?.goldenQueries])

  const {
    effectiveGeneratedImages,
    selectedGeneratedImageIds,
    selectedGeneratedImageIdsKey,
    toggleGeneratedImageSelection,
    removeSelectedGeneratedImage,
    clearSelectedGeneratedImages,
    materializeSelectedGeneratedImages,
  } = useGeneratedImageReuse(messages)

  const scrollToMessage = useCallback(
    (messageId: string, scrollToShowOnlyMessage = false) => {
      const messageElement = document.querySelector(`[data-message-id="${messageId}"]`)
      if (messageElement && messagesContainerRef.current) {
        const container = messagesContainerRef.current
        const containerRect = container.getBoundingClientRect()
        const messageRect = messageElement.getBoundingClientRect()

        if (scrollToShowOnlyMessage) {
          const scrollTop = container.scrollTop + messageRect.top - containerRect.top

          container.scrollTo({
            top: scrollTop,
            behavior: 'smooth',
          })
        } else {
          const scrollTop = container.scrollTop + messageRect.top - containerRect.top - 80

          container.scrollTo({
            top: scrollTop,
            behavior: 'smooth',
          })
        }
      }
    },
    [messagesContainerRef]
  )

  const handleScroll = useCallback(
    throttle(() => {
      const container = messagesContainerRef.current
      if (!container) return

      const { scrollTop, scrollHeight, clientHeight } = container
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      setShowScrollButton(distanceFromBottom > 100)
    }, 100),
    [messagesContainerRef]
  )

  // Fetch history messages
  useEffect(() => {
    const workflowId = identifier

    const buildWelcomeMessages = (): ChatMessage[] => {
      const initialMessages: ChatMessage[] = []

      if (userName) {
        initialMessages.push({
          id: 'greeting',
          content: `Hi ${userName}, welcome to the chat!`,
          type: 'assistant',
          timestamp: new Date(),
          isInitialMessage: true,
        })
      }

      if (chatConfig?.customizations?.welcomeMessage) {
        initialMessages.push({
          id: 'welcome',
          content: chatConfig.customizations.welcomeMessage,
          type: 'assistant',
          isInitialMessage: true,
          timestamp: new Date(),
        })
      }

      return initialMessages
    }

    const applyHistoryResult = (
      requestChatId: string,
      nextMessages: ChatMessage[],
      hasHistory: boolean
    ) => {
      if (historyRequestChatIdRef.current !== requestChatId) return
      setMessages(nextMessages)
      hasShownModalRef.current = hasHistory
      setIsHistoryLoading(false)
      setHasCheckedHistory(true)
    }

    const fetchHistory = async (workflowId: string, chatId: string, signal: AbortSignal) => {
      const requestChatId = chatId
      historyRequestChatIdRef.current = requestChatId

      try {
        setIsHistoryLoading(true)
        const response = await fetch(`/api/chat/${workflowId}/history?chatId=${chatId}`, {
          signal,
        })

        if (signal.aborted || historyRequestChatIdRef.current !== requestChatId) return

        if (response.ok) {
          const data = await response.json()

          if (data?.logs?.length === 0) {
            applyHistoryResult(requestChatId, buildWelcomeMessages(), false)
          } else {
            const initialMessages = buildWelcomeMessages()

            applyHistoryResult(
              requestChatId,
              [
                ...initialMessages,
                ...data.logs.flatMap((log: any) => {
                  const historyMessages = []
                  if (
                    log.userInput ||
                    (Array.isArray(log.attachments) && log.attachments.length > 0)
                  ) {
                    historyMessages.push({
                      id: `${log.id}-user`,
                      content: log.userInput || '',
                      type: 'user',
                      timestamp: new Date(log.startedAt),
                      attachments: Array.isArray(log.attachments) ? log.attachments : undefined,
                    })
                  }
                  if (
                    log.modelOutput ||
                    (Array.isArray(log.generatedImages) && log.generatedImages.length > 0)
                  ) {
                    const historyImages = Array.isArray(log.generatedImages)
                      ? log.generatedImages
                      : undefined
                    const imageUrls =
                      historyImages
                        ?.map((image: { url?: string }) => image?.url)
                        .filter((url: string | undefined): url is string => Boolean(url)) ?? []
                    const historyContent =
                      imageUrls.length > 0
                        ? {
                            content:
                              typeof log.modelOutput === 'string'
                                ? log.modelOutput
                                    .split('\n')
                                    .filter(
                                      (line: string) =>
                                        !imageUrls.some((url: string) => line.trim() === url.trim())
                                    )
                                    .join('\n')
                                    .trim()
                                : '',
                            image: imageUrls[0] ?? '',
                            images: imageUrls,
                          }
                        : log.modelOutput || ''

                    historyMessages.push({
                      id: `${log.id}-assistant`,
                      content: historyContent,
                      type: 'assistant',
                      timestamp: new Date(log.endedAt || log.startedAt),
                      isStreaming: false,
                      executionId: log?.executionId || '',
                      liked: log.liked ?? null,
                      generatedImages: historyImages,
                      knowledgeRefs: Array.isArray(log.knowledgeRefs)
                        ? log.knowledgeRefs
                        : undefined,
                    })
                  }
                  return historyMessages
                }),
              ],
              true
            )

            setTimeout(() => {
              setTimeout(() => {
                scrollToBottom()
              }, 100)
            }, 500)
          }
        } else {
          logger.warn(`History fetch failed with status ${response.status}`)
          toast({ message: 'Failed to load chat history. Please try again.' })
          applyHistoryResult(requestChatId, buildWelcomeMessages(), false)
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (historyRequestChatIdRef.current !== requestChatId) return
        logger.error('Error fetching history:', error)
        toast({ message: getErrorMessage(error, 'Failed to load chat history. Please try again.') })
        applyHistoryResult(requestChatId, buildWelcomeMessages(), false)
      }
    }

    if (!workflowId || Object.keys(chatConfig || {}).length === 0) {
      return
    }

    if (!currentChatId) {
      if (hasInitializedThreadNavigationRef.current) {
        hasShownModalRef.current = false
        setIsHistoryLoading(false)
        setHasCheckedHistory(true)
      }
      return
    }

    historyAbortRef.current?.abort()
    const controller = new AbortController()
    historyAbortRef.current = controller
    void fetchHistory(workflowId, currentChatId, controller.signal)

    return () => {
      controller.abort()
    }
  }, [identifier, chatConfig, currentChatId, historyRefreshKey, userName, scrollToBottom])

  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // Reset user scroll tracking when streaming starts
  useEffect(() => {
    if (isStreamingResponse) {
      // Give a small delay to distinguish between programmatic scroll and user scroll
      isUserScrollingRef.current = true
      setTimeout(() => {
        isUserScrollingRef.current = false
      }, 1000)
    }
  }, [isStreamingResponse])

  const fetchChatConfig = async () => {
    try {
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

          if (errorData.error === 'auth_required_password') {
            setAuthRequired('password')
            return
          }

          // Skip email auth screen; rely on server to auto-auth or deny
          if (errorData.error === 'auth_required_email') {
            setError('You do not have access to this chat')
            return
          }

          // If user email is not authorized, show error
          if (
            errorData.error === 'Email is not authorized for this chat' ||
            errorData.error === 'Email not authorized' ||
            errorData.message === 'Email not authorized' ||
            errorData.error === 'You do not have access to this chat' ||
            errorData.message === 'You do not have access to this chat'
          ) {
            setError('You do not have access to this chat')
            return
          }
        }

        throw new Error(`Failed to load chat configuration: ${response.status}`)
      }

      // Reset auth required state when authentication is successful
      setAuthRequired(null)

      const data = await response.json()

      setChatConfig(data)
      if (data?.department) {
        setChatDepartment(data.department)
      }

      if (data?.customizations?.welcomeMessage) {
        const messages: ChatMessage[] = []

        // Add personalized greeting if user name is available
        if (userName) {
          messages.push({
            id: 'greeting',
            content: `Hi ${userName}, welcome to the chat!`,
            type: 'assistant',
            timestamp: new Date(),
            isInitialMessage: true,
          })
        }

        // Add welcome message
        messages.push({
          id: 'welcome',
          content: data.customizations.welcomeMessage,
          type: 'assistant',
          timestamp: new Date(),
          isInitialMessage: true,
        })

        setMessages(messages)
      } else if (userName) {
        // If no welcome message but we have user name, still show greeting
        setMessages([
          {
            id: 'greeting',
            content: `Hi ${userName}, welcome to the chat!`,
            type: 'assistant',
            timestamp: new Date(),
            isInitialMessage: true,
          },
        ])
      }

      // Don't show modal here - let the useEffect handle it after history check completes
      // This ensures modal only shows when there's no chat history
    } catch (error) {
      logger.error('Error fetching chat config:', error)
      setError('This chat is currently unavailable. Please try again later.')
    }
  }

  // Fetch user session to get name for personalized greeting
  useEffect(() => {
    const fetchUserSession = async () => {
      try {
        const sessionRes = await client.getSession()
        const name = sessionRes?.data?.user?.name || sessionRes?.data?.user?.email || null
        setUserName(name)
      } catch (error) {
        logger.debug('Could not fetch user session for greeting:', error)
        // Continue without user name - greeting will show without name
      }
    }
    fetchUserSession()
  }, [])

  // Update messages to include greeting when userName becomes available
  useEffect(() => {
    if (!userName || !chatConfig) return

    setMessages((prev) => {
      // Check if greeting already exists
      const hasGreeting = prev.some((msg) => msg.id === 'greeting')
      if (hasGreeting) return prev

      // Check if welcome message exists
      const welcomeMessage = prev.find((msg) => msg.id === 'welcome')
      const otherMessages = prev.filter((msg) => msg.id !== 'welcome' && msg.id !== 'greeting')

      // Build new messages array with greeting before welcome
      const newMessages: ChatMessage[] = [
        {
          id: 'greeting',
          content: `Hi ${userName}, welcome to the chat!`,
          type: 'assistant',
          timestamp: new Date(),
          isInitialMessage: true,
        },
      ]

      // Add welcome message if it exists
      if (welcomeMessage) {
        newMessages.push(welcomeMessage)
      } else if (chatConfig?.customizations?.welcomeMessage) {
        // Add welcome message if it exists in config but not in messages yet
        newMessages.push({
          id: 'welcome',
          content: chatConfig.customizations.welcomeMessage,
          type: 'assistant',
          timestamp: new Date(),
          isInitialMessage: true,
        })
      }

      // Add other messages
      return [...newMessages, ...otherMessages]
    })
  }, [userName, chatConfig])

  // Fetch chat config on mount and generate new conversation ID
  useEffect(() => {
    fetchChatConfig()
    setConversationId(generateId())

    // getFormattedGitHubStars()
    //   .then((formattedStars) => {
    //     setStarCount(formattedStars)
    //   })
    //   .catch((err) => {
    //     logger.error('Failed to fetch GitHub stars:', err)
    //   })
  }, [identifier])

  // Handle sending a message
  const handleSendMessage = async (
    messageParam?: string,
    _isVoiceInput = false,
    files?: Array<{
      id: string
      name: string
      size: number
      type: string
      file: File
      dataUrl?: string
    }>,
    forceExecution = false, // Allow execution even with empty input (e.g., when form is submitted)
    overrideValues?: Record<string, unknown>, // Override values for Start Block inputs (e.g., from form submission)
    regenerate = false
  ) => {
    const messageToSend = messageParam ?? inputValue
    // Allow execution if forceExecution is true (form submission) or if there's input/files
    if (
      (!messageToSend.trim() &&
        (!files || files.length === 0) &&
        effectiveGeneratedImages.length === 0 &&
        !forceExecution) ||
      isLoading
    )
      return

    logger.info('Sending message:', {
      messageToSend,
      conversationId,
      filesCount: (files?.length ?? 0) + effectiveGeneratedImages.length,
    })

    let userMessageId: string | null = null
    // Create abort controller for request cancellation
    const abortController = new AbortController()
    const timeoutId = setTimeout(() => {
      abortController.abort()
    }, CHAT_REQUEST_TIMEOUT_MS)

    try {
      const selectedImageFiles = await materializeSelectedGeneratedImages()
      const combinedFiles = [
        ...(files ?? []),
        ...selectedImageFiles.map((image) => ({
          id: image.id,
          name: image.name,
          size: image.size,
          type: image.type,
          file: image.file,
          dataUrl: image.dataUrl,
          url: image.url,
        })),
      ]

      if (regenerate) {
        // Drop the previous assistant response(s) after the last user turn —
        // including Start Block form submits where messageToSend is empty.
        setMessages((prev) => {
          const lastUserIndex = [...prev].reverse().findIndex((m) => m.type === 'user')
          if (lastUserIndex === -1) return prev
          const index = prev.length - 1 - lastUserIndex
          return prev.slice(0, index + 1)
        })
      } else if (messageToSend.trim() || combinedFiles.length > 0) {
        // Add the user's message to the chat
        const userMessage: ChatMessage = {
          id: generateId(),
          content: messageToSend,
          type: 'user',
          timestamp: new Date(),
          attachments: combinedFiles.map((file) => ({
            id: file.id,
            name: file.name,
            type: file.type,
            size: file.size,
            dataUrl: file.dataUrl || '',
          })),
        }
        userMessageId = userMessage.id
        setMessages((prev) => [...prev, userMessage])
      }

      setInputValue('')
      clearSelectedGeneratedImages()
      setIsLoading(true)

      if (userMessageId) {
        // Scroll to show only the user's message and loading indicator (if message exists)
        setTimeout(() => {
          scrollToMessage(userMessageId!, true)
        }, 100)
      }

      // Build complete workflow input with all Start Block fields
      // Use messageToSend directly (may be empty if form was submitted)
      // Pass overrideValues if provided (e.g., from form submission)
      const completeInput = buildCompleteWorkflowInput(
        messageToSend,
        conversationId,
        combinedFiles,
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

      const payload: any = {
        input: completeInput.input,
        //conversationId: completeInput.conversationId,
        conversationId: currentChatId,
        chatId: currentChatId,
        // Always include startBlockInputs if there are any custom fields in inputFormat
        // This ensures all Start Block fields are passed to execution, even if empty
        startBlockInputs: customFields.length > 0 ? startBlockInputsPayload : undefined,
      }

      // Add files if present (convert to base64 for JSON transmission)
      if (combinedFiles.length > 0) {
        payload.files = await Promise.all(combinedFiles.map((file) => buildChatFilePayload(file)))
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
          [AGENT_STREAM_PROTOCOL_HEADER]: AGENT_STREAM_PROTOCOL_V1,
        },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
        signal: abortController.signal,
      })

      // Clear timeout immediately once we get a response - the SSE stream will continue
      // until completion regardless of how long it takes
      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        logger.error('API error response:', errorData)
        const apiError =
          typeof errorData.error === 'string'
            ? errorData.error
            : typeof errorData.message === 'string'
              ? errorData.message
              : 'Failed to get response'
        throw new Error(apiError)
      }

      if (!response.body) {
        throw new Error('Response body is missing')
      }

      logger.info('Starting to handle streamed response')
      setIsConversationFinished(true)

      await handleStreamedResponse(response, setMessages, setIsLoading, scrollToBottom, {
        outputConfigs: chatConfig?.outputConfigs,
        abortController,
      })
      deployedChatPromptSentEvent({
        'Prompt Content': messageToSend,
        'Prompt Type': 'Text',
        'Conversation ID': conversationId,
        'Attachment Used': combinedFiles.length > 0 ? 'True' : 'False',
      })
    } catch (error: any) {
      // Clear timeout in case of error
      clearTimeout(timeoutId)

      if (error.name === 'AbortError') {
        logger.info('Request aborted by user or timeout')
        setIsLoading(false)
        return
      }

      logger.error('Error sending message:', error)
      setIsLoading(false)
      const displayError =
        error instanceof Error &&
        (error.message.startsWith('Failed to load selected image') ||
          error.message.startsWith('Invalid request body'))
          ? error.message
          : CHAT_ERROR_MESSAGES.GENERIC_ERROR
      const errorMessage: ChatMessage = {
        id: generateId(),
        content: displayError,
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
   *
   * Priority order:
   * 1. overrideValues (when form is submitted) - highest priority, used when form is just submitted
   * 2. field.value (persisted from Start Block inputFormat) - persisted values from workflow config
   * 3. empty string (when user types in chat input) - default, don't use old form values
   *
   * Note: startBlockInputs is only used to populate the modal form, not for building workflow input.
   * When user types in chat input (not using form), we should NOT use old form values.
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
      for (const field of normalizedFields) {
        const fieldName = field.name?.trim()
        if (fieldName) {
          if (overrideValues && fieldName in overrideValues) {
            // Highest priority: overrideValues from form submission
            completeInput[fieldName] = overrideValues[fieldName] ?? ''
          } else if (field.value !== undefined && field.value !== null) {
            // Second priority: persisted value from Start Block inputFormat
            completeInput[fieldName] = field.value
          } else {
            // Default: empty string (when user types in chat input, don't use old form values)
            // startBlockInputs is only for modal form state, not for workflow execution
            completeInput[fieldName] = ''
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
    [chatConfig?.inputFormat]
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

      const formattedInputs = Object.entries(values)
        .map(([key, value]) => `${key}: ${value ?? ''}`)
        .join(', ')

      // Show submitted Start Block values as a user message so copy/regenerate
      // (assistant-only actions) are not offered on this bubble.
      const inputMessage: ChatMessage = {
        id: generateId(),
        content: `Inputs received: ${formattedInputs}`,
        type: 'user',
        isStartBlockInputsSummary: true,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, inputMessage])

      // Build complete workflow input with all Start Block fields
      // Pass empty string for input (user submitted form, not typed message)
      const completeInput = buildCompleteWorkflowInput('', conversationId, undefined, values)

      // Ensure input is explicitly empty string when submitting form
      completeInput.input = ''

      // Trigger workflow execution by sending a message with empty input
      // but with all Start Block inputs included
      // Pass values as overrideValues to ensure they're used immediately
      try {
        await handleSendMessage('', false, undefined, true, values) // forceExecution = true, overrideValues = values
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

  // Show modal on load only if no chat history exists (after history check completes)
  useEffect(() => {
    // Only check after history check is complete (both loading done and hasCheckedHistory is true)
    if (isHistoryLoading || !hasCheckedHistory) return

    // Only show modal if:
    // 1. Chat config is loaded
    // 2. Has inputFormat with custom fields
    // 3. No history was found (hasShownModalRef.current is false) - this means no chat history exists
    // 4. No non-welcome messages exist (welcome message alone should not block the modal)
    // 5. Modal hasn't been shown yet
    if (
      chatConfig?.inputFormat &&
      Array.isArray(chatConfig.inputFormat) &&
      chatConfig.inputFormat.length > 0 &&
      !hasNonWelcomeMessages &&
      !hasShownModalRef.current
    ) {
      const customFields = getCustomInputFields(chatConfig.inputFormat)
      const hasNoHistory = !hasNonWelcomeMessages && !hasShownModalRef.current

      if (customFields.length > 0 && hasNoHistory) {
        hasShownModalRef.current = true
        setIsInputModalOpen(true)
      }
    }
  }, [isHistoryLoading, hasCheckedHistory, chatConfig, hasNonWelcomeMessages])

  // Reset modal ref when messages are added (user sends a message)
  useEffect(() => {
    if (messages.length > 0) {
      hasShownModalRef.current = false
    }
  }, [messages.length])

  // Keep chatId in sync when the URL query changes (e.g. back/forward navigation)
  useEffect(() => {
    const syncChatIdFromUrl = () => {
      const chatId = new URLSearchParams(window.location.search).get('chatId')
      setCurrentChatId(chatId)
    }

    syncChatIdFromUrl()
    window.addEventListener('popstate', syncChatIdFromUrl)
    return () => window.removeEventListener('popstate', syncChatIdFromUrl)
  }, [])

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

  useEffect(() => {
    if (!identifier || !chatConfig || authRequired || isThreadsLoading) return
    if (hasInitializedThreadNavigationRef.current) return

    const params = new URLSearchParams(window.location.search)
    const urlChatId = params.get('chatId')

    if (!urlChatId) {
      if (threads.length > 0) {
        const firstId = threads[0].chatId
        setCurrentChatId(firstId)
        updateUrlChatId(firstId)
      } else {
        const newId = generateId()
        setCurrentChatId(newId)
        updateUrlChatId(newId)
      }
    }

    hasInitializedThreadNavigationRef.current = true
  }, [identifier, chatConfig, authRequired, isThreadsLoading, threads, updateUrlChatId])

  useEffect(() => {
    if (isConversationFinished && currentChatId) {
      const chatIdExists = threads.some((thread) => thread.chatId === currentChatId)

      if (!chatIdExists) {
        void threadsQuery.refetch()
      }
      setIsConversationFinished(false)
    }
  }, [isConversationFinished, currentChatId, threads, threadsQuery])

  // Handle thread selection - must be defined before conditional returns
  const handleSelectThread = useCallback(
    (chatId: string) => {
      if (currentChatId === chatId) return
      setShowFeedbackView(false)
      setIsGoldenQueriesOpen(false)
      setFeedbackError(null)
      setShowScrollButton(false)
      setIsHistoryLoading(true)
      setHasCheckedHistory(false)
      setCurrentChatId(chatId)
      updateUrlChatId(chatId)

      deployedChatThreadSelectedEvent({
        Department: chatDepartment,
        'Agent Name': chatConfig?.customizations?.headerText || chatConfig?.title || 'Chat',
        'Agent ID': identifier,
        'Conversation(chat) ID': chatId,
      })
    },
    [
      currentChatId,
      chatConfig?.customizations?.headerText,
      chatConfig?.title,
      chatDepartment,
      identifier,
      updateUrlChatId,
    ]
  )

  const handleRefreshThread = useCallback(() => {
    if (!currentChatId) return
    setShowFeedbackView(false)
    setIsGoldenQueriesOpen(false)
    setFeedbackError(null)
    setIsHistoryLoading(true)
    setHasCheckedHistory(false)
    setHistoryRefreshKey((prev) => prev + 1)
  }, [currentChatId])

  const handleNewChat = useCallback(() => {
    setShowFeedbackView(false)
    setIsGoldenQueriesOpen(false)
    setFeedbackError(null)
    setShowScrollButton(false)
    setIsHistoryLoading(true)
    setHasCheckedHistory(false)
    hasShownModalRef.current = false
    const id = generateId()
    setCurrentChatId(id)
    // Clear messages except initial messages (greeting + welcome)
    setMessages((prev) => {
      const initialMessages = prev.filter((m) => (m as any).isInitialMessage)
      // If no initial messages exist but we have chatConfig, ensure they're added
      if (initialMessages.length === 0 && chatConfig) {
        const newInitialMessages: ChatMessage[] = []
        // Add greeting if user name is available
        if (userName) {
          newInitialMessages.push({
            id: 'greeting',
            content: `Hi ${userName}, welcome to the chat!`,
            type: 'assistant',
            timestamp: new Date(),
            isInitialMessage: true,
          })
        }
        // Add welcome message if it exists
        if (chatConfig?.customizations?.welcomeMessage) {
          newInitialMessages.push({
            id: 'welcome',
            content: chatConfig.customizations.welcomeMessage,
            type: 'assistant',
            timestamp: new Date(),
            isInitialMessage: true,
          })
        }
        return newInitialMessages
      }
      return initialMessages
    })
    updateUrlChatId(id)
    // Clear form input values for new chat
    setStartBlockInputs({})
    // Open input modal if custom fields exist
    const hasCustomFields = getCustomInputFields(chatConfig?.inputFormat).length > 0
    if (hasCustomFields) {
      setIsInputModalOpen(true)
    }

    deployedNewChatEvent({
      Department: chatDepartment,
      'Agent Name': chatConfig?.customizations?.headerText || chatConfig?.title || 'Chat',
      'Agent ID': identifier,
      'Conversation(chat) ID': id,
    })
  }, [updateUrlChatId, chatConfig, userName, chatDepartment, identifier])

  const fetchFeedbackPage = useCallback(
    async (page: number) => {
      if (!identifier) {
        logger.error('No workflow ID available for feedback')
        return
      }

      setIsFeedbackLoading(true)
      setFeedbackError(null)

      try {
        const url = `/api/chat/feedback/workflow/${identifier}?pageSize=${feedbackPageSize}&page=${page}`

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        })

        if (!response.ok) {
          const errorText = await response.text()
          logger.warn('Feedback request failed', {
            status: response.status,
            body: errorText,
          })
          throw new Error(`Failed to fetch feedback: ${response.status} ${errorText}`)
        }

        const data = await response.json()

        let feedbackItems: any[] = []

        if (Array.isArray(data)) {
          feedbackItems = data
        } else if (data.feedback && Array.isArray(data.feedback)) {
          feedbackItems = data.feedback
        } else if (data.data && Array.isArray(data.data)) {
          feedbackItems = data.data
        } else if (data.items && Array.isArray(data.items)) {
          feedbackItems = data.items
        } else if (data.content && Array.isArray(data.content)) {
          feedbackItems = data.content
        } else if (typeof data === 'object' && Object.keys(data).length > 0) {
          feedbackItems = [data]
        }

        const pagination = data?.pagination
        const totalCount = pagination?.totalCount ?? feedbackItems.length
        const totalPages =
          pagination?.totalPages ?? Math.max(1, Math.ceil(totalCount / feedbackPageSize))

        logger.info('Fetched feedback items:', { count: feedbackItems.length })
        setFeedbackData(feedbackItems)
        setFeedbackPage(page)
        setFeedbackTotalCount(totalCount)
        setFeedbackTotalPages(totalPages)
      } catch (err: any) {
        logger.error('Error fetching feedback:', err)
        setFeedbackError('Some thing went wrong while fetching feed back')
      } finally {
        setIsFeedbackLoading(false)
      }
    },
    [identifier, feedbackPageSize]
  )

  const handleRegenerateLastResponse = useCallback(() => {
    const lastUserMessage = [...messages].reverse().find((message) => message.type === 'user')
    if (!lastUserMessage || typeof lastUserMessage.content !== 'string') return

    // Form-submit summary is not a typed query — re-run with stored Start Block values.
    if (lastUserMessage.isStartBlockInputsSummary) {
      void handleSendMessage('', false, undefined, true, startBlockInputs, true)
      return
    }

    void handleSendMessage(lastUserMessage.content, false, undefined, false, undefined, true)
  }, [messages, handleSendMessage, startBlockInputs])

  const handleViewFeedback = useCallback(() => {
    setIsGoldenQueriesOpen(false)
    setShowFeedbackView(true)
    setFeedbackPage(1)
    fetchFeedbackPage(1)
  }, [fetchFeedbackPage])

  const handleViewGoldenQueries = useCallback(() => {
    setShowFeedbackView(false)
    setFeedbackError(null)
    setIsGoldenQueriesOpen(true)
  }, [])

  const handleToggleSidebar = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setIsMobileSidebarOpen((prev) => !prev)
      return
    }
    setIsSidebarCollapsed((prev) => {
      const next = !prev
      window.localStorage.setItem('deployed-chat-sidebar-collapsed', String(next))
      return next
    })
  }, [])

  const handleRenameThread = useCallback(
    (chatId: string, title: string) => {
      renameThreadMutation.mutate(
        { identifier, chatId, title },
        {
          onError: (error) => {
            toast({ message: getErrorMessage(error, 'Failed to rename chat') })
          },
        }
      )
    },
    [identifier, renameThreadMutation]
  )

  const handleDeleteThread = useCallback(
    async (chatId: string) => {
      try {
        await deleteThreadMutation.mutateAsync({ identifier, chatId })
      } catch (error) {
        toast({ message: getErrorMessage(error, 'Failed to delete chat') })
        return
      }

      if (currentChatId === chatId) {
        const remaining = threads.filter((thread) => thread.chatId !== chatId)
        if (remaining.length > 0) {
          handleSelectThread(remaining[0].chatId)
        } else {
          handleNewChat()
        }
      }
    },
    [identifier, deleteThreadMutation, currentChatId, threads, handleSelectThread, handleNewChat]
  )

  const handleTogglePinThread = useCallback(
    (chatId: string, pinned: boolean) => {
      pinThreadMutation.mutate({ identifier, chatId, pinned })
    },
    [identifier, pinThreadMutation]
  )

  const handleExportChat = useCallback(() => {
    const title =
      threads.find((thread) => thread.chatId === currentChatId)?.title ||
      chatConfig?.customizations?.headerText ||
      chatConfig?.title ||
      'chat'
    const markdown = exportChatAsMarkdown(messages, title)
    downloadTextFile(markdown, `${title.replace(/\s+/g, '-').toLowerCase()}.md`)
  }, [messages, threads, currentChatId, chatConfig])

  const handleFocusChatInput = useCallback(() => {
    chatInputWrapperRef.current?.querySelector('textarea')?.focus()
  }, [])

  useChatKeyboardShortcuts({
    enabled: Boolean(chatConfig) && !authRequired && !showFeedbackView,
    onNewChat: handleNewChat,
    onFocusSearch: () => threadSearchInputRef.current?.focus(),
    onFocusInput: handleFocusChatInput,
    onCloseSidebar: () => setIsMobileSidebarOpen(false),
  })

  const handleBackFromFeedback = useCallback(() => {
    setShowFeedbackView(false)
    setFeedbackError(null)
  }, [])

  // If error, show error message using the extracted component
  if (error) {
    // Show specialized component for unauthorized email errors
    if (
      error === 'Email is not authorized for this chat' ||
      error === 'You do not have access to this chat'
    ) {
      return <UnauthorizedEmailError message={error} />
    }
    return <ChatErrorState error={error} />
  }

  // If authentication is required, use the extracted components
  if (authRequired) {
    if (authRequired === 'password') {
      return <PasswordAuth identifier={identifier} />
    }
    if (authRequired === 'email') {
      return <EmailAuth identifier={identifier} />
    }
    // if (authRequired === 'sso') {
    //   return <SSOAuth identifier={identifier} />
    // }
  }

  // Loading state while fetching config using the extracted component
  if (!chatConfig) {
    return <ChatLoadingState />
  }

  return (
    <ToastProvider>
      <div className='deployed-chat-surface fixed inset-0 z-[100] flex'>
        <div className='hidden h-full shrink-0 md:flex'>
          <LeftNavThread
            threads={threads as ThreadRecord[]}
            isLoading={isThreadsLoading}
            error={threadsError || null}
            currentChatId={currentChatId || ''}
            onSelectThread={handleSelectThread}
            onRefreshThread={handleRefreshThread}
            onNewChat={handleNewChat}
            onRenameThread={handleRenameThread}
            onDeleteThread={handleDeleteThread}
            onTogglePinThread={handleTogglePinThread}
            isStreaming={isStreamingResponse || isLoading}
            workflowId={identifier}
            showReRun={customFields.length > 0}
            showFeedbackView={showFeedbackView}
            isGoldenQueriesOpen={isGoldenQueriesOpen}
            isNewChatActive={isNewChatActive}
            onReRun={handleRerun}
            onViewFeedback={handleViewFeedback}
            onViewGoldenQueries={handleViewGoldenQueries}
            searchInputRef={threadSearchInputRef}
            logoUrl={sidebarLogoUrl}
            onToggleSidebar={handleToggleSidebar}
            isCollapsed={isSidebarCollapsed}
            onExportChat={handleExportChat}
          />
        </div>

        {isMobileSidebarOpen && (
          <LeftNavThread
            threads={threads as ThreadRecord[]}
            isLoading={isThreadsLoading}
            error={threadsError || null}
            currentChatId={currentChatId || ''}
            onSelectThread={handleSelectThread}
            onRefreshThread={handleRefreshThread}
            onNewChat={handleNewChat}
            onRenameThread={handleRenameThread}
            onDeleteThread={handleDeleteThread}
            onTogglePinThread={handleTogglePinThread}
            isStreaming={isStreamingResponse || isLoading}
            workflowId={identifier}
            showReRun={customFields.length > 0}
            showFeedbackView={showFeedbackView}
            isGoldenQueriesOpen={isGoldenQueriesOpen}
            isNewChatActive={isNewChatActive}
            onReRun={handleRerun}
            onViewFeedback={handleViewFeedback}
            onViewGoldenQueries={handleViewGoldenQueries}
            isMobileOpen
            onCloseMobile={() => setIsMobileSidebarOpen(false)}
            searchInputRef={threadSearchInputRef}
            logoUrl={sidebarLogoUrl}
            onToggleSidebar={handleToggleSidebar}
            onExportChat={handleExportChat}
          />
        )}

        <div className='deployed-chat-surface relative flex min-h-0 min-w-0 flex-1 flex-col'>
          <div className='relative flex min-h-0 flex-1'>
            {isHistoryLoading && (
              <div className='absolute inset-0 z-[105] flex items-center justify-center bg-[var(--bg)]'>
                <DeployedResponseLoader size={160} className='py-0' />
              </div>
            )}

            <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
              {showFeedbackView ? (
                <FeedbackView
                  feedbackData={feedbackData}
                  isLoading={isFeedbackLoading}
                  error={feedbackError}
                  workflowTitle={chatConfig?.title}
                  page={feedbackPage}
                  pageSize={feedbackPageSize}
                  totalPages={feedbackTotalPages}
                  totalCount={feedbackTotalCount}
                  onPageChange={fetchFeedbackPage}
                  onBack={handleBackFromFeedback}
                />
              ) : showLandingView ? (
                <DeployedChatLanding
                  chatConfig={chatConfig}
                  department={chatDepartment}
                  userName={userName}
                  isStreaming={isStreamingResponse}
                  isLoading={isLoading}
                  insertText={askInChatText}
                  onInsertConsumed={() => setAskInChatText('')}
                  onSubmit={(value, _isVoiceInput, files) => {
                    void handleSendMessage(value, false, files)
                  }}
                  onStopStreaming={() => stopStreaming(setMessages)}
                  selectedGeneratedImages={effectiveGeneratedImages}
                  onRemoveSelectedGeneratedImage={removeSelectedGeneratedImage}
                  inputWrapperRef={chatInputWrapperRef}
                  onWelcomeQueryClick={handleWelcomeQueryClick}
                />
              ) : (
                <>
                  <div className='relative flex min-h-0 flex-1 flex-col overflow-hidden'>
                    <ChatMessageContainer
                      messages={messages}
                      isLoading={isLoading}
                      isStreaming={isStreamingResponse}
                      showScrollButton={showScrollButton}
                      messagesContainerRef={messagesContainerRef as RefObject<HTMLDivElement>}
                      messagesEndRef={messagesEndRef as RefObject<HTMLDivElement>}
                      scrollToBottom={scrollToBottom}
                      scrollToMessage={scrollToMessage}
                      chatConfig={chatConfig}
                      setMessages={setMessages}
                      workspaceIdsForKbLinks={chatConfig?.userWorkspaceIds}
                      onAskInChat={(text) => setAskInChatText(text)}
                      onToggleGeneratedImage={toggleGeneratedImageSelection}
                      selectedGeneratedImageIds={selectedGeneratedImageIds}
                      selectedGeneratedImageIdsKey={selectedGeneratedImageIdsKey}
                      onWelcomeQueryClick={handleWelcomeQueryClick}
                      onRegenerateMessage={handleRegenerateLastResponse}
                    />
                  </div>

                  <div
                    ref={chatInputWrapperRef}
                    className='relative w-full shrink-0 p-3 pb-4 md:p-4 md:pb-6'
                  >
                    <div
                      className={`relative mx-auto w-full ${DEPLOYED_CHAT_CONTENT_MAX_WIDTH_CLASS}`}
                    >
                      <ChatInput
                        embedded
                        placeholder={DEPLOYED_CHAT_INPUT_PLACEHOLDER}
                        insertText={askInChatText}
                        onInsertConsumed={() => setAskInChatText('')}
                        onSubmit={(
                          value: string,
                          _isVoiceInput?: boolean,
                          files?: Array<{
                            id: string
                            name: string
                            size: number
                            type: string
                            file: File
                            dataUrl?: string
                          }>
                        ) => {
                          void handleSendMessage(value, false, files)
                        }}
                        isStreaming={isLoading || isStreamingResponse}
                        onStopStreaming={() => stopStreaming(setMessages)}
                        selectedGeneratedImages={effectiveGeneratedImages}
                        onRemoveSelectedGeneratedImage={removeSelectedGeneratedImage}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
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
      </div>
    </ToastProvider>
  )
}
