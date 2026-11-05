import { describe, expect, it } from 'vitest'
import {
  fingerprintToolResult,
  microcompactMessages,
} from '@/local-copilot/lib/context/microcompact'
import type { ChatMessage } from '@/local-copilot/lib/providers/types'

describe('fingerprintToolResult sticky ids', () => {
  it('keeps knowledge base create id and name after clearing', () => {
    const fingerprint = fingerprintToolResult(
      'knowledge_base',
      JSON.stringify({
        success: true,
        message: 'Knowledge base "Drive Sync" created successfully',
        data: { id: 'kb-123', name: 'Drive Sync', workspaceId: 'ws-1' },
      })
    )

    expect(fingerprint).toContain('success=true')
    expect(fingerprint).toContain('id=kb-123')
    expect(fingerprint).toContain('name="Drive Sync"')
  })

  it('keeps nested knowledgeBaseId on connector results', () => {
    const fingerprint = fingerprintToolResult(
      'knowledge_base',
      JSON.stringify({
        success: true,
        data: {
          id: 'conn-1',
          knowledgeBaseId: 'kb-123',
          connectorType: 'google_drive',
        },
      })
    )

    expect(fingerprint).toContain('knowledgeBaseId=kb-123')
    expect(fingerprint).toContain('id=conn-1')
  })
})

describe('microcompactMessages', () => {
  it('fingerprints older rounds while retaining sticky create ids', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'sync drive' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'knowledge_base', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: JSON.stringify({
          success: true,
          data: { id: 'kb-abc', name: 'Created from Drive folder' },
        }),
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c2', name: 'grep', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c2', content: '{"success":true,"matches":[]}' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c3', name: 'glob', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c3', content: '{"success":true,"files":[]}' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c4', name: 'read', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c4', content: '{"success":false,"error":"unsupported"}' },
    ]

    const { messages: next, clearedCount } = microcompactMessages(messages, {
      keepRecentRounds: 2,
    })

    expect(clearedCount).toBeGreaterThan(0)
    const clearedCreate = next.find((message) => message.toolCallId === 'c1')
    expect(typeof clearedCreate?.content).toBe('string')
    expect(String(clearedCreate?.content)).toContain('id=kb-abc')
    expect(String(clearedCreate?.content)).toContain('name="Created from Drive folder"')
    // Most recent rounds stay verbatim.
    expect(next.find((message) => message.toolCallId === 'c4')?.content).toContain(
      '"success":false'
    )
  })
})
