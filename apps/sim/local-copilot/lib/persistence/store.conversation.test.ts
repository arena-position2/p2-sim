/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSelect, mockInsert, mockUpdate, mockLimit, mockWhere, mockFrom, mockSet } = vi.hoisted(
  () => {
    const mockLimit = vi.fn()
    const mockWhere = vi.fn(() => ({ limit: mockLimit }))
    const mockFrom = vi.fn(() => ({ where: mockWhere }))
    const mockSelect = vi.fn(() => ({ from: mockFrom }))
    const mockSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }))
    const mockUpdate = vi.fn(() => ({ set: mockSet }))
    const mockInsert = vi.fn(() => ({ values: vi.fn(async () => undefined) }))
    return { mockSelect, mockInsert, mockUpdate, mockLimit, mockWhere, mockFrom, mockSet }
  }
)

vi.mock('@sim/db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  },
}))

vi.mock('@sim/db/schema', () => ({
  localCopilotConversations: {
    id: 'id',
    userId: 'user_id',
    workspaceId: 'workspace_id',
    title: 'title',
    workflowId: 'workflow_id',
    model: 'model',
    provider: 'provider',
    updatedAt: 'updated_at',
  },
  localCopilotMessages: {},
  localCopilotPatches: {},
  localCopilotToolCalls: {},
  localCopilotAuditLogs: {},
}))

vi.mock('@sim/utils/id', () => ({
  generateId: () => 'conv-new-id',
}))

import {
  ensureConversationForChat,
  mothershipChatConversationTitle,
} from '@/local-copilot/lib/persistence/store'

describe('mothershipChatConversationTitle', () => {
  it('builds a stable title key from chatId', () => {
    expect(mothershipChatConversationTitle(' d5fd78c5-d4c3-4c68-84be-a3a9c5ee29f8 ')).toBe(
      'mothership-chat:d5fd78c5-d4c3-4c68-84be-a3a9c5ee29f8'
    )
  })
})

describe('ensureConversationForChat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWhere.mockImplementation(() => ({ limit: mockLimit }))
    mockFrom.mockImplementation(() => ({ where: mockWhere }))
    mockSelect.mockImplementation(() => ({ from: mockFrom }))
    mockSet.mockImplementation(() => ({ where: vi.fn(async () => undefined) }))
    mockUpdate.mockImplementation(() => ({ set: mockSet }))
    mockInsert.mockImplementation(() => ({ values: vi.fn(async () => undefined) }))
  })

  it('returns the existing conversation id for the same chat', async () => {
    mockLimit.mockResolvedValueOnce([{ id: 'conv-existing' }])

    const id = await ensureConversationForChat({
      userId: 'user-1',
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      model: 'gemini-2.5-pro',
      provider: 'gemini',
    })

    expect(id).toBe('conv-existing')
    expect(mockUpdate).toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('creates a conversation when none exists for the chat', async () => {
    mockLimit.mockResolvedValueOnce([])

    const id = await ensureConversationForChat({
      userId: 'user-1',
      workspaceId: 'ws-1',
      chatId: 'chat-2',
      workflowId: 'wf-1',
      model: 'gemini-2.5-pro',
      provider: 'gemini',
    })

    expect(id).toBe('conv-new-id')
    expect(mockInsert).toHaveBeenCalled()
  })

  it('rejects an empty chatId', async () => {
    await expect(
      ensureConversationForChat({
        userId: 'user-1',
        workspaceId: 'ws-1',
        chatId: '   ',
        model: 'gemini-2.5-pro',
        provider: 'gemini',
      })
    ).rejects.toThrow(/non-empty chatId/)
  })
})
