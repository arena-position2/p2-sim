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
  it('maps none to text and upgrades live hints to live_data', () => {
    expect(resolveDbMediaKind(makeSignals({ mediaKind: 'none', lastMessage: 'hello' }))).toBe(
      'text'
    )
    expect(
      resolveDbMediaKind(makeSignals({ mediaKind: 'none', lastMessage: 'current bitcoin price' }))
    ).toBe('live_data')
    expect(
      resolveDbMediaKind(
        makeSignals({ mediaKind: 'none', lastMessage: 'who is the current cm of karnataka?' })
      )
    ).toBe('live_data')
    expect(
      resolveDbMediaKind(
        makeSignals({
          mediaKind: 'none',
          lastMessage: 'give me the recent score result of ind vs nz test match',
        })
      )
    ).toBe('live_data')
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

  it('uses classifier needs_live_data to force search even when tier is fast', async () => {
    // Primary path: model sets needs_live_data; we force search (not gpt-5.4-nano).
    dbChainMockFns.limit
      .mockResolvedValueOnce([
        { id: 'fast', hint: 'easy' },
        { id: 'search', hint: 'live web' },
        { id: 'workhorse', hint: 'general' },
      ])
      .mockResolvedValueOnce([
        {
          modelId: 'o4-mini-deep-research',
          selectionRank: 1,
          complexityScore: 2,
          productSurface: 'both',
          requiresTools: false,
        },
      ])

    mockExecuteProviderRequest.mockResolvedValue({
      content: JSON.stringify({
        tier: 'fast',
        complexity_score: 1,
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
        // Avoid thin regex backup — rely on the model flag alone.
        lastMessage: `who is the cm of karnataka right now? ${++signalSeq}`,
        toolNames: [],
        approxInputTokens: 40,
      }),
      fallbackModel: 'gpt-5',
      productSurface: 'agent',
    })

    expect(result.model).toBe('o4-mini-deep-research')
    expect(result.tier).toBe('search')
    expect(result.complexityScore).toBeGreaterThanOrEqual(2)

    const classifierCall = mockExecuteProviderRequest.mock.calls[0]?.[1] as {
      responseFormat?: { schema?: { required?: string[] } }
    }
    expect(classifierCall.responseFormat?.schema?.required).toContain('needs_live_data')
  })
})
