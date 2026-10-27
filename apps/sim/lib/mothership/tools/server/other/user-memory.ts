import { db } from '@sim/db'
import { localCopilotUserMemory } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { truncate } from '@sim/utils/string'
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'
// import { UserMemory } from '@/lib/mothership/generated/tool-catalog-v1'
import type { BaseServerTool, ServerToolContext } from '@/lib/mothership/tools/server/base-tool'

const logger = createLogger('UserMemoryServerTool')

/** Catalog entry was dropped from tool-catalog-v1; keep the stable tool id locally. */
const USER_MEMORY_TOOL_ID = 'user_memory' as const

const MEMORY_TYPES = new Set(['preference', 'entity', 'history', 'correction'])
const SOURCES = new Set(['explicit', 'inferred'])
const OPERATIONS = new Set(['add', 'search', 'delete', 'correct', 'list'])

const MAX_KEY_LENGTH = 128
const MAX_VALUE_LENGTH = 4_000
const MAX_LIST_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 10

export interface UserMemoryParams {
  operation: string
  key?: string
  value?: string
  correct_value?: string
  query?: string
  memory_type?: string
  source?: string
  confidence?: number
  limit?: number
  workspaceId?: string
}

export interface UserMemoryRecord {
  id: string
  key: string
  value: string
  memoryType: string
  source: string
  confidence: number
  workspaceId: string | null
  updatedAt: string
}

export interface UserMemoryResult {
  operation: string
  success: boolean
  memory?: UserMemoryRecord
  memories?: UserMemoryRecord[]
  total?: number
  error?: string
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_')
}

function toRecord(row: typeof localCopilotUserMemory.$inferSelect): UserMemoryRecord {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    memoryType: row.memoryType,
    source: row.source,
    confidence: row.confidence,
    workspaceId: row.workspaceId ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function resolveWorkspaceScope(
  params: UserMemoryParams,
  context?: ServerToolContext
): string | null {
  const fromParams =
    typeof params.workspaceId === 'string' && params.workspaceId.trim()
      ? params.workspaceId.trim()
      : null
  const fromContext =
    typeof context?.workspaceId === 'string' && context.workspaceId.trim()
      ? context.workspaceId.trim()
      : null
  return fromParams ?? fromContext
}

/**
 * Loads high-confidence memories for Local Copilot context injection.
 * Includes user-global rows (workspace_id null) and workspace-scoped rows.
 */
export async function loadUserMemoriesForContext(
  userId: string,
  workspaceId: string,
  limit = 20
): Promise<UserMemoryRecord[]> {
  const rows = await db
    .select()
    .from(localCopilotUserMemory)
    .where(
      and(
        eq(localCopilotUserMemory.userId, userId),
        or(
          isNull(localCopilotUserMemory.workspaceId),
          eq(localCopilotUserMemory.workspaceId, workspaceId)
        ),
        sql`${localCopilotUserMemory.confidence} >= 0.7`
      )
    )
    .orderBy(desc(localCopilotUserMemory.confidence), desc(localCopilotUserMemory.updatedAt))
    .limit(Math.min(limit, MAX_LIST_LIMIT))

  return rows.map(toRecord)
}

async function addMemory(
  params: UserMemoryParams,
  userId: string,
  workspaceId: string | null
): Promise<UserMemoryResult> {
  if (!params.key?.trim()) {
    return { operation: 'add', success: false, error: 'key is required for add' }
  }
  if (!params.value?.trim()) {
    return { operation: 'add', success: false, error: 'value is required for add' }
  }

  const key = normalizeKey(params.key)
  if (key.length > MAX_KEY_LENGTH) {
    return { operation: 'add', success: false, error: `key must be ≤ ${MAX_KEY_LENGTH} chars` }
  }

  const value = truncate(params.value.trim(), MAX_VALUE_LENGTH, '')
  const memoryType =
    params.memory_type && MEMORY_TYPES.has(params.memory_type) ? params.memory_type : 'preference'
  const source = params.source && SOURCES.has(params.source) ? params.source : 'explicit'
  const confidence =
    typeof params.confidence === 'number' && Number.isFinite(params.confidence)
      ? Math.min(1, Math.max(0, params.confidence))
      : source === 'inferred'
        ? 0.8
        : 1

  const existing = await db
    .select()
    .from(localCopilotUserMemory)
    .where(
      and(
        eq(localCopilotUserMemory.userId, userId),
        eq(localCopilotUserMemory.key, key),
        workspaceId
          ? eq(localCopilotUserMemory.workspaceId, workspaceId)
          : isNull(localCopilotUserMemory.workspaceId)
      )
    )
    .limit(1)

  if (existing[0]) {
    const [updated] = await db
      .update(localCopilotUserMemory)
      .set({
        value,
        memoryType,
        source,
        confidence,
        updatedAt: new Date(),
      })
      .where(eq(localCopilotUserMemory.id, existing[0].id))
      .returning()

    return { operation: 'add', success: true, memory: toRecord(updated) }
  }

  const [inserted] = await db
    .insert(localCopilotUserMemory)
    .values({
      userId,
      workspaceId,
      key,
      value,
      memoryType,
      source,
      confidence,
    })
    .returning()

  return { operation: 'add', success: true, memory: toRecord(inserted) }
}

async function correctMemory(
  params: UserMemoryParams,
  userId: string,
  workspaceId: string | null
): Promise<UserMemoryResult> {
  if (!params.key?.trim()) {
    return { operation: 'correct', success: false, error: 'key is required for correct' }
  }
  if (!params.correct_value?.trim()) {
    return {
      operation: 'correct',
      success: false,
      error: 'correct_value is required for correct',
    }
  }

  const key = normalizeKey(params.key)
  const [existing] = await db
    .select()
    .from(localCopilotUserMemory)
    .where(
      and(
        eq(localCopilotUserMemory.userId, userId),
        eq(localCopilotUserMemory.key, key),
        workspaceId
          ? eq(localCopilotUserMemory.workspaceId, workspaceId)
          : isNull(localCopilotUserMemory.workspaceId)
      )
    )
    .limit(1)

  if (!existing) {
    return { operation: 'correct', success: false, error: `No memory found for key "${key}"` }
  }

  const [updated] = await db
    .update(localCopilotUserMemory)
    .set({
      value: truncate(params.correct_value.trim(), MAX_VALUE_LENGTH, ''),
      memoryType: 'correction',
      source: 'explicit',
      confidence: 1,
      updatedAt: new Date(),
    })
    .where(eq(localCopilotUserMemory.id, existing.id))
    .returning()

  return { operation: 'correct', success: true, memory: toRecord(updated) }
}

async function deleteMemory(
  params: UserMemoryParams,
  userId: string,
  workspaceId: string | null
): Promise<UserMemoryResult> {
  if (!params.key?.trim()) {
    return { operation: 'delete', success: false, error: 'key is required for delete' }
  }

  const key = normalizeKey(params.key)
  const deleted = await db
    .delete(localCopilotUserMemory)
    .where(
      and(
        eq(localCopilotUserMemory.userId, userId),
        eq(localCopilotUserMemory.key, key),
        workspaceId
          ? eq(localCopilotUserMemory.workspaceId, workspaceId)
          : isNull(localCopilotUserMemory.workspaceId)
      )
    )
    .returning()

  if (deleted.length === 0) {
    return { operation: 'delete', success: false, error: `No memory found for key "${key}"` }
  }

  return { operation: 'delete', success: true, memory: toRecord(deleted[0]) }
}

async function searchMemories(
  params: UserMemoryParams,
  userId: string,
  workspaceId: string | null
): Promise<UserMemoryResult> {
  const query = params.query?.trim()
  if (!query) {
    return { operation: 'search', success: false, error: 'query is required for search' }
  }

  const limit = Math.min(
    Math.max(1, typeof params.limit === 'number' ? Math.floor(params.limit) : DEFAULT_SEARCH_LIMIT),
    MAX_LIST_LIMIT
  )
  const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`

  const scope = workspaceId
    ? or(
        isNull(localCopilotUserMemory.workspaceId),
        eq(localCopilotUserMemory.workspaceId, workspaceId)
      )
    : isNull(localCopilotUserMemory.workspaceId)

  const rows = await db
    .select()
    .from(localCopilotUserMemory)
    .where(
      and(
        eq(localCopilotUserMemory.userId, userId),
        scope,
        or(ilike(localCopilotUserMemory.key, pattern), ilike(localCopilotUserMemory.value, pattern))
      )
    )
    .orderBy(desc(localCopilotUserMemory.confidence), desc(localCopilotUserMemory.updatedAt))
    .limit(limit)

  return {
    operation: 'search',
    success: true,
    memories: rows.map(toRecord),
    total: rows.length,
  }
}

async function listMemories(
  params: UserMemoryParams,
  userId: string,
  workspaceId: string | null
): Promise<UserMemoryResult> {
  const limit = Math.min(
    Math.max(1, typeof params.limit === 'number' ? Math.floor(params.limit) : DEFAULT_SEARCH_LIMIT),
    MAX_LIST_LIMIT
  )

  const scope = workspaceId
    ? or(
        isNull(localCopilotUserMemory.workspaceId),
        eq(localCopilotUserMemory.workspaceId, workspaceId)
      )
    : undefined

  const rows = await db
    .select()
    .from(localCopilotUserMemory)
    .where(
      and(
        eq(localCopilotUserMemory.userId, userId),
        scope,
        params.memory_type && MEMORY_TYPES.has(params.memory_type)
          ? eq(localCopilotUserMemory.memoryType, params.memory_type)
          : undefined
      )
    )
    .orderBy(desc(localCopilotUserMemory.updatedAt))
    .limit(limit)

  return {
    operation: 'list',
    success: true,
    memories: rows.map(toRecord),
    total: rows.length,
  }
}

export const userMemoryServerTool: BaseServerTool<UserMemoryParams, UserMemoryResult> = {
  name: USER_MEMORY_TOOL_ID,
  async execute(params: UserMemoryParams, context?: ServerToolContext): Promise<UserMemoryResult> {
    const userId = context?.userId
    if (!userId) {
      return {
        operation: params.operation ?? 'unknown',
        success: false,
        error: 'userId is required',
      }
    }

    const operation = typeof params.operation === 'string' ? params.operation.trim() : ''
    if (!OPERATIONS.has(operation)) {
      return {
        operation: operation || 'unknown',
        success: false,
        error: `Invalid operation. Use: ${[...OPERATIONS].join(', ')}`,
      }
    }

    const workspaceId = resolveWorkspaceScope(params, context)

    logger.info('Executing user_memory', {
      operation,
      userId,
      workspaceId,
      key: params.key ? normalizeKey(params.key) : undefined,
    })

    switch (operation) {
      case 'add':
        return addMemory(params, userId, workspaceId)
      case 'correct':
        return correctMemory(params, userId, workspaceId)
      case 'delete':
        return deleteMemory(params, userId, workspaceId)
      case 'search':
        return searchMemories(params, userId, workspaceId)
      case 'list':
        return listMemories(params, userId, workspaceId)
      default:
        return { operation, success: false, error: `Unhandled operation: ${operation}` }
    }
  },
}
