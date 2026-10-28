import {
  type Content,
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  GoogleGenAI,
  type Part,
  type ThinkingConfig,
} from '@google/genai'
import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { sleep } from '@sim/utils/helpers'
import { generateShortId } from '@sim/utils/id'
import { backoffWithJitter } from '@sim/utils/retry'
import {
  listLocalCopilotGeminiApiKeys,
  resolveLocalCopilotGeminiApiKey,
} from '@/local-copilot/lib/providers/gemini-keys'
import { getMessageContentText } from '@/local-copilot/lib/providers/message-content'
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatMessage,
  ChatMessageContentPart,
  GeminiHistoryPart,
  LocalCopilotProvider,
} from '@/local-copilot/lib/providers/types'
import type { LocalCopilotConfig, LocalCopilotToolDefinition } from '@/local-copilot/lib/types'
import {
  cleanSchemaForGemini,
  ensureStructResponse,
  mapToThinkingBudget,
  mapToThinkingLevel,
} from '@/providers/google/utils'
import { isGemini3OrLaterModel } from '@/providers/utils'

const logger = createLogger('LocalCopilotGeminiProvider')

const GEMINI_NOT_CONFIGURED =
  'Gemini is not configured on this server. Set GEMINI_API_KEY_1 through GEMINI_API_KEY_3 (or GEMINI_API_KEY / GOOGLE_API_KEY).'

/** Retries when Vertex/Gemini returns 429 RESOURCE_EXHAUSTED before the stream opens. */
const MAX_RESOURCE_EXHAUSTED_RETRIES = 4

/**
 * Default Vertex slot ladder when the caller does not pass a slot-aware cap:
 * up to 3 unique slots × (standard + Priority) = 6 open attempts (0..5).
 * Prefer {@link streamGoogleGenAiChatCompletion}'s `maxOpenRetries` from Vertex
 * so duplicate projects do not burn wasted attempts.
 */
const MAX_VERTEX_SLOT_LADDER_RETRIES = 5

/**
 * Vertex Priority PayGo headers for 429 capacity retries.
 * Forces the shared priority pool (`shared` + `priority`) rather than PT spillover —
 * standard/PT already failed with RESOURCE_EXHAUSTED.
 *
 * @see https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo
 */
export const VERTEX_PRIORITY_PAYGO_HEADERS = {
  'X-Vertex-AI-LLM-Request-Type': 'shared',
  'X-Vertex-AI-LLM-Shared-Request-Type': 'priority',
} as const

/** Options for rebuilding a Vertex/Gemini client between 429 retries. */
export interface GoogleGenAiClientRefreshOptions {
  /** When true, bake Priority PayGo headers into the client httpOptions. */
  priorityPayGo?: boolean
  /**
   * When true with Priority, rebuild the current Vertex slot without rotating
   * to the next project/key (Priority step on the current account).
   */
  sameSlot?: boolean
}

/**
 * True when the Google GenAI / Vertex SDK failed due to quota or rate limits.
 */
export function isGeminiResourceExhaustedError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  const status =
    error && typeof error === 'object' && 'status' in error
      ? String((error as { status: unknown }).status).toLowerCase()
      : ''
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''

  return (
    status.includes('resource_exhausted') ||
    code === '429' ||
    message.includes('resource_exhausted') ||
    message.includes('resource exhausted') ||
    message.includes('"code": 429') ||
    message.includes('"code":429') ||
    message.includes('too many requests') ||
    /\b429\b/.test(message)
  )
}

function formatResourceExhaustedError(
  logLabel: string,
  error: unknown,
  options?: { triedPriorityPayGo?: boolean }
): Error {
  const priorityNote = options?.triedPriorityPayGo ? ' Retries included Vertex Priority PayGo.' : ''
  return new Error(
    `${logLabel} quota exceeded (429 RESOURCE_EXHAUSTED) after retries.${priorityNote} Wait a minute and try again, switch catalog models (Gemini / Claude / Bedrock), or raise the Vertex quota. Set COPILOT_THINKING_LEVEL=low|none to reduce load. Original: ${getErrorMessage(error, 'resource exhausted')}`
  )
}

export interface GeminiConversionResult {
  systemInstruction?: string
  contents: Content[]
}

/**
 * Maps Local Copilot tools to Gemini functionDeclarations.
 * Uses `parametersJsonSchema` (standard JSON Schema) instead of the legacy
 * Gemini `parameters` Schema — lowercase types like `object`/`string` work,
 * and tool calling is far more reliable on Gemini 2.5 / 3.x.
 */
export function toGeminiFunctionDeclarations(
  tools: LocalCopilotToolDefinition[] | undefined
): FunctionDeclaration[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: cleanSchemaForGemini(tool.parameters),
  }))
}

function toGeminiUserParts(content: string | ChatMessageContentPart[]): Part[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : []
  }

  const parts: Part[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ text: part.text })
      continue
    }
    parts.push({
      inlineData: {
        mimeType: part.source.media_type,
        data: part.source.data,
      },
    })
  }
  return parts
}

export interface GeminiCandidatePart {
  thought?: boolean
  text?: string
  thoughtSignature?: string
  functionCall?: {
    id?: string
    name?: string
    args?: Record<string, unknown>
  }
}

function optionalThoughtSignature(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** True when a Gemini/Vertex part is model reasoning (not answer prose). */
function isGeminiThoughtPart(part: { thought?: unknown }): boolean {
  return part.thought === true || part.thought === 'true'
}

const SKIP_THOUGHT_SIGNATURE_VALIDATOR = 'skip_thought_signature_validator'

/**
 * Maps a stored history part back onto the GenAI `Part` shape for round-trip.
 * Prefer {@link prepareGeminiModelPartsForApi} for request echo — raw text-part
 * signatures often 400 after streaming merge / UI rebuild.
 */
export function geminiHistoryPartToPart(part: GeminiHistoryPart): Part {
  if ('functionCall' in part) {
    return {
      functionCall: {
        id: part.functionCall.id,
        name: part.functionCall.name,
        args: part.functionCall.args,
      },
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    }
  }
  return {
    text: part.text,
    ...(part.thought ? { thought: true } : {}),
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
  }
}

/**
 * Prepares streamed/persisted Gemini model parts for the next generateContent
 * request.
 *
 * Vertex/Gemini 3 return 400 "Invalid thought signature" when echoed
 * text/thought-part signatures were merged, rebuilt, or cross-endpoint. UI CoT
 * still streams via `thinking_delta`; for API history we:
 * - keep thought/answer text without signatures
 * - put `skip_thought_signature_validator` on the first functionCall (Google's
 *   documented escape hatch) so tool loops never die on a mangled opaque sig
 */
export function prepareGeminiModelPartsForApi(parts: GeminiHistoryPart[]): Part[] {
  const out: Part[] = []
  let firstFunctionCall = true

  for (const part of parts) {
    if ('functionCall' in part) {
      out.push({
        functionCall: {
          id: part.functionCall.id,
          name: part.functionCall.name,
          args: part.functionCall.args,
        },
        // Only the first functionCall in a model step requires a signature.
        ...(firstFunctionCall ? { thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR } : {}),
      })
      firstFunctionCall = false
      continue
    }

    if (!part.text) continue
    out.push({
      text: part.text,
      ...(part.thought ? { thought: true } : {}),
    })
  }

  return out
}

/**
 * Appends streamed Gemini parts into an assembled history buffer (merging
 * contiguous thought/text deltas) and returns Local Copilot stream chunks.
 * Generated tool-call ids are written into the history parts so tool results
 * and model-turn echo stay aligned.
 *
 * Gemini 3 often sends the final `thoughtSignature` on an **empty-text** part
 * while streaming — those must not be dropped or follow-up turns lose CoT.
 */
export function appendGeminiStreamParts(
  historyParts: GeminiHistoryPart[],
  incoming: GeminiCandidatePart[],
  generateCallId: () => string
): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = []

  for (const part of incoming) {
    if (part.functionCall?.name) {
      const thoughtSignature = optionalThoughtSignature(part.thoughtSignature)
      const id = part.functionCall.id || generateCallId()
      historyParts.push({
        functionCall: {
          id,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        },
        ...(thoughtSignature ? { thoughtSignature } : {}),
      })
      chunks.push({
        type: 'tool_call',
        toolCall: {
          id,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
          ...(thoughtSignature ? { thoughtSignature } : {}),
        },
      })
      continue
    }

    const text = typeof part.text === 'string' ? part.text : ''
    const thoughtSignature = optionalThoughtSignature(part.thoughtSignature)
    const isThought = isGeminiThoughtPart(part)

    // Signature-only / empty-text trailer. Gemini 3 tool turns put the required
    // signature on the first functionCall — prefer stamping an unsigned FC.
    // Never stamp onto thought text when a later FC is expected: that moves the
    // signature to the wrong part and breaks the post-tool round with 400.
    if (!text) {
      if (!thoughtSignature) continue
      let stamped = false
      for (let index = historyParts.length - 1; index >= 0; index--) {
        const candidate = historyParts[index]
        if ('functionCall' in candidate) {
          if (!candidate.thoughtSignature) candidate.thoughtSignature = thoughtSignature
          stamped = true
          chunks.push({
            type: 'text',
            content: '',
            thoughtSignature,
          })
          break
        }
      }
      if (stamped) continue

      const last = historyParts.at(-1)
      if (last && 'text' in last && !last.thought) {
        last.thoughtSignature = thoughtSignature
        chunks.push({
          type: 'text',
          content: '',
          thoughtSignature,
        })
      }
      // If the only open part is thought text, hold off — a functionCall may
      // follow with its own signature. Dropping avoids Invalid thought signature.
      continue
    }

    const last = historyParts.at(-1)
    // Do not merge across signature boundaries (Gemini rejects / drops continuity).
    const canMerge =
      last &&
      'text' in last &&
      Boolean(last.thought) === isThought &&
      !('functionCall' in last) &&
      !last.thoughtSignature &&
      !thoughtSignature

    if (canMerge) {
      last.text += text
    } else {
      historyParts.push({
        text,
        ...(isThought ? { thought: true } : {}),
        ...(thoughtSignature ? { thoughtSignature } : {}),
      })
    }

    chunks.push({
      type: isThought ? 'thinking' : 'text',
      content: text,
      ...(thoughtSignature ? { thoughtSignature } : {}),
    })
  }

  return chunks
}

/**
 * Maps Gemini candidate parts onto Local Copilot stream chunks.
 * Function calls are kept even when the API flags the part as thought — Gemini 3.x
 * often attaches `thought: true` (and a thought signature) to tool-call parts.
 * Thought text is emitted as `thinking` for the thinking channel (top-of-message
 * chrome + persistence), not as assistant prose.
 */
export function chunksFromGeminiParts(
  parts: GeminiCandidatePart[],
  generateCallId: () => string
): ChatCompletionChunk[] {
  return appendGeminiStreamParts([], parts, generateCallId)
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function parseToolResponse(content: string | ChatMessageContentPart[]): Record<string, unknown> {
  const text = getMessageContentText(content)
  try {
    return ensureStructResponse(JSON.parse(text || '{}'))
  } catch {
    return ensureStructResponse(text)
  }
}

/**
 * Converts internal chat messages to Gemini `contents` + `systemInstruction`.
 * Tool results are batched into a single user turn with functionResponse parts.
 * When `geminiModelParts` is present on an assistant message, those parts
 * are echoed verbatim (including thought text and signatures) so later rounds
 * and follow-up user turns keep reasoning continuity.
 */
export function convertMessagesToGemini(messages: ChatMessage[]): GeminiConversionResult {
  const systemParts: string[] = []
  const contents: Content[] = []
  const toolNameById = new Map<string, string>()

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]

    if (message.role === 'system') {
      const text = getMessageContentText(message.content).trim()
      if (text) systemParts.push(text)
      continue
    }

    if (message.role === 'tool') {
      const responseParts: Part[] = []
      while (index < messages.length && messages[index].role === 'tool') {
        const toolMessage = messages[index]
        const toolCallId = toolMessage.toolCallId ?? ''
        const name = toolNameById.get(toolCallId) ?? 'unknown'
        responseParts.push({
          functionResponse: {
            id: toolCallId || undefined,
            name,
            response: parseToolResponse(toolMessage.content),
          },
        })
        index += 1
      }
      index -= 1
      if (responseParts.length > 0) {
        contents.push({ role: 'user', parts: responseParts })
      }
      continue
    }

    if (message.role === 'assistant' && message.geminiModelParts?.length) {
      for (const call of message.toolCalls ?? []) {
        toolNameById.set(call.id, call.name)
      }
      contents.push({
        role: 'model',
        parts: prepareGeminiModelPartsForApi(message.geminiModelParts),
      })
      continue
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        toolNameById.set(call.id, call.name)
      }

      const parts: Part[] = []
      const assistantText = getMessageContentText(message.content).trim()
      if (assistantText) {
        parts.push({ text: assistantText })
      }
      let firstFunctionCall = true
      for (const call of message.toolCalls) {
        const part: Part = {
          functionCall: {
            id: call.id,
            name: call.name,
            args: parseToolArguments(call.arguments),
          },
        }
        // Prefer skip validator over echoed opaque signatures — mangled history
        // signatures cause Vertex 400 Invalid thought signature.
        if (firstFunctionCall) {
          firstFunctionCall = false
          part.thoughtSignature = SKIP_THOUGHT_SIGNATURE_VALIDATOR
        }
        parts.push(part)
      }
      contents.push({ role: 'model', parts })
      continue
    }

    if (message.role === 'user') {
      const parts = toGeminiUserParts(message.content)
      if (parts.length > 0) {
        contents.push({ role: 'user', parts })
      }
      continue
    }

    const text = getMessageContentText(message.content)
    contents.push({ role: 'model', parts: text ? [{ text }] : [] })
  }

  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    contents,
  }
}

/**
 * Shared Gemini / Vertex streaming path for Local Copilot.
 * Caller owns client construction (API key vs Vertex project + ADC).
 *
 * Before the stream opens, 429 RESOURCE_EXHAUSTED retries with exponential
 * backoff. Vertex callers (`priorityPayGoOnRetry`) escalate in this order per
 * account slot (`VERTEX_PROJECT`, then `_1`, then `_2`):
 * 1. Standard (no Priority headers)
 * 2. Same slot + {@link VERTEX_PRIORITY_PAYGO_HEADERS}
 * Then rotate to the next slot and repeat Standard → Priority.
 */
export async function* streamGoogleGenAiChatCompletion(params: {
  ai: GoogleGenAI
  /** Rebuilds the client between 429 retries (next Vertex slot / Gemini key). */
  refreshAi?: (options?: GoogleGenAiClientRefreshOptions) => GoogleGenAI
  config: LocalCopilotConfig
  request: ChatCompletionRequest
  /** Log label, e.g. `Gemini` or `Vertex`. */
  logLabel: string
  /** Strip optional `vertex/` prefix from the model id before the API call. */
  stripVertexPrefix?: boolean
  /**
   * On 429, attach Vertex Priority PayGo headers and retry so capacity fails
   * escalate to the shared priority pool. Vertex (`global` / `us` / `eu`) only.
   */
  priorityPayGoOnRetry?: boolean
  /**
   * Caps open-stream retries (attempts are `0..maxOpenRetries`).
   * Vertex should pass `uniqueSlots * 2 - 1` so Standard+Priority run once per
   * distinct project — avoids multi-second waits on duplicate slot configs.
   */
  maxOpenRetries?: number
}): AsyncGenerator<ChatCompletionChunk, void, undefined> {
  const {
    config,
    request,
    logLabel,
    stripVertexPrefix = false,
    refreshAi,
    priorityPayGoOnRetry = false,
    maxOpenRetries: maxOpenRetriesOverride,
  } = params
  let client = params.ai
  const rawModel = request.model || config.model
  const model = stripVertexPrefix ? rawModel.replace(/^vertex\//, '') : rawModel
  const { systemInstruction, contents } = convertMessagesToGemini(request.messages)
  const functionDeclarations = toGeminiFunctionDeclarations(request.tools)
  const hasTools = Boolean(functionDeclarations?.length)
  const thinkingLevel = (request.thinkingLevel ?? config.thinkingLevel)?.trim().toLowerCase()

  const historyThoughtParts = contents.reduce((sum, content) => {
    if (content.role !== 'model') return sum
    return (
      sum +
      (content.parts?.filter((part) => part.thought === true && Boolean(part.text)).length ?? 0)
    )
  }, 0)
  const historySignatureParts = contents.reduce((sum, content) => {
    if (content.role !== 'model') return sum
    return sum + (content.parts?.filter((part) => Boolean(part.thoughtSignature)).length ?? 0)
  }, 0)
  if (historyThoughtParts > 0 || historySignatureParts > 0) {
    logger.info(`${logLabel} history model parts for CoT continuity`, {
      model,
      historyThoughtParts,
      historySignatureParts,
      contentTurns: contents.length,
    })
  }

  const thinkingConfig: ThinkingConfig | undefined = (() => {
    if (!thinkingLevel || thinkingLevel === 'none') return undefined
    if (isGemini3OrLaterModel(model)) {
      return {
        includeThoughts: true,
        thinkingLevel: mapToThinkingLevel(thinkingLevel),
      }
    }
    return {
      includeThoughts: true,
      thinkingBudget: mapToThinkingBudget(model, thinkingLevel),
    }
  })()

  const generateConfig = {
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
    ...(hasTools
      ? {
          tools: [{ functionDeclarations }],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
          },
        }
      : {}),
    abortSignal: request.signal,
  }

  try {
    if (thinkingConfig) {
      logger.info(`${logLabel} thinking enabled`, {
        model,
        thinkingLevel,
        includeThoughts: true,
      })
    }

    if (hasTools) {
      logger.info(`${logLabel} tool-enabled request`, {
        model,
        toolCount: functionDeclarations!.length,
        toolNames: functionDeclarations!.map((tool) => tool.name),
      })
    }

    // Always stream — Local Copilot agent rounds attach tools on nearly
    // every turn, so a non-streaming tool path would appear as "no
    // streaming" in chat. generateContentStream supports functionCall
    // parts alongside text deltas.
    let stream: Awaited<ReturnType<GoogleGenAI['models']['generateContentStream']>> | undefined
    let openAttempt = 0
    /**
     * Vertex 429 ladder (when {@link priorityPayGoOnRetry}):
     * slot N standard → slot N Priority → slot N+1 standard → slot N+1 Priority → …
     */
    let usePriorityPayGo = false
    const maxOpenRetries =
      maxOpenRetriesOverride ??
      (priorityPayGoOnRetry ? MAX_VERTEX_SLOT_LADDER_RETRIES : MAX_RESOURCE_EXHAUSTED_RETRIES)
    for (; openAttempt <= maxOpenRetries; openAttempt++) {
      try {
        stream = await client.models.generateContentStream({
          model,
          contents,
          config: {
            ...generateConfig,
            ...(usePriorityPayGo
              ? {
                  httpOptions: {
                    headers: { ...VERTEX_PRIORITY_PAYGO_HEADERS },
                  },
                }
              : {}),
          },
        })
        break
      } catch (error) {
        if (request.signal?.aborted || !isGeminiResourceExhaustedError(error)) {
          throw toError(error)
        }
        if (openAttempt >= maxOpenRetries) {
          throw formatResourceExhaustedError(logLabel, error, {
            triedPriorityPayGo: usePriorityPayGo || priorityPayGoOnRetry,
          })
        }

        if (priorityPayGoOnRetry && !usePriorityPayGo) {
          // Standard failed → Priority on the same slot/account.
          // No multi-second wait — Priority is a different capacity pool, not a cooldown.
          usePriorityPayGo = true
          logger.warn(`${logLabel} RESOURCE_EXHAUSTED; retrying with Priority PayGo (same slot)`, {
            model,
            attempt: openAttempt + 1,
            maxRetries: maxOpenRetries,
            usingPriorityPayGo: true,
            rotateClient: false,
            error: getErrorMessage(error, 'resource exhausted'),
          })
          if (refreshAi) {
            client = refreshAi({ priorityPayGo: true, sameSlot: true })
          }
          continue
        }

        // Priority failed (or Gemini key path) → next slot/key on Standard first.
        // Keep rotate sleeps short so a full ladder still fails over to Gemini quickly.
        usePriorityPayGo = false
        const willRotate = Boolean(refreshAi)
        logger.warn(`${logLabel} RESOURCE_EXHAUSTED; rotating to next slot on Standard`, {
          model,
          attempt: openAttempt + 1,
          maxRetries: maxOpenRetries,
          usingPriorityPayGo: false,
          rotateClient: willRotate,
          error: getErrorMessage(error, 'resource exhausted'),
        })
        await sleep(
          backoffWithJitter(openAttempt + 1, null, {
            baseMs: priorityPayGoOnRetry ? 50 : 500,
            maxMs: priorityPayGoOnRetry ? 250 : 8_000,
          })
        )
        if (refreshAi) {
          client = refreshAi(undefined)
        }
      }
    }

    if (!stream) {
      throw new Error(`${logLabel} failed to open generateContentStream`)
    }

    if (usePriorityPayGo) {
      logger.info(`${logLabel} stream opened with Priority PayGo`, {
        model,
        openAttempt,
      })
    }

    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let thoughtsTokenCount = 0
    let yieldedToolCall = false
    let yieldedThinkingChars = 0
    let apiFinishReason: string | undefined
    let partCount = 0
    let loggedTrafficType = false
    const historyParts: GeminiHistoryPart[] = []

    for await (const chunk of stream) {
      if (request.signal?.aborted) {
        throw new Error('Request aborted')
      }

      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens
        // Gemini 2.5+ implicit context cache hits (subset of promptTokenCount).
        cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount ?? cacheReadTokens
        thoughtsTokenCount = chunk.usageMetadata.thoughtsTokenCount ?? thoughtsTokenCount
        if (!loggedTrafficType && chunk.usageMetadata.trafficType) {
          loggedTrafficType = true
          logger.info(`${logLabel} traffic type`, {
            model,
            trafficType: chunk.usageMetadata.trafficType,
            priorityPayGoRetry: priorityPayGoOnRetry && openAttempt > 0,
          })
        }
      }

      const candidate = chunk.candidates?.[0]
      if (candidate?.finishReason) {
        apiFinishReason = String(candidate.finishReason)
      }

      const parts = candidate?.content?.parts ?? []
      partCount += parts.length

      for (const emitted of appendGeminiStreamParts(historyParts, parts, generateShortId)) {
        if (emitted.type === 'tool_call') yieldedToolCall = true
        if (emitted.type === 'thinking' && emitted.content) {
          yieldedThinkingChars += emitted.content.length
        }
        yield emitted
      }
    }

    if (historyParts.length > 0) {
      const thoughtParts = historyParts.filter((part) => 'text' in part && part.thought)
      const signatureParts = historyParts.filter((part) => Boolean(part.thoughtSignature))
      logger.info(`${logLabel} model parts assembled`, {
        model,
        partCount: historyParts.length,
        thoughtParts: thoughtParts.length,
        thoughtChars: thoughtParts.reduce(
          (sum, part) => sum + ('text' in part ? part.text.length : 0),
          0
        ),
        yieldedThinkingChars,
        thoughtsTokenCount,
        signatureParts: signatureParts.length,
      })
      yield { type: 'gemini_model_parts', geminiModelParts: historyParts }
    }

    if (thinkingConfig && thoughtsTokenCount > 0 && yieldedThinkingChars === 0) {
      logger.warn(
        `${logLabel} thinking requested but no thought text streamed (API billed thoughts without includeThoughts text)`,
        {
          model,
          thinkingLevel,
          thoughtsTokenCount,
          partCount,
        }
      )
    }

    if (apiFinishReason === 'MALFORMED_FUNCTION_CALL') {
      logger.warn(`${logLabel} returned MALFORMED_FUNCTION_CALL`, {
        model,
        toolCount: functionDeclarations?.length ?? 0,
      })
    }

    if (hasTools && !yieldedToolCall) {
      logger.warn(`${logLabel} returned no function calls on a tool-enabled turn`, {
        model,
        finishReason: apiFinishReason,
        partCount,
        toolCount: functionDeclarations!.length,
      })
    }

    if (cacheReadTokens > 0) {
      logger.info(`${logLabel} prompt cache usage`, {
        model,
        cacheReadTokens,
        inputTokens,
      })
    }

    yield {
      type: 'done',
      finishReason: yieldedToolCall ? 'tool_calls' : (apiFinishReason ?? 'stop'),
      usage: {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      },
    }
  } catch (error) {
    logger.error(`${logLabel} request failed`, { error: toError(error).message })
    throw toError(error)
  }
}

/**
 * Creates a Local Copilot provider backed by the Google GenAI SDK (API key).
 *
 * Each stream request resolves a fresh API key from `GEMINI_API_KEY_1..3`
 * (round-robin) so parent rounds and specialists distribute across keys.
 * 429 retries also advance to the next key.
 */
export function createGeminiProvider(config: LocalCopilotConfig): LocalCopilotProvider {
  if (!config.apiKey && listLocalCopilotGeminiApiKeys().length === 0) {
    throw new Error(GEMINI_NOT_CONFIGURED)
  }

  const buildClient = (): GoogleGenAI => {
    const apiKey = resolveLocalCopilotGeminiApiKey()
    if (!apiKey) {
      throw new Error(GEMINI_NOT_CONFIGURED)
    }
    return new GoogleGenAI({ apiKey })
  }

  return {
    id: 'gemini',
    async *chatCompletionStream(request: ChatCompletionRequest) {
      yield* streamGoogleGenAiChatCompletion({
        ai: buildClient(),
        refreshAi: buildClient,
        config,
        request,
        logLabel: 'Gemini',
      })
    },
  }
}
