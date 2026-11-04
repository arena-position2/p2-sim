/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSleep } = vi.hoisted(() => ({
  mockSleep: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@sim/utils/helpers', () => ({
  sleep: mockSleep,
}))

import {
  appendGeminiStreamParts,
  chunksFromGeminiParts,
  convertMessagesToGemini,
  isGeminiResourceExhaustedError,
  streamGoogleGenAiChatCompletion,
  VERTEX_PRIORITY_PAYGO_HEADERS,
} from '@/local-copilot/lib/providers/gemini'
import type { GeminiHistoryPart } from '@/local-copilot/lib/providers/types'
import type { LocalCopilotConfig } from '@/local-copilot/lib/types'

describe('chunksFromGeminiParts', () => {
  it('emits thinking chunks for thought text and text for normal prose', () => {
    const chunks = chunksFromGeminiParts(
      [
        { text: 'I should inspect the workflow first.', thought: true },
        { text: 'Here is what I found.' },
        {
          functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } },
          thought: true,
          thoughtSignature: 'sig',
        },
      ],
      () => 'generated-id'
    )

    expect(chunks).toEqual([
      { type: 'thinking', content: 'I should inspect the workflow first.' },
      { type: 'text', content: 'Here is what I found.' },
      {
        type: 'tool_call',
        toolCall: {
          id: 'c1',
          name: 'grep',
          arguments: '{"query":"x"}',
          thoughtSignature: 'sig',
        },
      },
    ])
  })

  it('treats stringy thought flags as thinking (Vertex edge cases)', () => {
    const chunks = chunksFromGeminiParts(
      // double-cast-allowed: Vertex occasionally serializes thought as a stringy flag
      [{ text: 'Step one.', thought: 'true' as unknown as boolean }],
      () => 'id'
    )
    expect(chunks).toEqual([{ type: 'thinking', content: 'Step one.' }])
  })
})

describe('appendGeminiStreamParts', () => {
  it('merges contiguous unsigned thought deltas; keeps signed parts separate', () => {
    const history: GeminiHistoryPart[] = []
    appendGeminiStreamParts(history, [{ text: 'Plan ', thought: true }], () => 'id-1')
    appendGeminiStreamParts(history, [{ text: 'A.', thought: true }], () => 'id-2')
    appendGeminiStreamParts(
      history,
      [
        { text: 'Final thought.', thought: true, thoughtSignature: 'thought-sig' },
        {
          functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } },
          thoughtSignature: 'fc-sig',
        },
      ],
      () => 'id-3'
    )

    expect(history).toEqual([
      { text: 'Plan A.', thought: true },
      {
        text: 'Final thought.',
        thought: true,
        thoughtSignature: 'thought-sig',
      },
      {
        functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } },
        thoughtSignature: 'fc-sig',
      },
    ])
  })

  it('attaches thoughtSignature from empty-text trailer parts', () => {
    const history: GeminiHistoryPart[] = []
    appendGeminiStreamParts(history, [{ text: 'Plan A', thought: true }], () => 'id-1')
    appendGeminiStreamParts(
      history,
      [{ text: '', thought: true, thoughtSignature: 'sig-empty' }],
      () => 'id-2'
    )
    appendGeminiStreamParts(
      history,
      [{ text: 'Answer', thoughtSignature: 'sig-final' }],
      () => 'id-3'
    )

    // Empty trailers must not stamp onto thought text (breaks tool-loop echo).
    // Answer keeps its own signature.
    expect(history).toEqual([
      { text: 'Plan A', thought: true },
      { text: 'Answer', thoughtSignature: 'sig-final' },
    ])
  })

  it('attaches empty trailers to unsigned functionCall parts', () => {
    const history: GeminiHistoryPart[] = []
    appendGeminiStreamParts(history, [{ text: 'Plan A', thought: true }], () => 'id-1')
    appendGeminiStreamParts(
      history,
      [{ functionCall: { name: 'grep', args: { query: 'x' } } }],
      () => 'c1'
    )
    appendGeminiStreamParts(history, [{ text: '', thoughtSignature: 'fc-sig' }], () => 'id-3')

    expect(history).toEqual([
      { text: 'Plan A', thought: true },
      {
        functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } },
        thoughtSignature: 'fc-sig',
      },
    ])
  })

  it('attaches mismatched empty trailers to the last non-thought text part', () => {
    const history: GeminiHistoryPart[] = []
    appendGeminiStreamParts(history, [{ text: 'Plan A', thought: true }], () => 'id-1')
    appendGeminiStreamParts(history, [{ text: 'Answer' }], () => 'id-2')
    appendGeminiStreamParts(
      history,
      [{ text: '', thought: true, thoughtSignature: 'sig-final' }],
      () => 'id-3'
    )

    expect(history).toEqual([
      { text: 'Plan A', thought: true },
      { text: 'Answer', thoughtSignature: 'sig-final' },
    ])
  })
})

describe('convertMessagesToGemini', () => {
  it('strips text/thought signatures and uses skip validator on the first functionCall', () => {
    const { contents } = convertMessagesToGemini([
      { role: 'user', content: 'inspect the workflow' },
      {
        role: 'assistant',
        content: '',
        geminiModelParts: [
          { text: 'I should grep first.', thought: true, thoughtSignature: 't-sig' },
          {
            functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } },
            thoughtSignature: 'fc-sig',
          },
        ],
        toolCalls: [
          {
            id: 'c1',
            name: 'grep',
            arguments: '{"query":"x"}',
            thoughtSignature: 'fc-sig',
          },
        ],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
    ])

    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'I should grep first.', thought: true },
        {
          functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } },
          thoughtSignature: 'skip_thought_signature_validator',
        },
      ],
    })
    expect(contents[2]).toMatchObject({
      role: 'user',
      parts: [{ functionResponse: { id: 'c1', name: 'grep' } }],
    })
  })

  it('uses skip validator when the first functionCall is unsigned', () => {
    const { contents } = convertMessagesToGemini([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: '',
        geminiModelParts: [
          { text: 'Plan.', thought: true },
          { functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } } },
        ],
        toolCalls: [{ id: 'c1', name: 'grep', arguments: '{"query":"x"}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: '{}' },
    ])

    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Plan.', thought: true },
        {
          functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } },
          thoughtSignature: 'skip_thought_signature_validator',
        },
      ],
    })
  })

  it('echoes thought + answer text without signatures on follow-up turns', () => {
    const { contents } = convertMessagesToGemini([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Hello',
        geminiModelParts: [
          { text: 'Greeting.', thought: true, thoughtSignature: 't-sig' },
          { text: 'Hello', thoughtSignature: 'final-sig' },
        ],
      },
      { role: 'user', content: 'follow up' },
    ])

    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'Greeting.', thought: true }, { text: 'Hello' }],
    })
    expect(contents[2]).toEqual({ role: 'user', parts: [{ text: 'follow up' }] })
  })

  it('emits post-text-only system nudges as user so contents do not end on model', () => {
    const { contents, systemInstruction } = convertMessagesToGemini([
      { role: 'system', content: 'You are Copilot.' },
      { role: 'user', content: 'build an agent' },
      {
        role: 'assistant',
        content: 'I created the workflow. Next steps…',
        geminiModelParts: [{ text: 'I created the workflow. Next steps…' }],
      },
      {
        role: 'system',
        content: '[System] Call edit_workflow NOW. Do not only narrate.',
      },
    ])

    expect(systemInstruction).toBe('You are Copilot.')
    expect(contents.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: '[System] Call edit_workflow NOW. Do not only narrate.' }],
    })
    expect(contents.some((c) => c.role === 'model')).toBe(true)
    expect(contents.at(-1)?.role).not.toBe('model')
  })

  it('keeps system nudges after tool results in systemInstruction', () => {
    const { contents, systemInstruction } = convertMessagesToGemini([
      { role: 'system', content: 'You are Copilot.' },
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: '',
        geminiModelParts: [{ functionCall: { id: 'c1', name: 'grep', args: { query: 'x' } } }],
        toolCalls: [{ id: 'c1', name: 'grep', arguments: '{"query":"x"}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
      { role: 'system', content: '[System] Soft complete nudge.' },
    ])

    expect(contents.at(-1)?.role).toBe('user')
    expect(contents.at(-1)?.parts?.[0]).toMatchObject({
      functionResponse: { id: 'c1', name: 'grep' },
    })
    expect(systemInstruction).toContain('You are Copilot.')
    expect(systemInstruction).toContain('[System] Soft complete nudge.')
  })
})

describe('isGeminiResourceExhaustedError', () => {
  it('detects nested Vertex RESOURCE_EXHAUSTED / 429 payloads', () => {
    expect(
      isGeminiResourceExhaustedError(
        new Error(
          '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 429,\\n    \\"message\\": \\"Resource exhausted. Please try again later.\\",\\n    \\"status\\": \\"RESOURCE_EXHAUSTED\\"\\n  }\\n}\\n","code":429,"status":"Too Many Requests"}}'
        )
      )
    ).toBe(true)
  })

  it('detects status/code fields from the SDK', () => {
    expect(isGeminiResourceExhaustedError({ status: 'RESOURCE_EXHAUSTED', code: 429 })).toBe(true)
    expect(isGeminiResourceExhaustedError({ code: '429' })).toBe(true)
  })

  it('ignores unrelated failures', () => {
    expect(isGeminiResourceExhaustedError(new Error('Invalid thought signature'))).toBe(false)
  })
})

describe('streamGoogleGenAiChatCompletion 429 retries', () => {
  const config = {
    enabled: true,
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    specialistModel: 'gemini-3-flash-preview',
  } satisfies LocalCopilotConfig

  beforeEach(() => {
    mockSleep.mockClear()
  })

  it('retries open failures and recovers after RESOURCE_EXHAUSTED', async () => {
    const exhausted = Object.assign(new Error('Resource exhausted'), {
      status: 'RESOURCE_EXHAUSTED',
      code: 429,
    })
    const generateContentStream = vi
      .fn()
      .mockRejectedValueOnce(exhausted)
      .mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }
        })()
      )
    const refreshAi = vi.fn(() => ({
      models: { generateContentStream },
    }))
    const ai = {
      models: { generateContentStream },
    }

    const chunks: Array<{ type: string; content?: string }> = []
    for await (const chunk of streamGoogleGenAiChatCompletion({
      // double-cast-allowed: test double for GoogleGenAI stream client
      ai: ai as unknown as Parameters<typeof streamGoogleGenAiChatCompletion>[0]['ai'],
      refreshAi: refreshAi as unknown as () => Parameters<
        typeof streamGoogleGenAiChatCompletion
      >[0]['ai'],
      config,
      request: { messages: [{ role: 'user', content: 'hi' }] },
      logLabel: 'Vertex',
    })) {
      chunks.push(chunk)
    }

    expect(generateContentStream).toHaveBeenCalledTimes(2)
    expect(refreshAi).toHaveBeenCalledTimes(1)
    expect(mockSleep).toHaveBeenCalledTimes(1)
    expect(chunks.some((chunk) => chunk.type === 'text' && chunk.content === 'ok')).toBe(true)
  })

  it('escalates Vertex retries to Priority PayGo headers', async () => {
    const exhausted = Object.assign(new Error('Resource exhausted'), {
      status: 'RESOURCE_EXHAUSTED',
      code: 429,
    })
    const generateContentStream = vi
      .fn()
      .mockRejectedValueOnce(exhausted)
      .mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 1,
              candidatesTokenCount: 1,
              trafficType: 'ON_DEMAND_PRIORITY',
            },
          }
        })()
      )
    const refreshAi = vi.fn(() => ({
      models: { generateContentStream },
    }))
    const ai = { models: { generateContentStream } }

    for await (const _chunk of streamGoogleGenAiChatCompletion({
      // double-cast-allowed: test double for GoogleGenAI stream client
      ai: ai as unknown as Parameters<typeof streamGoogleGenAiChatCompletion>[0]['ai'],
      // double-cast-allowed: test double for GoogleGenAI stream client refresh
      refreshAi: refreshAi as unknown as NonNullable<
        Parameters<typeof streamGoogleGenAiChatCompletion>[0]['refreshAi']
      >,
      priorityPayGoOnRetry: true,
      config,
      request: { messages: [{ role: 'user', content: 'hi' }] },
      logLabel: 'Vertex',
      stripVertexPrefix: true,
    })) {
      // drain
    }

    expect(generateContentStream).toHaveBeenCalledTimes(2)
    // First 429 rebuilds the same slot with Priority baked into the client.
    expect(refreshAi).toHaveBeenCalledTimes(1)
    expect(refreshAi).toHaveBeenCalledWith({ priorityPayGo: true, sameSlot: true })
    const firstConfig = generateContentStream.mock.calls[0]?.[0]?.config as
      | { httpOptions?: { headers?: Record<string, string> } }
      | undefined
    const retryConfig = generateContentStream.mock.calls[1]?.[0]?.config as
      | { httpOptions?: { headers?: Record<string, string> } }
      | undefined
    expect(firstConfig?.httpOptions?.headers).toBeUndefined()
    expect(retryConfig?.httpOptions?.headers).toEqual({ ...VERTEX_PRIORITY_PAYGO_HEADERS })
  })

  it('after Priority fails, rotates to the next slot on Standard', async () => {
    const exhausted = Object.assign(new Error('Resource exhausted'), {
      status: 'RESOURCE_EXHAUSTED',
      code: 429,
    })
    const generateContentStream = vi
      .fn()
      .mockRejectedValueOnce(exhausted)
      .mockRejectedValueOnce(exhausted)
      .mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }
        })()
      )
    const refreshAi = vi.fn(() => ({
      models: { generateContentStream },
    }))
    const ai = { models: { generateContentStream } }

    for await (const _chunk of streamGoogleGenAiChatCompletion({
      // double-cast-allowed: test double for GoogleGenAI stream client
      ai: ai as unknown as Parameters<typeof streamGoogleGenAiChatCompletion>[0]['ai'],
      // double-cast-allowed: test double for GoogleGenAI stream client refresh
      refreshAi: refreshAi as unknown as NonNullable<
        Parameters<typeof streamGoogleGenAiChatCompletion>[0]['refreshAi']
      >,
      priorityPayGoOnRetry: true,
      config,
      request: { messages: [{ role: 'user', content: 'hi' }] },
      logLabel: 'Vertex',
    })) {
      // drain
    }

    // slot0 Standard → slot0 Priority → slot1 Standard (success)
    expect(generateContentStream).toHaveBeenCalledTimes(3)
    expect(refreshAi).toHaveBeenCalledTimes(2)
    expect(refreshAi).toHaveBeenNthCalledWith(1, { priorityPayGo: true, sameSlot: true })
    expect(refreshAi).toHaveBeenNthCalledWith(2, undefined)
    const thirdConfig = generateContentStream.mock.calls[2]?.[0]?.config as
      | { httpOptions?: { headers?: Record<string, string> } }
      | undefined
    expect(thirdConfig?.httpOptions?.headers).toBeUndefined()
  })

  it('surfaces a clearer error after exhausting the slot ladder', async () => {
    const exhausted = Object.assign(new Error('Resource exhausted'), {
      status: 'RESOURCE_EXHAUSTED',
      code: 429,
    })
    const generateContentStream = vi.fn().mockRejectedValue(exhausted)
    const ai = { models: { generateContentStream } }

    await expect(async () => {
      for await (const _chunk of streamGoogleGenAiChatCompletion({
        // double-cast-allowed: test double for GoogleGenAI stream client
        ai: ai as unknown as Parameters<typeof streamGoogleGenAiChatCompletion>[0]['ai'],
        priorityPayGoOnRetry: true,
        config,
        request: { messages: [{ role: 'user', content: 'hi' }] },
        logLabel: 'Vertex',
      })) {
        // drain
      }
    }).rejects.toThrow(/Retries included Vertex Priority PayGo/)

    // attempts 0..5 = 6 opens (default 3-slot ladder cap)
    expect(generateContentStream).toHaveBeenCalledTimes(6)
    // Priority escalations skip sleep; only Priority→next-slot rotates sleep (twice).
    expect(mockSleep).toHaveBeenCalledTimes(2)
  })

  it('honors a slot-aware maxOpenRetries cap (one unique project)', async () => {
    const exhausted = Object.assign(new Error('Resource exhausted'), {
      status: 'RESOURCE_EXHAUSTED',
      code: 429,
    })
    const generateContentStream = vi.fn().mockRejectedValue(exhausted)
    const ai = { models: { generateContentStream } }

    await expect(async () => {
      for await (const _chunk of streamGoogleGenAiChatCompletion({
        // double-cast-allowed: test double for GoogleGenAI stream client
        ai: ai as unknown as Parameters<typeof streamGoogleGenAiChatCompletion>[0]['ai'],
        priorityPayGoOnRetry: true,
        maxOpenRetries: 1,
        config,
        request: { messages: [{ role: 'user', content: 'hi' }] },
        logLabel: 'Vertex',
      })) {
        // drain
      }
    }).rejects.toThrow(/Retries included Vertex Priority PayGo/)

    // Standard then Priority only
    expect(generateContentStream).toHaveBeenCalledTimes(2)
    expect(mockSleep).toHaveBeenCalledTimes(0)
  })
})
