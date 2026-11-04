import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import { truncate } from '@sim/utils/string'
import { create } from 'zustand'
import { devtools, type PersistStorage, persist } from 'zustand/middleware'
import { formatCsvValue, toCsvRow } from '@/lib/core/utils/csv'
import { saveBlob } from '@/lib/uploads/client/download'
import { sanitizeMessagesForPersistence } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components/chat-message/constants'
import { registerUserDataReset } from '@/stores/user-data-reset-registry'
import type { ChatMessage, ChatState } from './types'
import { MAX_CHAT_HEIGHT, MAX_CHAT_WIDTH, MIN_CHAT_HEIGHT, MIN_CHAT_WIDTH } from './utils'

const logger = createLogger('ChatStore')

/**
 * Maximum number of messages to store across all workflows
 */
const MAX_MESSAGES = 500

/**
 * Keeps storage-backed attachment previews across reloads and drops blob or
 * data URLs, which are either session-scoped or large enough to exhaust storage.
 */
export function persistedChatPreviewUrl(previewUrl: string | undefined): string | undefined {
  if (!previewUrl) return undefined
  if (previewUrl.startsWith('blob:') || previewUrl.startsWith('data:')) return undefined
  return previewUrl
}

/**
 * Floating chat dimensions
 */
const DEFAULT_WIDTH = 305
const DEFAULT_HEIGHT = 286

function createInitialState() {
  return {
    isChatOpen: false,
    chatPosition: null,
    chatWidth: DEFAULT_WIDTH,
    chatHeight: DEFAULT_HEIGHT,
    messages: [],
    selectedWorkflowOutputs: {},
    conversationIds: {},
  } satisfies Pick<
    ChatState,
    | 'isChatOpen'
    | 'chatPosition'
    | 'chatWidth'
    | 'chatHeight'
    | 'messages'
    | 'selectedWorkflowOutputs'
    | 'conversationIds'
  >
}

/**
 * Safe storage adapter that handles QuotaExceededError gracefully
 * Sanitizes messages before storing to prevent localStorage quota issues
 */
const safeStorageAdapter: PersistStorage<ChatState> = {
  getItem: (name: string) => {
    if (typeof localStorage === 'undefined') return null
    try {
      const value = localStorage.getItem(name)
      if (value === null) return null
      return JSON.parse(value)
    } catch (e) {
      logger.warn('Failed to read from localStorage', e)
      return null
    }
  },
  setItem: (name: string, value: any) => {
    if (typeof localStorage === 'undefined') return
    try {
      // Ensure messages are sanitized before storing
      const sanitizedValue = {
        ...value,
        state: {
          ...value.state,
          messages: sanitizeMessagesForPersistence(value.state?.messages || []),
        },
      }
      const serialized = JSON.stringify(sanitizedValue)
      localStorage.setItem(name, serialized)
    } catch (e) {
      // Handle QuotaExceededError gracefully
      if (e instanceof Error && e.name === 'QuotaExceededError') {
        logger.warn('localStorage quota exceeded, reducing message count and retrying', e)
        try {
          // Try to keep only the most recent messages to ensure we don't exceed quota
          const messages = value.state?.messages || []
          const limitedMessages = messages.slice(0, Math.min(50, messages.length))
          const limitedState = {
            ...value,
            state: {
              ...value.state,
              messages: sanitizeMessagesForPersistence(limitedMessages),
            },
          }
          const serialized = JSON.stringify(limitedState)
          localStorage.setItem(name, serialized)
          logger.info('Successfully stored chat messages after reducing count')
        } catch (retryError) {
          logger.error('Failed to store chat messages even after reduction', retryError)
          // Last resort: try storing without messages
          try {
            const noMessagesState = {
              ...value,
              state: {
                ...value.state,
                messages: [],
              },
            }
            localStorage.setItem(name, JSON.stringify(noMessagesState))
            logger.warn('Stored chat state without messages due to quota limit')
          } catch (finalError) {
            logger.error('Failed to store chat state even without messages', finalError)
          }
        }
      } else {
        logger.warn('Failed to save to localStorage', e)
      }
    }
  },
  removeItem: (name: string) => {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.removeItem(name)
    } catch (e) {
      logger.warn('Failed to remove from localStorage', e)
    }
  },
}

/**
 * Floating chat store
 * Manages the open/close state, position, messages, and all chat functionality
 */
export const useChatStore = create<ChatState>()(
  devtools(
    persist(
      (set, get) => ({
        ...createInitialState(),

        setIsChatOpen: (open) => {
          set({ isChatOpen: open })
        },

        setChatPosition: (position) => {
          set({ chatPosition: position })
        },

        setChatDimensions: (dimensions) => {
          set({
            chatWidth: Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, dimensions.width)),
            chatHeight: Math.max(MIN_CHAT_HEIGHT, Math.min(MAX_CHAT_HEIGHT, dimensions.height)),
          })
        },

        resetChatPosition: () => {
          set({ chatPosition: null })
        },

        addMessage: (message) => {
          set((state) => {
            const newMessage: ChatMessage = {
              ...message,
              id: (message as any).id ?? generateId(),
              timestamp: (message as any).timestamp ?? new Date().toISOString(),
            }

            const newMessages = [...state.messages, newMessage].slice(-MAX_MESSAGES)

            return { messages: newMessages }
          })
        },

        clearChat: (workflowId: string | null) => {
          set((state) => {
            const newState = {
              messages: state.messages.filter(
                (message) => !workflowId || message.workflowId !== workflowId
              ),
            }

            if (workflowId) {
              const newConversationIds = { ...state.conversationIds }
              newConversationIds[workflowId] = generateId()
              return {
                ...newState,
                conversationIds: newConversationIds,
              }
            }
            return {
              ...newState,
              conversationIds: {},
            }
          })
        },

        exportChatCSV: (workflowId: string) => {
          const messages = get().messages.filter((message) => message.workflowId === workflowId)

          if (messages.length === 0) {
            return
          }

          const headers = ['timestamp', 'type', 'content']

          const csvRows = [
            toCsvRow(headers),
            ...messages.map((message: ChatMessage) =>
              toCsvRow([
                formatCsvValue(message.timestamp),
                formatCsvValue(message.type),
                truncate(formatCsvValue(message.content), 2000),
              ])
            ),
          ]

          const csvContent = csvRows.join('\n')

          const now = new Date()
          const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const filename = `chat-${workflowId}-${timestamp}.csv`

          saveBlob(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), filename)
        },

        setSelectedWorkflowOutput: (workflowId, outputIds) => {
          set((state) => {
            const newSelections = { ...state.selectedWorkflowOutputs }

            if (outputIds.length === 0) {
              delete newSelections[workflowId]
            } else {
              newSelections[workflowId] = [...new Set(outputIds)]
            }

            return { selectedWorkflowOutputs: newSelections }
          })
        },

        getSelectedWorkflowOutput: (workflowId) => {
          return get().selectedWorkflowOutputs[workflowId] || []
        },

        getConversationId: (workflowId) => {
          const state = get()
          if (!state.conversationIds[workflowId]) {
            return get().generateNewConversationId(workflowId)
          }
          return state.conversationIds[workflowId]
        },

        generateNewConversationId: (workflowId) => {
          const newId = generateId()
          set((state) => {
            const newConversationIds = { ...state.conversationIds }
            newConversationIds[workflowId] = newId
            return { conversationIds: newConversationIds }
          })
          return newId
        },

        appendMessageContent: (messageId, content) => {
          logger.debug('[ChatStore] appendMessageContent called', {
            messageId,
            contentLength: content.length,
            content: content.substring(0, 30),
          })
          set((state) => {
            const message = state.messages.find((m) => m.id === messageId)
            if (!message) {
              logger.warn('[ChatStore] Message not found for appending', { messageId })
            }

            const newMessages = state.messages.map((message) => {
              if (message.id !== messageId) return message

              const prev = message.content
              if (prev && typeof prev === 'object' && prev !== null && 'image' in prev) {
                const text = typeof prev.content === 'string' ? prev.content : ''
                return {
                  ...message,
                  content: { ...prev, content: text + content },
                }
              }

              const newContent =
                typeof prev === 'string' ? prev + content : prev ? String(prev) + content : content
              logger.debug('[ChatStore] Updated message content', {
                messageId,
                oldLength: typeof prev === 'string' ? prev.length : 0,
                newLength: newContent.length,
                addedLength: content.length,
              })
              return { ...message, content: newContent }
            })

            return { messages: newMessages }
          })
        },

        setMessageContent: (messageId, content) => {
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === messageId ? { ...message, content } : message
            ),
          }))
        },

        finalizeMessageStream: (messageId, finalContent, messageUpdates) => {
          set((state) => {
            const newMessages = state.messages.map((message) => {
              if (message.id === messageId) {
                const { isStreaming, ...rest } = message
                return {
                  ...rest,
                  ...(messageUpdates ?? {}),
                  ...(finalContent !== undefined && { content: finalContent }),
                }
              }
              return message
            })

            return { messages: newMessages }
          })
        },

        reset: () => set(createInitialState()),
      }),
      {
        name: 'chat-store',
        storage: safeStorageAdapter,
        version: 1,
        /**
         * v0 stored messages newest-first; v1 stores them in insertion
         * (chronological) order, which consumers render without sorting.
         */
        migrate: (persistedState, version) => {
          if ((version ?? 0) < 1) {
            const state = persistedState as { messages?: ChatMessage[] } | null
            return {
              ...state,
              messages: [...(state?.messages ?? [])].reverse(),
            }
          }
          return persistedState
        },
        /**
         * Persist only the durable chat state — message history (storage-backed
         * attachment previews kept, blob and data URLs dropped), per-workflow
         * output selections and conversation ids, and the floating chat's open
         * state, position, and dimensions. Actions and any transient UI flags
         * are intentionally excluded.
         */
        partialize: (state) => ({
          isChatOpen: state.isChatOpen,
          chatPosition: state.chatPosition,
          chatWidth: state.chatWidth,
          chatHeight: state.chatHeight,
          selectedWorkflowOutputs: state.selectedWorkflowOutputs,
          conversationIds: state.conversationIds,
          messages: state.messages.map((msg) => ({
            ...msg,
            attachments: msg.attachments?.map((att) => ({
              ...att,
              previewUrl: persistedChatPreviewUrl(att.previewUrl),
            })),
          })),
        }),
      }
    )
  )
)

registerUserDataReset('chat', () => useChatStore.getState().reset())
