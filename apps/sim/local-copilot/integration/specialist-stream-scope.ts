import { generateId } from '@sim/utils/id'
import {
  MothershipStreamV1SpanLifecycleEvent,
  MothershipStreamV1SpanPayloadKind,
  type MothershipStreamV1StreamScope,
} from '@/lib/mothership/generated/mothership-stream-v1'
import {
  flushSubagentThinkingBlock,
  flushThinkingBlock,
} from '@/lib/mothership/request/handlers/types'
import { isSubagentSpanStreamEvent } from '@/lib/mothership/request/session'
import type { StreamEvent, StreamingContext } from '@/lib/mothership/request/types'
import { isSpecialistDomain } from '@/local-copilot/lib/agent/specialists/domains'

const MAIN_SPAN_ID = 'main'

export interface SpecialistSpanFrame {
  toolCallId: string
  toolName: string
  spanId: string
  parentSpanId: string
}

export interface SpecialistSpanTracker {
  pushDispatch: (toolCallId: string, toolName: string) => SpecialistSpanFrame | null
  popDispatch: (toolCallId: string) => SpecialistSpanFrame | null
  scopeForNested: () => MothershipStreamV1StreamScope | undefined
}

function scopeForFrame(frame: SpecialistSpanFrame): MothershipStreamV1StreamScope {
  return {
    lane: 'subagent',
    agentId: frame.toolName,
    parentToolCallId: frame.toolCallId,
    spanId: frame.spanId,
    parentSpanId: frame.parentSpanId,
  }
}

/**
 * Tracks parent specialist dispatches (`file`, `workflow`, …) so nested tool
 * events can carry the same subagent span identity Go mothership stamps.
 */
export function createSpecialistSpanTracker(options?: {
  generateSpanId?: () => string
}): SpecialistSpanTracker {
  const generateSpanId = options?.generateSpanId ?? generateId
  const stack: SpecialistSpanFrame[] = []

  return {
    pushDispatch(toolCallId, toolName) {
      if (!isSpecialistDomain(toolName)) return null
      const parent = stack.at(-1)
      const frame: SpecialistSpanFrame = {
        toolCallId,
        toolName,
        spanId: generateSpanId(),
        parentSpanId: parent?.spanId ?? MAIN_SPAN_ID,
      }
      stack.push(frame)
      return frame
    },
    popDispatch(toolCallId) {
      const top = stack.at(-1)
      if (!top || top.toolCallId !== toolCallId) return null
      return stack.pop() ?? null
    },
    scopeForNested() {
      const top = stack.at(-1)
      return top ? scopeForFrame(top) : undefined
    },
  }
}

export function specialistSpanStartEvent(frame: SpecialistSpanFrame): StreamEvent {
  return {
    type: 'span',
    scope: scopeForFrame(frame),
    payload: {
      kind: MothershipStreamV1SpanPayloadKind.subagent,
      event: MothershipStreamV1SpanLifecycleEvent.start,
      agent: frame.toolName,
      data: { tool_call_id: frame.toolCallId },
    },
  }
}

export function specialistSpanEndEvent(frame: SpecialistSpanFrame): StreamEvent {
  return {
    type: 'span',
    scope: scopeForFrame(frame),
    payload: {
      kind: MothershipStreamV1SpanPayloadKind.subagent,
      event: MothershipStreamV1SpanLifecycleEvent.end,
      agent: frame.toolName,
      data: { tool_call_id: frame.toolCallId },
    },
  }
}

/**
 * Mirrors Go stream handling: a subagent start/end pair becomes a persistable
 * `subagent` content block so File Agent writes survive the post-turn refetch.
 */
export function applyLocalSubagentSpanToContext(
  event: StreamEvent,
  context: StreamingContext
): void {
  if (!isSubagentSpanStreamEvent(event)) return

  const toolCallId = event.scope?.parentToolCallId
  const spanId = event.scope?.spanId
  const parentSpanId = event.scope?.parentSpanId
  const subagentName =
    (typeof event.payload.agent === 'string' && event.payload.agent) || event.scope?.agentId
  const spanEvt = event.payload.event

  flushSubagentThinkingBlock(context)
  flushThinkingBlock(context)

  if (spanEvt === MothershipStreamV1SpanLifecycleEvent.start) {
    if (toolCallId) {
      context.subAgentContent[toolCallId] ??= ''
      context.subAgentToolCalls[toolCallId] ??= []
    }
    if (toolCallId && subagentName) {
      const openParents = (context.openSubagentParents ??= new Set<string>())
      if (!openParents.has(toolCallId)) {
        openParents.add(toolCallId)
        context.contentBlocks.push({
          type: 'subagent',
          content: subagentName,
          parentToolCallId: toolCallId,
          ...(spanId ? { spanId } : {}),
          ...(parentSpanId ? { parentSpanId } : {}),
          timestamp: Date.now(),
        })
      }
    }
    return
  }

  if (spanEvt === MothershipStreamV1SpanLifecycleEvent.end && toolCallId) {
    for (let i = context.contentBlocks.length - 1; i >= 0; i--) {
      const block = context.contentBlocks[i]
      if (
        block.type === 'subagent' &&
        block.endedAt === undefined &&
        block.parentToolCallId === toolCallId
      ) {
        block.endedAt = Date.now()
        break
      }
    }
    context.openSubagentParents?.delete(toolCallId)
  }
}
