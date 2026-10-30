import { getBlock } from '@/blocks/registry'

/**
 * Rewrites short / aliased dropdown values on Local `edit_workflow` ops to the
 * exact option ids the block schema expects (e.g. `search` → `search_gmail`).
 *
 * Only applies when exactly one option uniquely matches — never guesses among
 * ambiguous candidates. Uses this-turn `get_blocks_metadata` cache when present,
 * otherwise the live block registry for static dropdowns.
 */
export function coerceLocalEditDropdownInputs(
  operations: unknown[],
  options?: {
    blocksMetadataByType?: Map<string, unknown>
    existingBlocks?: Record<string, { type?: string }>
  }
): unknown[] {
  if (!Array.isArray(operations) || operations.length === 0) return operations

  const blockTypeById = collectBlockTypes(operations, options?.existingBlocks)
  let changed = false
  const next = operations.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const op = item as Record<string, unknown>
    const opType = operationType(op)
    if (opType !== 'add' && opType !== 'edit') return item

    const blockId = blockIdOf(op)
    const params = asRecord(op.params)
    if (!params) return item

    const inputs = asRecord(params.inputs)
    if (!inputs) return item

    const blockType =
      stringValue(params.type) ??
      stringValue(params.blockType) ??
      (blockId ? blockTypeById.get(blockId) : undefined)
    if (!blockType) return item

    const optionIdsByField = resolveDropdownOptionIds(blockType, options?.blocksMetadataByType)
    if (optionIdsByField.size === 0) return item

    let inputsChanged = false
    const nextInputs: Record<string, unknown> = { ...inputs }
    for (const [field, value] of Object.entries(inputs)) {
      if (typeof value !== 'string' || !value.trim()) continue
      const optionIds = optionIdsByField.get(field)
      if (!optionIds || optionIds.length === 0) continue
      const coerced = coerceDropdownValue(value, optionIds)
      if (coerced !== null && coerced !== value) {
        nextInputs[field] = coerced
        inputsChanged = true
      }
    }

    if (!inputsChanged) return item
    changed = true
    return {
      ...op,
      params: {
        ...params,
        inputs: nextInputs,
      },
    }
  })

  return changed ? next : operations
}

/**
 * Maps a model-supplied dropdown value to an exact option id when the match is unique.
 * Returns null when the value is already valid or cannot be uniquely resolved.
 */
export function coerceDropdownValue(value: string, optionIds: readonly string[]): string | null {
  const trimmed = value.trim()
  if (!trimmed || optionIds.length === 0) return null
  if (optionIds.includes(trimmed)) return null

  const lower = trimmed.toLowerCase()
  const caseInsensitive = optionIds.filter((id) => id.toLowerCase() === lower)
  if (caseInsensitive.length === 1) return caseInsensitive[0]

  const prefixMatches = optionIds.filter((id) => id.toLowerCase().startsWith(`${lower}_`))
  if (prefixMatches.length === 1) return prefixMatches[0]

  const suffixMatches = optionIds.filter((id) => id.toLowerCase().endsWith(`_${lower}`))
  if (suffixMatches.length === 1) return suffixMatches[0]

  return null
}

function resolveDropdownOptionIds(
  blockType: string,
  blocksMetadataByType?: Map<string, unknown>
): Map<string, string[]> {
  const fromMetadata = optionIdsFromMetadata(blocksMetadataByType?.get(blockType.toLowerCase()))
  if (fromMetadata.size > 0) return fromMetadata
  return optionIdsFromRegistry(blockType)
}

function optionIdsFromMetadata(metadata: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>()
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return result
  const record = metadata as Record<string, unknown>

  const inputs = asRecord(record.inputs)
  if (inputs) {
    for (const listKey of ['required', 'optional'] as const) {
      const list = inputs[listKey]
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        const field = asRecord(entry)
        if (!field) continue
        const name = stringValue(field.name)
        const options = stringOptionIds(field.options)
        if (name && options.length > 0) result.set(name, options)
      }
    }
  }

  const operations = asRecord(record.operations)
  if (operations) {
    const opIds = Object.keys(operations).filter((id) => id.trim().length > 0)
    if (opIds.length > 0 && !result.has('operation')) {
      result.set('operation', opIds)
    }
  }

  return result
}

function optionIdsFromRegistry(blockType: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const block = getBlock(blockType)
  if (!block?.subBlocks) return result

  for (const subBlock of block.subBlocks) {
    if (subBlock.type !== 'dropdown') continue
    if (typeof subBlock.options === 'function') continue
    if (!Array.isArray(subBlock.options) || subBlock.options.length === 0) continue
    const ids = subBlock.options
      .map((opt) => (typeof opt === 'string' ? opt : opt.id))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    if (ids.length > 0) result.set(subBlock.id, ids)
  }

  return result
}

function collectBlockTypes(
  operations: unknown[],
  existingBlocks?: Record<string, { type?: string }>
): Map<string, string> {
  const types = new Map<string, string>()
  if (existingBlocks) {
    for (const [id, block] of Object.entries(existingBlocks)) {
      const type = block.type?.trim()
      if (type) types.set(id, type)
    }
  }
  for (const item of operations) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const op = item as Record<string, unknown>
    const blockId = blockIdOf(op)
    if (!blockId) continue
    const params = asRecord(op.params)
    const type = stringValue(params?.type) ?? stringValue(params?.blockType)
    if (type) types.set(blockId, type)
  }
  return types
}

function stringOptionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim()]
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = (entry as Record<string, unknown>).id
      if (typeof id === 'string' && id.trim()) return [id.trim()]
    }
    return []
  })
}

function operationType(operation: Record<string, unknown>): string {
  const raw = operation.operation_type ?? operation.operationType ?? operation.type
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function blockIdOf(operation: Record<string, unknown>): string | undefined {
  return stringValue(operation.block_id) ?? stringValue(operation.blockId)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
