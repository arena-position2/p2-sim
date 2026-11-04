import type { ChatMessage } from '@/local-copilot/lib/providers/types'

/** Keep this many most-recent tool rounds verbatim; older tool bodies are fingerprinted. */
export const LOCAL_COPILOT_MICROCOMPACT_KEEP_RECENT_ROUNDS = 2

const CLEARED_PREFIX = '[Old tool result cleared'

/**
 * Resource ids that must survive microcompact so later rounds can call get/update/
 * add_connector/delete without rediscovering them (Arena KB create → connector spiral).
 */
const STICKY_ID_KEYS = [
  'knowledgeBaseId',
  'workflowId',
  'connectorId',
  'documentId',
  'tableId',
  'fileId',
  'serverId',
  'deploymentId',
  'chatId',
  'folderId',
] as const

export interface MicrocompactResult {
  messages: ChatMessage[]
  clearedCount: number
  charsFreed: number
}

export interface MicrocompactOptions {
  keepRecentRounds?: number
}

/**
 * Zero-cost compaction: replace aged tool-result bodies with short fingerprints.
 * Preserves user/assistant text and tool_use / tool_result pairing (same toolCallId).
 * Sticky create ids (knowledgeBaseId, workflowId, …) stay on the fingerprint.
 */
export function microcompactMessages(
  messages: ChatMessage[],
  options: MicrocompactOptions = {}
): MicrocompactResult {
  const keepRecentRounds = options.keepRecentRounds ?? LOCAL_COPILOT_MICROCOMPACT_KEEP_RECENT_ROUNDS

  const rounds = findToolRoundIndices(messages)
  if (rounds.length <= keepRecentRounds) {
    return { messages, clearedCount: 0, charsFreed: 0 }
  }

  const clearRounds = rounds.slice(0, Math.max(0, rounds.length - keepRecentRounds))
  const clearIndexSet = new Set(clearRounds.flat())
  if (clearIndexSet.size === 0) {
    return { messages, clearedCount: 0, charsFreed: 0 }
  }

  const toolNameByCallId = buildToolNameByCallId(messages)
  let clearedCount = 0
  let charsFreed = 0

  const next = messages.map((message, index) => {
    if (message.role !== 'tool' || !clearIndexSet.has(index)) return message

    const content = typeof message.content === 'string' ? message.content : ''
    if (content.startsWith(CLEARED_PREFIX)) return message

    const toolName = message.toolCallId ? toolNameByCallId.get(message.toolCallId) : undefined
    const fingerprint = fingerprintToolResult(toolName, content)
    if (fingerprint === content) return message

    clearedCount += 1
    charsFreed += Math.max(0, content.length - fingerprint.length)
    return { ...message, content: fingerprint }
  })

  return { messages: next, clearedCount, charsFreed }
}

/**
 * Applies {@link microcompactMessages} and replaces the array contents in place.
 */
export function applyMicrocompactInPlace(
  messages: ChatMessage[],
  options?: MicrocompactOptions
): Omit<MicrocompactResult, 'messages'> {
  const result = microcompactMessages(messages, options)
  if (result.clearedCount === 0) {
    return { clearedCount: 0, charsFreed: 0 }
  }
  messages.splice(0, messages.length, ...result.messages)
  return { clearedCount: result.clearedCount, charsFreed: result.charsFreed }
}

/**
 * Builds a compact fingerprint that keeps create/list resource ids for follow-up tools.
 * Exported for unit coverage of the sticky-id contract.
 */
export function fingerprintToolResult(toolName: string | undefined, content: string): string {
  const name = toolName?.trim() || 'tool'
  const parts: string[] = [name]
  try {
    const parsed = JSON.parse(content) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      if (typeof record.success === 'boolean') {
        parts.push(`success=${record.success}`)
      }
      const sticky = collectStickyFields(record)
      if (sticky.length > 0) {
        parts.push(...sticky)
      }
    }
  } catch {
    // Non-JSON tool bodies still get a name-only fingerprint.
  }
  return `${CLEARED_PREFIX} — ${parts.join(' ')}]`
}

function collectStickyFields(root: Record<string, unknown>): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const push = (key: string, value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    const token = `${key}=${trimmed}`
    if (seen.has(token)) return
    seen.add(token)
    out.push(token)
  }

  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || value === null || value === undefined) return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, depth + 1)
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>

    for (const key of STICKY_ID_KEYS) {
      const candidate = record[key]
      if (typeof candidate === 'string') push(key, candidate)
    }

    // create/get payloads nest the resource under `data` with bare `id` + `name`.
    if (typeof record.id === 'string') push('id', record.id)
    if (typeof record.name === 'string') {
      const name = record.name.trim()
      if (name) push('name', JSON.stringify(name))
    }

    if (record.data !== undefined) visit(record.data, depth + 1)
    if (Array.isArray(record.knowledgeBases)) visit(record.knowledgeBases, depth + 1)
    if (Array.isArray(record.deleted)) visit(record.deleted, depth + 1)
  }

  visit(root, 0)
  return out.slice(0, 12)
}

function findToolRoundIndices(messages: ChatMessage[]): number[][] {
  const rounds: number[][] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const toolIndices: number[] = []
      let cursor = index + 1
      while (cursor < messages.length && messages[cursor].role === 'tool') {
        toolIndices.push(cursor)
        cursor += 1
      }
      if (toolIndices.length > 0) rounds.push(toolIndices)
      index = cursor
      continue
    }
    index += 1
  }

  return rounds
}

function buildToolNameByCallId(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue
    for (const call of message.toolCalls) {
      map.set(call.id, call.name)
    }
  }
  return map
}
