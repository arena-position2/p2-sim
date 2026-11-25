/**
 * Tests for Arena Auto (`@/lib/model-router/arena-resolve`).
 *
 * Keep these separate from `resolve.test.ts` — that file covers upstream Sim
 * mothership Auto. DB chains end with `.limit(100)` in arena-resolve, so mock
 * `dbChainMockFns.limit` (the global `@sim/db` mock), not a local `vi.mock`.
 */
import { dbChainMockFns, resetDbChainMock } from '@sim/testing/mocks/database.mock'
import {
  permissionCheckMock,
  permissionCheckMockFns,
} from '@sim/testing/mocks/permission-check.mock'
import { providersUtilsMock, providersUtilsMockFns } from '@sim/testing/mocks/providers-utils.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecuteProviderRequest = vi.fn()

vi.mock('@/providers', () => ({
  executeProviderRequest: (...args: unknown[]) => mockExecuteProviderRequest(...args),
}))

vi.mock('@/ee/access-control/utils/permission-check', () => permissionCheckMock)
vi.mock('@/providers/utils', () => providersUtilsMock)

// Arena Auto router — not `@/lib/model-router/resolve` (Sim mothership).
import {
  type AutoRoutingSignals,
  addAutoRoutingCost,
  formatAutoRoutingRecentHistory,
  resolveAutoModel,
  resolveDbMediaKind,
} from '@/lib/model-router/arena-resolve'
import type { ExecutionContext } from '@/executor/types'
import { ResolvedSecretTraceRegistry } from '@/executor/utils/resolved-secret-trace-registry'

const mockGetProviderFromModel = providersUtilsMockFns.mockGetProviderFromModel
const mockValidateModelProvider = permissionCheckMockFns.mockValidateModelProvider

const ctx = {
  userId: 'user-1',
  workspaceId: 'ws-1',
  workflowId: 'wf-1',
  executionId: 'exec-1',
  resolvedSecretTraceRegistry: new ResolvedSecretTraceRegistry(),
} as unknown as ExecutionContext

let signalSeq = 0
function makeSignals(overrides: Partial<AutoRoutingSignals> = {}): AutoRoutingSignals {
  return {
    systemPrompt: `analyze the quarterly report ${++signalSeq}`,
    lastMessage: 'here is the data to reconcile against the ledger',
    messageCount: 1,
    toolNames: [],
    mediaKind: 'none',
    hasResponseFormat: false,
    approxInputTokens: 500,
    ...overrides,
  }
}

describe('addAutoRoutingCost', () => {
  it('adds a billable routing call to a settled provider cost', () => {
    expect(addAutoRoutingCost({ input: 0.001, output: 0.002, total: 0.003 }, 0.0005)).toEqual({
      input: 0.001,
      output: 0.002,
      routing: 0.0005,
      total: 0.0035,
    })
  })
})

describe('resolveDbMediaKind', () => {
  it('maps attachments only — never upgrades text prompts to live_data via regex', () => {
    expect(resolveDbMediaKind(makeSignals({ mediaKind: 'none', lastMessage: 'hello' }))).toBe(
      'text'
    )
    expect(
      resolveDbMediaKind(makeSignals({ mediaKind: 'none', lastMessage: 'current bitcoin price' }))
    ).toBe('text')
    expect(resolveDbMediaKind(makeSignals({ mediaKind: 'image' }))).toBe('image')
    expect(resolveDbMediaKind(makeSignals({ mediaKind: 'file' }))).toBe('file')
  })
})

describe('formatAutoRoutingRecentHistory', () => {
  it('keeps prior turns and drops the trailing message when it matches lastMessage', () => {
    const snippet = formatAutoRoutingRecentHistory(
      [
        { role: 'user', content: 'give some js code' },
        { role: 'assistant', content: 'function hello() { return 1 }' },
        { role: 'user', content: 'add a for loop to it' },
      ],
      { excludeTrailingContent: 'add a for loop to it' }
    )

    expect(snippet).toContain('give some js code')
    expect(snippet).toContain('function hello()')
    expect(snippet).not.toContain('add a for loop to it')
  })
})

describe('resolveAutoModel', () => {
  beforeEach(() => {
    resetDbChainMock()
    mockValidateModelProvider.mockResolvedValue(undefined)
    mockGetProviderFromModel.mockReturnValue('openai')
    mockExecuteProviderRequest.mockReset()
  })

  it('classifies via LLM and picks the first usable pool model', async () => {
    // Queries end with `.limit(100)` — mock that terminal, not orderBy.
    dbChainMockFns.limit
      .mockResolvedValueOnce([
        { id: 'fast', hint: 'easy' },
        { id: 'coding', hint: 'code' },
      ])
      .mockResolvedValueOnce([
        {
          modelId: 'gpt-5.3-codex',
          selectionRank: 1,
          complexityScore: 4,
          productSurface: 'both',
          requiresTools: true,
        },
        {
          modelId: 'claude-sonnet-5-5',
          selectionRank: 2,
          complexityScore: 4,
          productSurface: 'both',
          requiresTools: true,
        },
      ])

    mockExecuteProviderRequest.mockResolvedValue({
      content: JSON.stringify({
        tier: 'coding',
        complexity_score: 4,
        requires_tools: true,
        needs_live_data: false,
        rationale: 'refactor',
      }),
      tokens: { input: 10, output: 5 },
      cost: { total: 0.001 },
    })

    const result = await resolveAutoModel({
      ctx,
      blockId: 'b1',
      signals: makeSignals({
        lastMessage: `refactor auth middleware uniquely ${signalSeq}`,
        toolNames: ['bash'],
      }),
      fallbackModel: 'gpt-5',
      productSurface: 'agent',
    })

    expect(result.model).toBe('gpt-5.3-codex')
    expect(result.tier).toBe('coding')
    expect(result.decidedBy).toBe('llm')
    expect(result.complexityScore).toBe(4)
    expect(result.selectionRank).toBe(1)
    expect(result.poolComplexityScore).toBe(4)
    expect(result.poolFallbacks).toEqual([
      { model: 'claude-sonnet-5-5', selectionRank: 2 },
    ])
  })

  it('falls back when no active tiers exist', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([])

    const result = await resolveAutoModel({
      ctx,
      blockId: 'b2',
      signals: makeSignals({ lastMessage: `no tiers ${++signalSeq}` }),
      fallbackModel: 'gpt-5',
    })

    expect(result).toEqual({
      model: 'gpt-5',
      tier: null,
      decidedBy: 'fallback',
      billableRoutingCost: 0,
    })
  })

  it('uses heuristic when classifier LLM fails', async () => {
    dbChainMockFns.limit
      .mockResolvedValueOnce([
        { id: 'fast', hint: 'easy' },
        { id: 'coding', hint: 'code' },
        { id: 'workhorse', hint: 'general' },
      ])
      .mockResolvedValueOnce([
        {
          modelId: 'gpt-5.3-codex',
          selectionRank: 1,
          complexityScore: 4,
          productSurface: 'agent',
          requiresTools: true,
        },
      ])
    mockExecuteProviderRequest.mockRejectedValue(new Error('no key'))

    const result = await resolveAutoModel({
      ctx,
      blockId: 'b3',
      signals: makeSignals({
        lastMessage: `please refactor this typescript bug ${++signalSeq}`,
        toolNames: ['shell'],
      }),
      fallbackModel: 'gpt-5',
    })

    expect(result.model).toBe('gpt-5.3-codex')
    expect(result.tier).toBe('coding')
    expect(result.decidedBy).toBe('heuristic')
  })

  it('routes vague follow-ups using recentHistory when the classifier LLM fails', async () => {
    // Without recentHistory, "add a for loop to it" alone would not look like coding.
    dbChainMockFns.limit
      .mockResolvedValueOnce([
        { id: 'fast', hint: 'easy' },
        { id: 'coding', hint: 'code' },
        { id: 'workhorse', hint: 'general' },
      ])
      .mockResolvedValueOnce([
        {
          modelId: 'gpt-5.3-codex',
          selectionRank: 1,
          complexityScore: 4,
          productSurface: 'agent',
          requiresTools: true,
        },
      ])
    mockExecuteProviderRequest.mockRejectedValue(new Error('no key'))

    const result = await resolveAutoModel({
      ctx,
      blockId: 'b4',
      signals: makeSignals({
        lastMessage: `add a for loop to it ${++signalSeq}`,
        recentHistory: 'user: give some js code\nassistant: function hello() { return 1 }',
        toolNames: [],
        approxInputTokens: 200,
      }),
      fallbackModel: 'gpt-5',
    })

    expect(result.model).toBe('gpt-5.3-codex')
    expect(result.tier).toBe('coding')
    expect(result.decidedBy).toBe('heuristic')
  })

  it('trusts the classifier tier for live questions (no regex override)', async () => {
    dbChainMockFns.limit
      .mockResolvedValueOnce([
        { id: 'fast', hint: 'easy' },
        { id: 'search', hint: 'live web' },
        { id: 'coding', hint: 'code' },
        { id: 'workhorse', hint: 'general' },
      ])
      .mockResolvedValueOnce([
        {
          modelId: 'grok-4.7',
          selectionRank: 1,
          complexityScore: 2,
          productSurface: 'both',
          requiresTools: false,
        },
      ])

    mockExecuteProviderRequest.mockResolvedValue({
      content: JSON.stringify({
        tier: 'search',
        complexity_score: 2,
        requires_tools: false,
        needs_live_data: true,
        rationale: 'needs current office holder',
      }),
      tokens: { input: 10, output: 5 },
      cost: { total: 0.001 },
    })

    const result = await resolveAutoModel({
      ctx,
      blockId: 'b5',
      signals: makeSignals({
        lastMessage: `who is the cm of karnataka right now? ${++signalSeq}`,
        toolNames: [],
        approxInputTokens: 40,
      }),
      fallbackModel: 'gpt-5',
      productSurface: 'agent',
    })

    expect(result.model).toBe('grok-4.7')
    expect(result.tier).toBe('search')
    expect(result.decidedBy).toBe('llm')
  })

  it('routes code optimize asks to coding when the classifier says coding', async () => {
    // Regression: source containing "live"/"current" must not regex into search.
    dbChainMockFns.limit
      .mockResolvedValueOnce([
        { id: 'fast', hint: 'easy' },
        { id: 'search', hint: 'live web' },
        { id: 'coding', hint: 'code' },
        { id: 'workhorse', hint: 'general' },
      ])
      .mockResolvedValueOnce([
        {
          modelId: 'gpt-5.3-codex',
          selectionRank: 1,
          complexityScore: 4,
          productSurface: 'both',
          requiresTools: true,
        },
      ])

    mockExecuteProviderRequest.mockResolvedValue({
      content: JSON.stringify({
        tier: 'coding',
        complexity_score: 4,
        requires_tools: true,
        needs_live_data: false,
        rationale: 'optimize provided source',
      }),
      tokens: { input: 10, output: 5 },
      cost: { total: 0.001 },
    })

    const result = await resolveAutoModel({
      ctx,
      blockId: 'b6',
      signals: makeSignals({
        lastMessage: `optimize the code bit where we do changes ${++signalSeq}`,
        systemPrompt: 'function liveCurrentRealtime() { return "current" }',
        toolNames: [],
        approxInputTokens: 800,
      }),
      fallbackModel: 'gpt-5',
      productSurface: 'agent',
    })

    expect(result.model).toBe('gpt-5.3-codex')
    expect(result.tier).toBe('coding')
    expect(result.decidedBy).toBe('llm')
  })
})
