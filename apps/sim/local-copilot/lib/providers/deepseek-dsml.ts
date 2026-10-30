import type { ChatCompletionChunk } from '@/local-copilot/lib/providers/types'
import { generateToolUseId } from '@/providers/bedrock/utils'

/** DeepSeek V3.2 native tool-call token (`｜` is U+FF5C). */
const DSML_TOKEN = '｜DSML｜'

const FUNCTION_CALLS_OPEN_RE = /<\s*[|｜]\s*DSML\s*[|｜]\s*function_calls\b/gi
const FUNCTION_CALLS_CLOSE_RE = /<\/\s*[|｜]\s*DSML\s*[|｜]\s*function_calls\s*>/gi
const INVOKE_RE = /<｜DSML｜invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜DSML｜invoke>/g
const PARAMETER_RE =
  /<｜DSML｜parameter\s+name="([^"]+)"\s+string="(true|false)"\s*>([\s\S]*?)<\/｜DSML｜parameter>/g

const CANONICAL_OPEN_TARGETS = [
  `<${DSML_TOKEN}function_calls>`,
  `<${DSML_TOKEN}invoke`,
  `<${DSML_TOKEN}parameter`,
  `</${DSML_TOKEN}function_calls>`,
  `</${DSML_TOKEN}invoke>`,
  `</${DSML_TOKEN}parameter>`,
  '<|DSML|function_calls>',
  '<|DSML|invoke',
  '<|DSML|parameter',
  '</|DSML|function_calls>',
  '</|DSML|invoke>',
  '</|DSML|parameter>',
] as const

export interface RecoveredDeepSeekToolCall {
  name: string
  arguments: string
}

export interface DeepSeekDsmlRecoveryOptions {
  allowedToolNames?: ReadonlySet<string>
  generateToolCallId?: (name: string) => string
}

export interface DeepSeekDsmlRecoverySession {
  push: (chunk: ChatCompletionChunk) => ChatCompletionChunk[]
}

/** True for Bedrock / catalog DeepSeek model ids. */
export function isDeepSeekBedrockModel(model: string): boolean {
  return /deepseek/i.test(model)
}

/**
 * Rewrites DeepSeek V3.2 tag variants (`<｜DSML｜`, `<|DSML|`, spaced pipes)
 * to the canonical fullwidth token so parsers can use a single pattern.
 */
export function canonicalizeDeepSeekDsml(text: string): string {
  return text.replace(/<\s*(\/?)\s*[|｜]\s*DSML\s*[|｜]\s*/gi, (_match, slash: string) => {
    return `<${slash}｜DSML｜`
  })
}

/**
 * Removes DeepSeek native tool-call markup, including the trailing incomplete
 * `<｜DSML｜function_calls` fragment Bedrock Converse often leaves in text.
 */
export function stripDeepSeekDsmlMarkup(text: string): string {
  if (!text) return text
  if (!/[|｜]\s*DSML\s*[|｜]/i.test(text) && !/DSML/i.test(text)) return text

  let remaining = text
  let stripped = ''

  while (remaining.length > 0) {
    const open = nextFunctionCallsOpen(remaining)
    if (!open) {
      stripped += dropIncompleteDsmlSuffix(remaining)
      break
    }

    stripped += remaining.slice(0, open.index)
    const fromOpen = remaining.slice(open.index)
    const close = nextFunctionCallsClose(fromOpen)
    if (!close) {
      break
    }
    remaining = fromOpen.slice(close.index + close.length)
  }

  return stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * Parses complete `<｜DSML｜function_calls>` blocks into JSON-argument tool calls.
 */
export function parseDeepSeekDsmlToolCalls(text: string): RecoveredDeepSeekToolCall[] {
  const canonical = canonicalizeDeepSeekDsml(text)
  const calls: RecoveredDeepSeekToolCall[] = []
  const blockRe = /<｜DSML｜function_calls\s*>?([\s\S]*?)<\/｜DSML｜function_calls>/g

  for (const blockMatch of canonical.matchAll(blockRe)) {
    calls.push(...parseInvokeBlocks(blockMatch[1] ?? ''))
  }

  if (calls.length === 0) {
    calls.push(...parseInvokeBlocks(canonical))
  }

  return calls
}

/**
 * Filters streamed Bedrock chunks so DeepSeek DSML never reaches the UI, and
 * recovers tool calls when Converse omitted native `toolUse` blocks.
 */
export function createDeepSeekDsmlRecoverySession(
  options: DeepSeekDsmlRecoveryOptions = {}
): DeepSeekDsmlRecoverySession {
  // Bedrock Converse rejects toolUseId longer than 64 chars — never invent
  // `${name}-${uuid}` (long Arena tool names overflow that limit).
  const generateToolCallId = options.generateToolCallId ?? generateToolUseId
  const allowedToolNames = options.allowedToolNames
  let hold = ''
  let droppedMarkup = ''
  let nativeToolCallCount = 0
  let finished = false

  const recoverFromMarkup = (markup: string): ChatCompletionChunk[] => {
    if (nativeToolCallCount > 0) return []
    const recovered = parseDeepSeekDsmlToolCalls(markup).filter((call) => {
      if (!allowedToolNames || allowedToolNames.size === 0) return false
      return allowedToolNames.has(call.name)
    })
    return recovered.map((call) => ({
      type: 'tool_call' as const,
      toolCall: {
        id: generateToolCallId(call.name),
        name: call.name,
        arguments: call.arguments,
      },
    }))
  }

  return {
    push(chunk: ChatCompletionChunk): ChatCompletionChunk[] {
      if (finished) return []

      if (chunk.type === 'text' && chunk.content) {
        hold += chunk.content
        const extracted = extractVisibleText(hold)
        hold = extracted.hold
        droppedMarkup += extracted.dropped
        if (!extracted.visible) return []
        return [{ type: 'text', content: extracted.visible }]
      }

      if (chunk.type === 'tool_call' && chunk.toolCall) {
        nativeToolCallCount += 1
        return [chunk]
      }

      if (chunk.type === 'done') {
        finished = true
        const remaining = hold
        hold = ''
        const flushed: ChatCompletionChunk[] = []
        if (remaining) {
          const open = nextFunctionCallsOpen(remaining)
          if (open) {
            if (open.index > 0) {
              flushed.push({ type: 'text', content: remaining.slice(0, open.index) })
            }
            droppedMarkup += remaining.slice(open.index)
          } else {
            flushed.push({ type: 'text', content: remaining })
          }
        }
        flushed.push(...recoverFromMarkup(droppedMarkup))
        droppedMarkup = ''
        const finishReason = flushed.some((item) => item.type === 'tool_call')
          ? 'tool_calls'
          : (chunk.finishReason ?? 'stop')
        flushed.push({ ...chunk, finishReason })
        return flushed
      }

      return [chunk]
    },
  }
}

/**
 * Wraps a Bedrock chunk stream with DeepSeek DSML recovery when the model is DeepSeek.
 */
export async function* recoverDeepSeekDsmlToolCallsIfNeeded(
  model: string,
  tools: Array<{ name: string }> | undefined,
  source: AsyncIterable<ChatCompletionChunk>,
  generateToolCallId?: (name: string) => string
): AsyncGenerator<ChatCompletionChunk, void, undefined> {
  if (!isDeepSeekBedrockModel(model)) {
    for await (const chunk of source) {
      yield chunk
    }
    return
  }

  const session = createDeepSeekDsmlRecoverySession({
    allowedToolNames: new Set((tools ?? []).map((tool) => tool.name)),
    generateToolCallId,
  })

  for await (const chunk of source) {
    for (const out of session.push(chunk)) {
      yield out
    }
  }
}

function parseInvokeBlocks(body: string): RecoveredDeepSeekToolCall[] {
  const invokeRe = new RegExp(INVOKE_RE.source, 'g')
  const calls: RecoveredDeepSeekToolCall[] = []
  for (const invokeMatch of body.matchAll(invokeRe)) {
    const name = invokeMatch[1]?.trim()
    if (!name) continue
    calls.push({
      name,
      arguments: encodeInvokeArguments(invokeMatch[2] ?? ''),
    })
  }
  return calls
}

function encodeInvokeArguments(body: string): string {
  const params: Record<string, unknown> = {}
  let sawParameter = false
  const parameterRe = new RegExp(PARAMETER_RE.source, 'g')

  for (const match of body.matchAll(parameterRe)) {
    sawParameter = true
    const key = match[1]
    if (!key) continue
    params[key] = decodeParameterValue(match[2] ?? 'true', match[3] ?? '')
  }

  if (sawParameter) {
    return JSON.stringify(params)
  }

  const trimmed = body.trim()
  if (!trimmed) return '{}'
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      return JSON.stringify(parsed)
    }
  } catch {
    return '{}'
  }
  return '{}'
}

function decodeParameterValue(isString: string, raw: string): unknown {
  if (isString === 'true') return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function nextFunctionCallsOpen(text: string): { index: number; length: number } | null {
  FUNCTION_CALLS_OPEN_RE.lastIndex = 0
  const match = FUNCTION_CALLS_OPEN_RE.exec(text)
  if (!match) return null
  return { index: match.index, length: match[0].length }
}

function nextFunctionCallsClose(text: string): { index: number; length: number } | null {
  FUNCTION_CALLS_CLOSE_RE.lastIndex = 0
  const match = FUNCTION_CALLS_CLOSE_RE.exec(text)
  if (!match) return null
  return { index: match.index, length: match[0].length }
}

function extractVisibleText(buffer: string): { visible: string; hold: string; dropped: string } {
  let visible = ''
  let rest = buffer
  let dropped = ''

  while (rest.length > 0) {
    const open = nextFunctionCallsOpen(rest)
    if (!open) {
      const holdFrom = incompleteDsmlPrefixIndex(rest)
      if (holdFrom === -1) {
        visible += rest
        rest = ''
      } else {
        visible += rest.slice(0, holdFrom)
        rest = rest.slice(holdFrom)
      }
      break
    }

    visible += rest.slice(0, open.index)
    const fromOpen = rest.slice(open.index)
    const close = nextFunctionCallsClose(fromOpen)
    if (!close) {
      rest = fromOpen
      break
    }

    dropped += fromOpen.slice(0, close.index + close.length)
    rest = fromOpen.slice(close.index + close.length)
  }

  return { visible, hold: rest, dropped }
}

function dropIncompleteDsmlSuffix(text: string): string {
  const holdFrom = nextFunctionCallsOpen(text)?.index ?? incompleteDsmlPrefixIndex(text)
  if (holdFrom === -1) return text
  return text.slice(0, holdFrom)
}

function incompleteDsmlPrefixIndex(text: string): number {
  const from = Math.max(0, text.length - 64)
  for (let index = from; index < text.length; index++) {
    if (text[index] === '<' && isPossibleDsmlTagPrefix(text.slice(index))) return index
  }
  return -1
}

function isPossibleDsmlTagPrefix(fragment: string): boolean {
  if (!fragment.startsWith('<')) return false
  const compact = fragment.replace(/\s+/g, '')
  return CANONICAL_OPEN_TARGETS.some((target) => {
    const ascii = target.replace(/｜/g, '|')
    return target.startsWith(compact) || ascii.startsWith(compact)
  })
}
