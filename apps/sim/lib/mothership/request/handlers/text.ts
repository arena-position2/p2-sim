import { MothershipStreamV1TextChannel } from '@/lib/mothership/generated/mothership-stream-v1'
import type { StreamHandler, ToolScope } from './types'
import {
  addContentBlock,
  flushSubagentThinkingBlock,
  flushThinkingBlock,
  getScopedParentToolCallId,
  getScopedSpanIdentity,
} from './types'

export function handleTextEvent(scope: ToolScope): StreamHandler {
  return (event, context) => {
    if (event.type !== 'text') {
      return
    }

    const textPayload = event.payload as unknown as { thoughtSignature?: unknown }
    const thoughtSignature =
      typeof textPayload.thoughtSignature === 'string' ? textPayload.thoughtSignature : undefined
    const chunk = event.payload.text
    if (!chunk && !thoughtSignature) {
      return
    }

    if (scope === 'subagent') {
      const parentToolCallId = getScopedParentToolCallId(event)
      if (!parentToolCallId) return
      const spanIdentity = getScopedSpanIdentity(event)
      if (event.payload.channel === MothershipStreamV1TextChannel.thinking) {
        // Per-lane thinking: each concurrent subagent accumulates into its own
        // block keyed by parentToolCallId, so interleaved chunks from a sibling
        // subagent never flush or corrupt this lane's reasoning.
        let block = context.subagentThinkingBlocks.get(parentToolCallId)
        if (!block) {
          block = {
            type: 'subagent_thinking',
            content: '',
            parentToolCallId,
            ...(event.scope?.agentId ? { subagent: event.scope.agentId } : {}),
            ...spanIdentity,
            timestamp: Date.now(),
          }
          context.subagentThinkingBlocks.set(parentToolCallId, block)
        }
        if (chunk) block.content = `${block.content || ''}${chunk}`
        if (thoughtSignature) block.thoughtSignature = thoughtSignature
        return
      }
      // Real text for this lane: close this lane's thinking block first so the
      // persisted order is [thinking, text] within the lane.
      flushSubagentThinkingBlock(context, parentToolCallId)
      if (context.isInThinkingBlock) {
        flushThinkingBlock(context)
      }
      if (chunk) {
        context.subAgentContent[parentToolCallId] =
          (context.subAgentContent[parentToolCallId] || '') + chunk
        addContentBlock(context, {
          type: 'subagent_text',
          content: chunk,
          parentToolCallId,
          ...(event.scope?.agentId ? { subagent: event.scope.agentId } : {}),
          ...spanIdentity,
          ...(thoughtSignature ? { thoughtSignature } : {}),
        })
      } else if (thoughtSignature) {
        // Signature-only trailer: stamp the last subagent text block in this lane.
        for (let i = context.contentBlocks.length - 1; i >= 0; i--) {
          const block = context.contentBlocks[i]
          if (block.type === 'subagent_text' && block.parentToolCallId === parentToolCallId) {
            block.thoughtSignature = thoughtSignature
            break
          }
        }
      }
      return
    }

    if (event.payload.channel === MothershipStreamV1TextChannel.thinking) {
      if (!context.currentThinkingBlock) {
        context.currentThinkingBlock = {
          type: 'thinking',
          content: '',
          timestamp: Date.now(),
        }
        context.isInThinkingBlock = true
      }
      if (chunk) {
        context.currentThinkingBlock.content = `${context.currentThinkingBlock.content || ''}${chunk}`
      }
      if (thoughtSignature) {
        context.currentThinkingBlock.thoughtSignature = thoughtSignature
      }
      return
    }

    if (context.isInThinkingBlock) {
      flushThinkingBlock(context)
    }
    if (chunk) {
      context.accumulatedContent += chunk
      context.finalAssistantContent += chunk
      addContentBlock(context, {
        type: 'text',
        content: chunk,
        ...(thoughtSignature ? { thoughtSignature } : {}),
      })
      return
    }

    if (thoughtSignature) {
      // Gemini 3 empty-text signature trailer — stamp the last assistant text block.
      for (let i = context.contentBlocks.length - 1; i >= 0; i--) {
        const block = context.contentBlocks[i]
        if (block.type === 'text') {
          block.thoughtSignature = thoughtSignature
          break
        }
      }
    }
  }
}
