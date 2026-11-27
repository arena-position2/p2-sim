import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { writeLlmTrace } from '@/local-copilot/lib/persistence/store'
import type { ChatMessage } from '@/local-copilot/lib/providers/types'
import { sanitizeForLlm } from '@/local-copilot/lib/security/sanitize'
import type { LocalCopilotToolDefinition } from '@/local-copilot/lib/types'

const logger = createLogger('LocalCopilotLlmTraces')

/**
 * When true, each parent LLM round persists full system/messages/tools/response
 * into `local_copilot_llm_traces`. Set `LOCAL_COPILOT_LLM_TRACE=1` (or `true`).
 */
export function isLocalCopilotLlmTraceEnabled(): boolean {
  const raw = process.env.LOCAL_COPILOT_LLM_TRACE?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

export interface LocalCopilotLlmTraceInput {
  userId: string
  workspaceId: string
  round: number
  provider: string
  model: string
  messages: ChatMessage[]
  tools: LocalCopilotToolDefinition[]
  responseText?: string
  thinking?: string
  toolCalls?: Array<{ id?: string; name: string; arguments?: unknown }>
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  injectedNudges?: string[]
  runId?: string
  chatId?: string
  conversationId?: string
}

/**
 * Fire-and-forget insert of one LLM round when tracing is enabled.
 * Failures are logged and never thrown into the agent loop.
 */
export function maybeRecordLocalCopilotLlmTrace(input: LocalCopilotLlmTraceInput): void {
  if (!isLocalCopilotLlmTraceEnabled()) return

  const systemPrompt = extractSystemPrompt(input.messages)
  const sanitizedMessages = sanitizeForLlm(input.messages)
  const sanitizedTools = sanitizeForLlm(
    input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  )
  const sanitizedToolCalls = sanitizeForLlm(input.toolCalls ?? [])
  const sanitizedNudges = sanitizeForLlm(input.injectedNudges ?? [])

  void writeLlmTrace({
    userId: input.userId,
    workspaceId: input.workspaceId,
    round: input.round,
    provider: input.provider,
    model: input.model,
    systemPrompt,
    messages: sanitizedMessages,
    tools: sanitizedTools,
    responseText: input.responseText ?? null,
    thinking: input.thinking ?? null,
    toolCalls: sanitizedToolCalls,
    usage: {
      inputTokens: input.usage?.inputTokens ?? 0,
      outputTokens: input.usage?.outputTokens ?? 0,
      cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
      cacheCreationTokens: input.usage?.cacheCreationTokens ?? 0,
    },
    injectedNudges: sanitizedNudges,
    runId: input.runId,
    chatId: input.chatId,
    conversationId: input.conversationId,
  }).catch((error) => {
    logger.warn('Failed to persist Local Copilot LLM trace', {
      round: input.round,
      chatId: input.chatId ?? null,
      error: getErrorMessage(error),
    })
  })
}

function extractSystemPrompt(messages: ChatMessage[]): string | null {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role !== 'system') continue
    if (typeof message.content === 'string' && message.content.trim()) {
      parts.push(message.content)
    }
  }
  if (parts.length === 0) return null
  return parts.join('\n\n---\n\n')
}
