import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/app/(interfaces)/chat/components/message/message'
import {
  routeStreamMessagesUpdate,
  shouldApplyHistoryMessages,
} from '@/app/(interfaces)/chat/utils/thread-stream-cache'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>): ChatMessage {
  return {
    content: '',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    ...partial,
  }
}

describe('routeStreamMessagesUpdate', () => {
  it('keeps updating the streaming thread cache when the user is viewing another thread', () => {
    const cache = new Map<string, ChatMessage[]>([
      [
        'chat-a',
        [
          msg({ id: 'u1', type: 'user', content: 'tell some story' }),
          msg({ id: 'a1', type: 'assistant', content: 'Once', isStreaming: true }),
        ],
      ],
    ])
    const viewing = [msg({ id: 'u2', type: 'user', content: 'run' })]

    const result = routeStreamMessagesUpdate({
      updater: (prev) =>
        prev.map((message) =>
          message.id === 'a1' ? { ...message, content: 'Once upon a time' } : message
        ),
      viewingChatId: 'chat-b',
      streamingChatId: 'chat-a',
      cache,
      viewingMessages: viewing,
    })

    expect(result.nextViewingMessages).toBeUndefined()
    expect(viewing[0]?.content).toBe('run')
    expect(cache.get('chat-a')?.find((message) => message.id === 'a1')?.content).toBe(
      'Once upon a time'
    )
  })

  it('updates the visible messages and cache when the user is on the streaming thread', () => {
    const viewing = [
      msg({ id: 'u1', type: 'user', content: 'tell some story' }),
      msg({ id: 'a1', type: 'assistant', content: 'Once', isStreaming: true }),
    ]
    const cache = new Map<string, ChatMessage[]>()

    const result = routeStreamMessagesUpdate({
      updater: (prev) =>
        prev.map((message) =>
          message.id === 'a1' ? { ...message, content: 'Once upon a time' } : message
        ),
      viewingChatId: 'chat-a',
      streamingChatId: 'chat-a',
      cache,
      viewingMessages: viewing,
    })

    expect(result.nextViewingMessages?.find((message) => message.id === 'a1')?.content).toBe(
      'Once upon a time'
    )
    expect(cache.get('chat-a')?.find((message) => message.id === 'a1')?.content).toBe(
      'Once upon a time'
    )
  })
})

describe('shouldApplyHistoryMessages', () => {
  it('rejects history replace while the requested chat still has an in-flight streaming message', () => {
    expect(
      shouldApplyHistoryMessages({
        requestChatId: 'chat-a',
        streamingChatId: 'chat-a',
        historyMessages: [msg({ id: 'u1', type: 'user', content: 'tell some story' })],
        cachedMessages: [
          msg({ id: 'u1', type: 'user', content: 'tell some story' }),
          msg({ id: 'a1', type: 'assistant', content: 'Once upon', isStreaming: true }),
        ],
      })
    ).toBe(false)
  })

  it('keeps a richer cache when history has not persisted the assistant turn yet', () => {
    expect(
      shouldApplyHistoryMessages({
        requestChatId: 'chat-a',
        streamingChatId: null,
        historyMessages: [msg({ id: 'u1', type: 'user', content: 'tell some story' })],
        cachedMessages: [
          msg({ id: 'u1', type: 'user', content: 'tell some story' }),
          msg({
            id: 'a1',
            type: 'assistant',
            content: 'Once upon a time there was a lighthouse.',
            isStreaming: false,
          }),
        ],
      })
    ).toBe(false)
  })

  it('applies history when it includes the assistant turn', () => {
    expect(
      shouldApplyHistoryMessages({
        requestChatId: 'chat-a',
        streamingChatId: null,
        historyMessages: [
          msg({ id: 'u1', type: 'user', content: 'tell some story' }),
          msg({ id: 'a1', type: 'assistant', content: 'Persisted story' }),
        ],
        cachedMessages: [
          msg({ id: 'u1', type: 'user', content: 'tell some story' }),
          msg({ id: 'a1', type: 'assistant', content: 'Partial', isStreaming: false }),
        ],
      })
    ).toBe(true)
  })
})
