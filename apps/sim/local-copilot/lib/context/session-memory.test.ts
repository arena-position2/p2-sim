/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { compactChatHistory } from '@/local-copilot/lib/context/context-budget'
import {
  clampSessionMemory,
  countHistoryTurns,
  formatSessionMemorySystemMessage,
  isSessionMemorySystemMessage,
  parseSessionMemory,
  parseSummarizerSessionMemory,
  SESSION_MEMORY_VERSION,
  type SessionMemory,
  type SessionMemoryTurn,
  selectUncoveredTurnsForSummary,
  shouldRefreshSessionMemory,
} from '@/local-copilot/lib/context/session-memory'
import type { ChatMessage } from '@/local-copilot/lib/providers/types'

function makeMemory(overrides: Partial<SessionMemory> = {}): SessionMemory {
  return {
    version: SESSION_MEMORY_VERSION,
    updatedAt: '2026-07-24T00:00:00.000Z',
    coveredThroughMessageId: 'msg-1',
    goals: ['Build Slack digest'],
    decisions: ['Use webhook trigger'],
    constraints: [],
    activeDirective: '',
    entities: {
      workflows: ['wf-1'],
      blocks: ['agent-1'],
      files: [],
      runs: [],
    },
    progress: ['Created workflow'],
    openQuestions: [],
    approvals: [],
    failures: [],
    verification: [],
    notes: 'User wants weekly digest',
    ...overrides,
  }
}

function makeTurns(count: number): SessionMemoryTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `msg-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Turn ${index + 1} content`,
  }))
}

function makeHistory(userTurns: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let i = 0; i < userTurns; i++) {
    messages.push({ role: 'user', content: `User ${i + 1}` })
    messages.push({ role: 'assistant', content: `Assistant ${i + 1}` })
  }
  return messages
}

describe('session memory parse/format', () => {
  it('parses valid session memory and rejects bad shapes', () => {
    expect(parseSessionMemory(makeMemory())).not.toBeNull()
    expect(parseSessionMemory(null)).toBeNull()
    expect(parseSessionMemory({ version: 2 })).toBeNull()
  })

  it('parses summarizer JSON with previous fallbacks', () => {
    const previous = makeMemory()
    const parsed = parseSummarizerSessionMemory(
      '```json\n{"goals":["Ship digest"],"notes":"Updated"}\n```',
      previous,
      'msg-9'
    )
    expect(parsed).not.toBeNull()
    expect(parsed?.goals).toEqual(['Ship digest'])
    expect(parsed?.decisions).toEqual(previous.decisions)
    expect(parsed?.coveredThroughMessageId).toBe('msg-9')
    expect(parsed?.notes).toBe('Updated')
  })

  it('formats a system message with the session memory prefix', () => {
    const message = formatSessionMemorySystemMessage(makeMemory())
    expect(isSessionMemorySystemMessage(message)).toBe(true)
    expect(String(message.content)).toContain('Build Slack digest')
  })

  it('clamps oversized arrays and notes', () => {
    const clamped = clampSessionMemory(
      makeMemory({
        goals: Array.from({ length: 12 }, (_, i) => `g${i}`),
        notes: 'x'.repeat(800),
      })
    )
    expect(clamped.goals).toHaveLength(8)
    expect(clamped.notes.length).toBeLessThanOrEqual(500)
  })
})

describe('session memory refresh gating', () => {
  it('does not refresh when nothing is uncovered', () => {
    expect(
      shouldRefreshSessionMemory({
        historyMessages: makeHistory(10),
        previous: makeMemory(),
        uncoveredTurns: [],
      })
    ).toBe(false)
  })

  it('refreshes short chats only after turns age out of the recent window', () => {
    const turns = makeTurns(4)
    const uncovered = selectUncoveredTurnsForSummary({ turns, previous: null, recentTurnsFull: 6 })
    expect(uncovered).toEqual([])
    expect(
      shouldRefreshSessionMemory({
        historyMessages: makeHistory(2),
        previous: null,
        uncoveredTurns: uncovered,
      })
    ).toBe(false)
  })

  it('selects aged turns and refreshes when history is long', () => {
    const turns = makeTurns(16)
    const uncovered = selectUncoveredTurnsForSummary({ turns, previous: null, recentTurnsFull: 6 })
    expect(uncovered.length).toBe(10)
    expect(
      shouldRefreshSessionMemory({
        historyMessages: makeHistory(8),
        previous: null,
        uncoveredTurns: uncovered,
      })
    ).toBe(true)
  })

  it('increments from coveredThroughMessageId for subsequent refreshes', () => {
    const turns = makeTurns(16)
    const previous = makeMemory({ coveredThroughMessageId: 'msg-8' })
    const uncovered = selectUncoveredTurnsForSummary({ turns, previous, recentTurnsFull: 6 })
    expect(uncovered[0]?.messageId).toBe('msg-9')
    expect(uncovered.at(-1)?.messageId).toBe('msg-10')
    expect(
      shouldRefreshSessionMemory({
        historyMessages: makeHistory(8),
        previous,
        uncoveredTurns: uncovered,
      })
    ).toBe(true)
  })

  it('counts user-led history turns', () => {
    expect(countHistoryTurns(makeHistory(5))).toBe(5)
  })
})

describe('compactChatHistory recent window', () => {
  it('keeps the last N turns verbatim with no extractive 400-char summary', () => {
    const history = makeHistory(12)
    const compacted = compactChatHistory(history, { recentTurnsFull: 6 })
    expect(
      compacted.some((message) => String(message.content).includes('Earlier conversation'))
    ).toBe(false)
    expect(compacted.filter((message) => message.role === 'user')).toHaveLength(6)
    expect(compacted.some((message) => message.content === 'User 1')).toBe(false)
    expect(compacted.some((message) => message.content === 'User 7')).toBe(true)
    expect(compacted.every((message) => typeof message.content === 'string')).toBe(true)
  })

  it('returns the full history when under the recent-turn window', () => {
    const history = makeHistory(4)
    const compacted = compactChatHistory(history)
    expect(compacted).toEqual(history)
  })
})

describe('ensureSessionMemory soft-fail', () => {
  it('keeps previous memory when summarizer returns null', async () => {
    const { ensureSessionMemory } = await import('@/local-copilot/lib/context/session-memory')
    const previous = makeMemory()
    const persist = vi.fn()
    const result = await ensureSessionMemory({
      chatId: 'chat-1',
      userId: 'user-1',
      historyMessages: makeHistory(8),
      turns: makeTurns(16),
      deps: {
        load: async () => previous,
        persist,
        summarize: async () => null,
      },
    })
    expect(result).toEqual(previous)
    expect(persist).not.toHaveBeenCalled()
  })
})
