/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { PersistedMessage } from '@/lib/mothership/chat/persisted-message'
import {
  MothershipStreamV1EventType,
  MothershipStreamV1TextChannel,
  MothershipStreamV1ToolOutcome,
} from '@/lib/mothership/generated/mothership-stream-v1'
import {
  assistantMessageToChatHistory,
  formatPersistedUserMessageForLocalHistory,
  mothershipMessagesToChatHistory,
} from '@/local-copilot/lib/mothership-history'

describe('assistantMessageToChatHistory', () => {
  it('replays unsigned tool turns as structured toolCalls (Claude/Bedrock history)', () => {
    const message: PersistedMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      contentBlocks: [
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.thinking,
          content: 'I should search first.',
        },
        {
          type: MothershipStreamV1EventType.tool,
          toolCall: {
            id: 't1',
            name: 'grep',
            state: MothershipStreamV1ToolOutcome.success,
            params: { query: 'x' },
            result: { success: true, output: { matches: 2 } },
          },
        },
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.assistant,
          content: 'Found two matches.',
        },
      ],
    }

    const history = assistantMessageToChatHistory(message)

    expect(history).toHaveLength(3)
    expect(history[0]).toMatchObject({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't1', name: 'grep', arguments: JSON.stringify({ query: 'x' }) }],
    })
    expect(history[0].content).not.toContain('I should search first.')
    expect(history[1]).toMatchObject({ role: 'tool', toolCallId: 't1' })
    expect(history[2]).toEqual({
      role: 'assistant',
      content: 'Found two matches.',
    })
  })

  it('omits unsigned prior CoT so the next user message can think fresh', () => {
    const message: PersistedMessage = {
      id: 'a3',
      role: 'assistant',
      content: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      contentBlocks: [
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.thinking,
          content: 'Prior chain of thought.',
        },
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.assistant,
          content: 'Here is the answer.',
        },
      ],
    }

    expect(assistantMessageToChatHistory(message)).toEqual([
      {
        role: 'assistant',
        content: 'Here is the answer.',
      },
    ])
  })

  it('replays tool turns when thought signatures are present', () => {
    const message: PersistedMessage = {
      id: 'a2',
      role: 'assistant',
      content: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      contentBlocks: [
        {
          type: MothershipStreamV1EventType.tool,
          toolCall: {
            id: 't1',
            name: 'grep',
            state: MothershipStreamV1ToolOutcome.success,
            params: { query: 'x' },
            result: { success: true, output: { ok: true } },
            thoughtSignature: 'sig-1',
          },
        },
      ],
    }

    const history = assistantMessageToChatHistory(message)
    expect(history[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 't1', name: 'grep', thoughtSignature: 'sig-1' }],
    })
    expect(history[1]).toMatchObject({ role: 'tool', toolCallId: 't1' })
  })

  it('does not rebuild signed geminiModelParts from UI blocks (avoids Invalid thought signature)', () => {
    const message: PersistedMessage = {
      id: 'a4',
      role: 'assistant',
      content: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      contentBlocks: [
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.thinking,
          content: 'I should answer carefully.',
          thoughtSignature: 'thought-sig',
        },
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.assistant,
          content: 'Here is the answer.',
          thoughtSignature: 'final-sig',
        },
      ],
    }

    expect(assistantMessageToChatHistory(message)).toEqual([
      {
        role: 'assistant',
        content: 'Here is the answer.',
      },
    ])
  })

  it('collapses unsigned thought + prose rebuilds to assistant text only', () => {
    const message: PersistedMessage = {
      id: 'a5',
      role: 'assistant',
      content: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      contentBlocks: [
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.thinking,
          content: 'Prior chain of thought.',
        },
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.assistant,
          content: 'Here is the answer.',
          thoughtSignature: 'final-sig',
        },
      ],
    }

    expect(assistantMessageToChatHistory(message)).toEqual([
      {
        role: 'assistant',
        content: 'Here is the answer.',
      },
    ])
  })

  it('prefers persisted geminiModelPartRounds over block reconstruction', () => {
    const message: PersistedMessage = {
      id: 'a6',
      role: 'assistant',
      content: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      contentBlocks: [
        {
          type: MothershipStreamV1EventType.text,
          channel: MothershipStreamV1TextChannel.assistant,
          content: 'Answer',
          thoughtSignature: 'wrong-sig',
        },
      ],
      geminiModelPartRounds: [
        [
          { text: 'Exact thought.', thought: true },
          { text: 'Exact answer.', thoughtSignature: 'exact-sig' },
        ],
      ],
    }

    expect(assistantMessageToChatHistory(message)).toEqual([
      {
        role: 'assistant',
        content: 'Answer',
        geminiModelParts: [
          { text: 'Exact thought.', thought: true },
          { text: 'Exact answer.', thoughtSignature: 'exact-sig' },
        ],
      },
    ])
  })
})

describe('mothershipMessagesToChatHistory user attachment stubs', () => {
  it('appends pointer stubs for persisted fileAttachments without inlining bytes', () => {
    const user: PersistedMessage = {
      id: 'u1',
      role: 'user',
      content: 'Confirm you understand before analyzing the screens.',
      timestamp: '2026-01-01T00:00:00.000Z',
      fileAttachments: [
        {
          id: 'f1',
          key: 'uploads/key',
          filename: 'Screens.pdf',
          media_type: 'application/pdf',
          size: 12_345,
        },
      ],
    }

    const content = formatPersistedUserMessageForLocalHistory(user)
    expect(content).toContain('Confirm you understand')
    expect(content).toContain('[Attached: Screens.pdf')
    expect(content).toContain('read("uploads/Screens.pdf")')
    expect(content).not.toContain('Contents of "Screens.pdf"')

    const history = mothershipMessagesToChatHistory([user])
    expect(history).toEqual([{ role: 'user', content }])
  })
})
