/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRecordLocalCopilotTurnUsage, mockChatCompletionStream } = vi.hoisted(() => ({
  mockRecordLocalCopilotTurnUsage: vi.fn().mockResolvedValue(undefined),
  mockChatCompletionStream: vi.fn(),
}))

vi.mock('@/lib/billing/core/attribution', () => ({
  resolveBillingAttribution: vi.fn().mockResolvedValue({
    actorUserId: 'user-1',
    billedAccountUserId: 'user-1',
    workspaceId: 'ws-1',
  }),
}))

vi.mock('@/local-copilot/lib/billing/record-turn-usage', () => ({
  recordLocalCopilotTurnUsage: mockRecordLocalCopilotTurnUsage,
}))

vi.mock('@/local-copilot/lib/config', () => ({
  assertLocalCopilotEnabled: () => undefined,
  buildLocalCopilotConfigForCatalog: () => ({
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKey: 'test-key',
  }),
  getLocalCopilotConfig: () => ({
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    apiKey: 'test-key',
  }),
  isLocalCopilotEngagementStatusEnabled: () => false,
}))

vi.mock('@/local-copilot/lib/providers/registry', () => ({
  getLocalCopilotProvider: () => ({
    id: 'anthropic',
    chatCompletionStream: mockChatCompletionStream,
  }),
}))

vi.mock('@/local-copilot/lib/context/build-context', () => ({
  buildLocalCopilotContext: vi.fn().mockResolvedValue({
    workspaceWorkflows: [],
    availableBlocks: [],
  }),
  contextToPromptJson: () => '{}',
}))

vi.mock('@/local-copilot/lib/context/context-budget', () => ({
  compactChatHistory: (messages: unknown[]) => messages,
  estimateChatMessagesTokens: () => 100,
  estimateToolDefinitionTokens: () => 0,
  fitPromptToTokenBudget: (messages: unknown[]) => messages,
  LOCAL_COPILOT_BEDROCK_WORKFLOW_FULL_STATE_TOKEN_BUDGET: 50_000,
  LOCAL_COPILOT_PROMPT_TOKEN_BUDGET: 100_000,
  LOCAL_COPILOT_WORKFLOW_FULL_STATE_TOKEN_BUDGET: 50_000,
  resolveLocalCopilotMaxOutputTokens: () => 4096,
  resolveLocalCopilotPromptTokenBudget: () => ({ tokenBudget: 100_000 }),
  resolveLocalCopilotTokenCountModel: (model: string) => model,
  resolveWorkflowContextDetail: () => 'summary',
}))

vi.mock('@/local-copilot/lib/tools/definitions', () => ({
  LOCAL_COPILOT_TOOLS: [],
  resolveLocalCopilotTools: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/local-copilot/lib/agent/specialists/classify', () => ({
  classifyLocalCopilotIntent: () => ({
    primary: 'general',
    secondary: [],
    useFullCatalog: true,
  }),
  selectParallelSubagentDomains: () => [],
  specialistPassDomain: () => null,
}))

vi.mock('@/local-copilot/lib/agent/specialists/domains', () => ({
  domainSystemHint: () => '',
  filterToolsByNames: (tools: unknown[]) => tools,
  resolveHybridParentTools: ({ allTools }: { allTools: unknown[] }) => ({
    tools: allTools,
    usedFullCatalog: true,
    leafToolCount: allTools.length,
    specialistEntryCount: 0,
  }),
  toolNamesForIntent: () => null,
}))

vi.mock('@/local-copilot/lib/agent/specialists/parallel-subagents', () => ({
  runParallelSubagents: async function* () {
    yield* []
    return { findings: '', results: [], events: [] }
  },
}))

vi.mock('@/local-copilot/lib/agent/specialists/specialist-pass', () => ({
  runSpecialistPass: async function* () {
    yield* []
    return { domain: 'research', findings: '', toolRoundCount: 0, events: [] }
  },
}))

vi.mock('@/local-copilot/lib/user-turn-content', () => ({
  buildLocalCopilotUserTurn: vi.fn().mockResolvedValue({
    role: 'user',
    content: 'hello',
  }),
  getLocalCopilotUserTurnText: () => 'hello',
}))

vi.mock('@/local-copilot/lib/diagnostics', () => ({
  getLocalCopilotMemorySnapshot: () => ({}),
}))

vi.mock('@/providers/utils', () => ({
  calculateCost: () => ({ input: 0.001, output: 0.002, total: 0.003 }),
}))

import { runLocalCopilotAgent } from '@/local-copilot/lib/agent/orchestrator'

async function drainAgent(
  generator: AsyncGenerator<unknown, unknown, undefined>
): Promise<{ events: unknown[]; returnValue: unknown }> {
  const events: unknown[] = []
  let next = await generator.next()
  while (!next.done) {
    events.push(next.value)
    next = await generator.next()
  }
  return { events, returnValue: next.value }
}

describe('runLocalCopilotAgent billing turn id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChatCompletionStream.mockImplementation(async function* () {
      yield { type: 'text', content: 'Hi there' }
      yield {
        type: 'done',
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    })
  })

  it('passes message-scoped usageTurnId to recordLocalCopilotTurnUsage and done event', async () => {
    const messageId = 'turn-message-abc'
    const { events } = await drainAgent(
      runLocalCopilotAgent({
        userId: 'user-1',
        workspaceId: 'ws-1',
        chatId: 'chat-1',
        runId: 'run-1',
        message: 'hello',
        messageId,
        persistLocally: false,
        writeChatLedger: true,
      })
    )

    expect(mockRecordLocalCopilotTurnUsage).toHaveBeenCalledTimes(1)
    expect(mockRecordLocalCopilotTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId,
        chatId: 'chat-1',
        runId: 'run-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
      })
    )

    const done = events.find(
      (event): event is { type: 'done'; messageId: string } =>
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        (event as { type: string }).type === 'done'
    )
    expect(done?.messageId).toBe(messageId)
  })

  it('does not reference undeclared turnMessageId after usageTurnId rename', () => {
    const source = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\bturnMessageId\b/)
    expect(source).toMatch(/\busageTurnId\b/)
    expect(source).toMatch(/messageId:\s*usageTurnId/)
  })
})
