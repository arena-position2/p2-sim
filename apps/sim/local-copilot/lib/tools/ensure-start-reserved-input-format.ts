import { generateId } from '@sim/utils/id'
import { normalizeInputFormatValue } from '@/lib/workflows/input-format'
import type { InputFormatFieldState } from '@/lib/workflows/input-format-schema'
import { START_BLOCK_RESERVED_FIELDS } from '@/lib/workflows/types'

const INPUT_FORMAT_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'file[]',
] as const

type InputFormatFieldType = (typeof INPUT_FORMAT_FIELD_TYPES)[number]

export interface StartReservedInputFormatSnapshot {
  blocks?: Record<
    string,
    {
      type?: string
      subBlocks?: Record<string, { value?: unknown }>
    }
  >
  /** Start ids known this turn (e.g. create_workflow startBlockId) when context is still empty. */
  knownStartBlockIds?: readonly string[]
}

interface MutableOp {
  block_id: string
  operation_type: string
  params?: Record<string, unknown>
}

/**
 * Ensures Start's reserved chat fields (`input`, `conversationId`, `files`) are
 * present in `inputFormat`, then appends any custom named fields.
 *
 * Arena Copilot seam — kept out of upstream `input-format.ts` / edit builders so
 * Sim merges stay thin. Same shape as the canvas chat "Add inputs" repair.
 */
export function ensureStartReservedInputFormatFields(
  inputFormatValue: unknown
): InputFormatFieldState[] {
  const normalized = normalizeInputFormatValue(inputFormatValue)
  const reservedLower = new Set(
    START_BLOCK_RESERVED_FIELDS.map((fieldName) => fieldName.toLowerCase())
  )

  const existingByReservedName = new Map<string, Record<string, unknown>>()
  for (const field of normalized) {
    const name = field.name?.trim()
    if (!name) continue
    const lower = name.toLowerCase()
    if (reservedLower.has(lower) && !existingByReservedName.has(lower)) {
      existingByReservedName.set(lower, field as Record<string, unknown>)
    }
  }

  const reservedFields = START_BLOCK_RESERVED_FIELDS.map((fieldName) => {
    const existing = existingByReservedName.get(fieldName.toLowerCase())
    if (existing) {
      return toFieldState(existing, {
        name: fieldName,
        type: fieldName === 'files' ? 'file[]' : coerceFieldType(existing.type, 'string'),
      })
    }
    return {
      id: generateId(),
      name: fieldName,
      type: fieldName === 'files' ? ('file[]' as const) : ('string' as const),
      value: '',
      collapsed: false,
    }
  })

  const customFields = normalized
    .filter((field) => {
      const name = field.name?.trim().toLowerCase()
      return Boolean(name) && !reservedLower.has(name as string)
    })
    .map((field) => toFieldState(field as Record<string, unknown>))

  return [...reservedFields, ...customFields]
}

/**
 * Rewrites Arena Copilot `edit_workflow` ops so Start always carries reserved
 * `inputFormat` rows (and injects a Start edit when the open workflow is missing them).
 */
export function ensureStartReservedInputFormatInEditOperations(
  operations: unknown[],
  snapshot?: StartReservedInputFormatSnapshot
): unknown[] {
  if (!Array.isArray(operations) || operations.length === 0) return operations

  const ops = cloneOperations(operations)
  if (ops.length === 0) return operations

  let changed = false
  const startIds = collectStartBlockIds(ops, snapshot)
  const handledStartIds = new Set<string>()

  for (const op of ops) {
    if (op.operation_type === 'delete') continue
    if (!startIds.has(op.block_id) && !isStartTriggerAdd(op)) continue

    const fromOp = readInputFormatFromOp(op)
    const fromSnapshot = readInputFormatFromSnapshot(op.block_id, snapshot)
    if (fromOp !== undefined && !isMissingReservedFields(fromOp)) {
      handledStartIds.add(op.block_id)
      continue
    }

    writeInputFormatOnOp(
      op,
      ensureStartReservedInputFormatFields(fromOp !== undefined ? fromOp : fromSnapshot)
    )
    changed = true
    handledStartIds.add(op.block_id)
  }

  for (const [blockId, block] of Object.entries(snapshot?.blocks ?? {})) {
    if (block.type !== 'start_trigger') continue
    if (handledStartIds.has(blockId)) continue
    const current = block.subBlocks?.inputFormat?.value
    if (!isMissingReservedFields(current)) continue

    ops.push({
      block_id: blockId,
      operation_type: 'edit',
      params: {
        inputs: {
          inputFormat: ensureStartReservedInputFormatFields(current),
        },
      },
    })
    changed = true
    handledStartIds.add(blockId)
  }

  for (const blockId of snapshot?.knownStartBlockIds ?? []) {
    if (!blockId.trim() || handledStartIds.has(blockId)) continue
    const current = snapshot?.blocks?.[blockId]?.subBlocks?.inputFormat?.value
    if (current !== undefined && !isMissingReservedFields(current)) continue

    ops.push({
      block_id: blockId,
      operation_type: 'edit',
      params: {
        inputs: {
          inputFormat: ensureStartReservedInputFormatFields(current),
        },
      },
    })
    changed = true
  }

  return changed ? ops : operations
}

function coerceFieldType(
  type: unknown,
  fallback: InputFormatFieldType = 'string'
): InputFormatFieldType {
  if (typeof type === 'string' && (INPUT_FORMAT_FIELD_TYPES as readonly string[]).includes(type)) {
    return type as InputFormatFieldType
  }
  return fallback
}

function toFieldState(
  field: Record<string, unknown>,
  overrides?: Partial<InputFormatFieldState>
): InputFormatFieldState {
  const name = (overrides?.name ?? (typeof field.name === 'string' ? field.name : '')).trim()
  const description = overrides?.description ?? field.description
  return {
    id:
      typeof overrides?.id === 'string'
        ? overrides.id
        : typeof field.id === 'string' && field.id.length > 0
          ? field.id
          : generateId(),
    name,
    type: coerceFieldType(overrides?.type ?? field.type),
    value:
      typeof overrides?.value === 'string'
        ? overrides.value
        : typeof field.value === 'string'
          ? field.value
          : '',
    collapsed:
      typeof overrides?.collapsed === 'boolean'
        ? overrides.collapsed
        : typeof field.collapsed === 'boolean'
          ? field.collapsed
          : false,
    ...(typeof description === 'string' && description ? { description } : {}),
  }
}

function isMissingReservedFields(inputFormatValue: unknown): boolean {
  const names = new Set(
    normalizeInputFormatValue(inputFormatValue)
      .map((field) => field.name?.trim().toLowerCase())
      .filter((name): name is string => Boolean(name))
  )
  return START_BLOCK_RESERVED_FIELDS.some((field) => !names.has(field.toLowerCase()))
}

function cloneOperations(operations: unknown[]): MutableOp[] {
  const cloned: MutableOp[] = []
  for (const item of operations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const blockId =
      typeof record.block_id === 'string'
        ? record.block_id
        : typeof record.blockId === 'string'
          ? record.blockId
          : ''
    const operationType =
      typeof record.operation_type === 'string'
        ? record.operation_type
        : typeof record.operationType === 'string'
          ? record.operationType
          : ''
    if (!blockId || !operationType) continue
    cloned.push({
      block_id: blockId,
      operation_type: operationType,
      params:
        record.params && typeof record.params === 'object' && !Array.isArray(record.params)
          ? { ...(record.params as Record<string, unknown>) }
          : {},
    })
  }
  return cloned
}

function collectStartBlockIds(
  ops: MutableOp[],
  snapshot?: StartReservedInputFormatSnapshot
): Set<string> {
  const ids = new Set<string>()
  for (const [blockId, block] of Object.entries(snapshot?.blocks ?? {})) {
    if (block.type === 'start_trigger') ids.add(blockId)
  }
  for (const blockId of snapshot?.knownStartBlockIds ?? []) {
    if (blockId.trim()) ids.add(blockId)
  }
  for (const op of ops) {
    if (isStartTriggerAdd(op)) ids.add(op.block_id)
  }
  return ids
}

function isStartTriggerAdd(op: MutableOp): boolean {
  if (op.operation_type !== 'add') return false
  const type = op.params?.type
  return type === 'start_trigger'
}

function readInputFormatFromOp(op: MutableOp): unknown {
  const inputs = op.params?.inputs
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return undefined
  return (inputs as Record<string, unknown>).inputFormat
}

function readInputFormatFromSnapshot(
  blockId: string,
  snapshot?: StartReservedInputFormatSnapshot
): unknown {
  return snapshot?.blocks?.[blockId]?.subBlocks?.inputFormat?.value
}

function writeInputFormatOnOp(op: MutableOp, fields: InputFormatFieldState[]): void {
  const params = op.params ?? {}
  const inputs =
    params.inputs && typeof params.inputs === 'object' && !Array.isArray(params.inputs)
      ? { ...(params.inputs as Record<string, unknown>) }
      : {}
  inputs.inputFormat = fields
  op.params = { ...params, inputs }
}
