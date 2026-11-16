import type { ChatMessage } from '@/app/(interfaces)/chat/components/message/message'

type MessagesUpdater = ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])

function resolveMessages(updater: MessagesUpdater, prev: ChatMessage[]): ChatMessage[] {
  return typeof updater === 'function' ? updater(prev) : updater
}

function isPersistedAssistant(message: ChatMessage): boolean {
  if (message.type !== 'assistant' || message.isInitialMessage) return false
  if (message.isStreaming) return true
  if (typeof message.content === 'string') return message.content.trim().length > 0
  return message.content != null
}

/**
 * Routes a streaming `setMessages` update to the visible thread or a per-chat
 * cache so an in-flight SSE can keep accumulating while the user views another thread.
 */
export function routeStreamMessagesUpdate(params: {
  updater: MessagesUpdater
  viewingChatId: string | null
  streamingChatId: string | null
  cache: Map<string, ChatMessage[]>
  viewingMessages: ChatMessage[]
}): { nextViewingMessages: ChatMessage[] | undefined } {
  const { updater, viewingChatId, streamingChatId, cache, viewingMessages } = params

  if (streamingChatId && streamingChatId !== viewingChatId) {
    const prev = cache.get(streamingChatId) ?? []
    cache.set(streamingChatId, resolveMessages(updater, prev))
    return { nextViewingMessages: undefined }
  }

  const next = resolveMessages(updater, viewingMessages)
  const cacheKey = streamingChatId ?? viewingChatId
  if (cacheKey) {
    cache.set(cacheKey, next)
  }
  return { nextViewingMessages: next }
}

/**
 * Decides whether a history fetch may replace the visible/cached messages for a chat.
 * Blocks replace while that chat owns an in-flight stream, and prefers a richer cache
 * when history has not persisted the assistant turn yet.
 */
export function shouldApplyHistoryMessages(params: {
  requestChatId: string
  streamingChatId: string | null
  historyMessages: ChatMessage[]
  cachedMessages: ChatMessage[] | undefined
}): boolean {
  const { requestChatId, streamingChatId, historyMessages, cachedMessages } = params

  if (streamingChatId === requestChatId && cachedMessages?.some((message) => message.isStreaming)) {
    return false
  }

  const historyHasAssistant = historyMessages.some(isPersistedAssistant)
  const cacheHasAssistant = Boolean(cachedMessages?.some(isPersistedAssistant))

  if (!historyHasAssistant && cacheHasAssistant) {
    return false
  }

  return true
}
