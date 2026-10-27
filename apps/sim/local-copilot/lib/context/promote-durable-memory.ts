import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { truncate } from '@sim/utils/string'
import { userMemoryServerTool } from '@/lib/mothership/tools/server/other/user-memory'
import {
  type PreferenceMemoryCandidate,
  preferenceKeyFromText,
} from '@/local-copilot/lib/context/follow-up-directives'
import type { SessionMemory } from '@/local-copilot/lib/context/session-memory'

const logger = createLogger('LocalCopilotPromoteDurableMemory')

/** Design cap for inferred promotions (≤ 0.8). */
export const INFERRED_USER_MEMORY_CONFIDENCE = 0.8

/** Soft cap so a single refresh cannot flood user_memory. */
export const MAX_DURABLE_PROMOTIONS_PER_REFRESH = 8

const SECRET_PATTERN =
  /\b(api[_-\s]?key|password|passwd|secret|token|credential|bearer\s+[a-z0-9._-]+|sk-[a-z0-9]{10,}|AKIA[0-9A-Z]{16})\b/i

const PREFERENCE_LIKE_PATTERN =
  /\b(always|never|prefer|remember|don'?t|do not|from now on|instead of|use .+ instead)\b/i

const EPHEMERAL_ENTITY_PATTERN =
  /\b(execution[-_]?id|run[-_]?id|msg[-_]?id|request[-_]?id|temp[-_]|tmp[-_])/i

export type DurableUserMemoryCandidate = PreferenceMemoryCandidate & {
  memoryType: 'preference' | 'correction' | 'entity'
}

/**
 * True when text looks like a secret / credential and must never be promoted.
 */
export function looksLikeSecretMemoryValue(text: string): boolean {
  return SECRET_PATTERN.test(text)
}

/**
 * Extracts durable preference/entity candidates from session memory for phase-2
 * promotion into `user_memory`. Skips chat-ephemeral fields (progress, open
 * questions, runs, approvals, failures, verification).
 */
export function extractDurableUserMemoryCandidates(
  memory: SessionMemory,
  previous: SessionMemory | null = null
): DurableUserMemoryCandidate[] {
  const previousKeys = new Set(
    previous ? extractDurableUserMemoryCandidates(previous, null).map((item) => item.key) : []
  )
  const previousValues = new Set(
    previous
      ? extractDurableUserMemoryCandidates(previous, null).map((item) => item.value.toLowerCase())
      : []
  )

  const candidates: DurableUserMemoryCandidate[] = []

  for (const constraint of memory.constraints) {
    pushCandidate(candidates, {
      key: preferenceKeyFromText(constraint),
      value: constraint,
      memoryType: /instead|not that|i (?:said|meant)|wrong|actually|don'?t|do not/i.test(constraint)
        ? 'correction'
        : 'preference',
    })
  }

  for (const decision of memory.decisions) {
    if (!PREFERENCE_LIKE_PATTERN.test(decision)) continue
    pushCandidate(candidates, {
      key: preferenceKeyFromText(decision),
      value: decision,
      memoryType: 'preference',
    })
  }

  for (const workflow of memory.entities.workflows) {
    pushEntityCandidate(candidates, 'workflow', workflow)
  }
  for (const block of memory.entities.blocks) {
    pushEntityCandidate(candidates, 'block', block)
  }
  for (const file of memory.entities.files) {
    pushEntityCandidate(candidates, 'file', file)
  }

  return candidates
    .filter((candidate) => {
      if (previousKeys.has(candidate.key)) return false
      if (previousValues.has(candidate.value.toLowerCase())) return false
      return true
    })
    .slice(0, MAX_DURABLE_PROMOTIONS_PER_REFRESH)
}

/**
 * Soft-persists inferred durable memories. Never throws into the user turn.
 */
export async function persistInferredUserMemories(params: {
  userId: string
  workspaceId: string
  preferences: Array<PreferenceMemoryCandidate | DurableUserMemoryCandidate>
  confidence?: number
}): Promise<{ attempted: number; persisted: number }> {
  const confidence = Math.min(
    INFERRED_USER_MEMORY_CONFIDENCE,
    params.confidence ?? INFERRED_USER_MEMORY_CONFIDENCE
  )
  let persisted = 0
  const batch = params.preferences.slice(0, MAX_DURABLE_PROMOTIONS_PER_REFRESH)

  for (const preference of batch) {
    if (
      looksLikeSecretMemoryValue(preference.value) ||
      looksLikeSecretMemoryValue(preference.key)
    ) {
      logger.info('Skipping inferred user_memory promotion; looks like a secret', {
        key: preference.key,
      })
      continue
    }

    try {
      const result = await userMemoryServerTool.execute(
        {
          operation: 'add',
          key: preference.key,
          value: preference.value,
          memory_type: preference.memoryType,
          source: 'inferred',
          confidence,
          workspaceId: params.workspaceId,
        },
        { userId: params.userId, workspaceId: params.workspaceId }
      )
      if (result.success) {
        persisted += 1
      } else {
        logger.warn('Inferred user_memory persist failed', {
          key: preference.key,
          error: result.error ?? 'unknown',
        })
      }
    } catch (error) {
      logger.warn('Inferred user_memory persist threw', {
        key: preference.key,
        error: getErrorMessage(error),
      })
    }
  }

  return { attempted: batch.length, persisted }
}

/**
 * After a successful session-memory refresh, promote newly durable prefs/entities.
 */
export async function promoteDurableSessionMemoryToUserMemory(params: {
  userId: string
  workspaceId: string
  memory: SessionMemory
  previous: SessionMemory | null
}): Promise<{ attempted: number; persisted: number }> {
  const candidates = extractDurableUserMemoryCandidates(params.memory, params.previous)
  if (candidates.length === 0) {
    return { attempted: 0, persisted: 0 }
  }

  const result = await persistInferredUserMemories({
    userId: params.userId,
    workspaceId: params.workspaceId,
    preferences: candidates,
  })

  if (result.attempted > 0) {
    logger.info('Promoted durable session memory into user_memory', {
      attempted: result.attempted,
      persisted: result.persisted,
      coveredThroughMessageId: params.memory.coveredThroughMessageId,
    })
  }

  return result
}

function pushCandidate(
  candidates: DurableUserMemoryCandidate[],
  candidate: DurableUserMemoryCandidate
): void {
  const value = truncate(candidate.value.trim(), 280, '')
  if (value.length < 8) return
  if (looksLikeSecretMemoryValue(value)) return
  if (candidates.some((existing) => existing.key === candidate.key)) return
  candidates.push({ ...candidate, value })
}

function pushEntityCandidate(
  candidates: DurableUserMemoryCandidate[],
  kind: 'workflow' | 'block' | 'file',
  raw: string
): void {
  const value = truncate(raw.trim(), 280, '')
  if (value.length < 2) return
  if (looksLikeSecretMemoryValue(value)) return
  if (EPHEMERAL_ENTITY_PATTERN.test(value)) return
  // Prefer named entities; skip bare ultra-short opaque ids.
  if (/^[a-f0-9-]{8,}$/i.test(value) && value.length < 12) return

  pushCandidate(candidates, {
    key: `entity_${kind}_${preferenceKeyFromText(value)}`,
    value: `${kind}: ${value}`,
    memoryType: 'entity',
  })
}
