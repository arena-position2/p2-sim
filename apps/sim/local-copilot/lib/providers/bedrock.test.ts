/**
 * @vitest-environment node
 */
import type { Message as BedrockMessage, ContentBlock } from '@aws-sdk/client-bedrock-runtime'
import { describe, expect, it } from 'vitest'
import {
  anthropicThinkingBlocksToBedrockContent,
  convertMessagesToBedrock,
  normalizeBedrockConversationTurns,
  resolveBedrockThinkingAdditionalFields,
} from '@/local-copilot/lib/providers/bedrock'

describe('resolveBedrockThinkingAdditionalFields', () => {
  it('enables adaptive thinking for Claude 5 on Bedrock', () => {
    expect(resolveBedrockThinkingAdditionalFields('anthropic.claude-sonnet-5', 'medium')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    })
    expect(resolveBedrockThinkingAdditionalFields('anthropic.claude-fable-5-1', 'high')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    })
  })

  it('enables budget thinking for Claude 4.6', () => {
    expect(resolveBedrockThinkingAdditionalFields('anthropic.claude-sonnet-4-6', 'high')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 16384 },
    })
  })

  it('skips non-Claude models', () => {
    expect(resolveBedrockThinkingAdditionalFields('meta.llama3-1-70b', 'medium')).toBeUndefined()
  })
})

describe('anthropicThinkingBlocksToBedrockContent', () => {
  it('maps signed thinking blocks to reasoningContent', () => {
    const parts = anthropicThinkingBlocksToBedrockContent([
      { type: 'thinking', thinking: 'Plan first.', signature: 'sig-1' },
    ])
    expect(parts).toEqual([
      {
        reasoningContent: {
          reasoningText: { text: 'Plan first.', signature: 'sig-1' },
        },
      },
    ])
  })

  it('drops unsigned thinking blocks', () => {
    expect(
      anthropicThinkingBlocksToBedrockContent([
        { type: 'thinking', thinking: 'orphan', signature: '' },
      ])
    ).toEqual([])
  })
})

describe('convertMessagesToBedrock', () => {
  it('echoes signed reasoning before toolUse on assistant tool turns', () => {
    const { messages } = convertMessagesToBedrock([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: '',
        anthropicThinkingBlocks: [
          { type: 'thinking', thinking: 'I should grep.', signature: 'sig-a' },
        ],
        toolCalls: [{ id: 't1', name: 'grep', arguments: '{"q":"x"}' }],
      },
      { role: 'tool', toolCallId: 't1', content: 'ok' },
    ])

    const assistant = messages.find(
      (message) =>
        message.role === 'assistant' &&
        message.content?.some((block) => 'toolUse' in block && block.toolUse)
    )
    expect(assistant?.content).toEqual([
      {
        reasoningContent: {
          reasoningText: { text: 'I should grep.', signature: 'sig-a' },
        },
      },
      {
        toolUse: {
          toolUseId: 't1',
          name: 'grep',
          input: { q: 'x' },
        },
      },
    ])
  })

  it('echoes signed reasoning on text-only assistant turns', () => {
    const { messages } = convertMessagesToBedrock([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'Hello',
        anthropicThinkingBlocks: [
          { type: 'thinking', thinking: 'Greet briefly.', signature: 'sig-b' },
        ],
      },
    ])

    expect(messages[1]?.content).toEqual([
      {
        reasoningContent: {
          reasoningText: { text: 'Greet briefly.', signature: 'sig-b' },
        },
      },
      { text: 'Hello' },
    ])
  })
})

describe('normalizeBedrockConversationTurns', () => {
  it('keeps reasoningContent when stripping narration from tool turns', () => {
    const input: BedrockMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            reasoningContent: {
              reasoningText: { text: 'Use grep.', signature: 'sig' },
            },
          } as ContentBlock,
          { text: 'Calling tools…' },
          {
            toolUse: { toolUseId: 't1', name: 'grep', input: { q: 'x' } },
          } as ContentBlock,
        ],
      },
    ]

    expect(normalizeBedrockConversationTurns(input)[0]?.content).toEqual([
      {
        reasoningContent: {
          reasoningText: { text: 'Use grep.', signature: 'sig' },
        },
      },
      {
        toolUse: { toolUseId: 't1', name: 'grep', input: { q: 'x' } },
      },
    ])
  })
})
