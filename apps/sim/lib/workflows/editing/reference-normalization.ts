import { isUuid, normalizeName, REFERENCE, SPECIAL_REFERENCE_PREFIXES } from '@/executor/constants'
import { createReferencePattern } from '@/executor/utils/reference-validation'

interface ReferenceableBlock {
  name?: string
  type?: string
  subBlocks?: Record<string, { value?: unknown } | undefined>
}

/**
 * Maps block UUIDs to the normalized name used in workflow reference tags.
 */
export function buildBlockIdToNormalizedNameMap(
  blocks: Record<string, ReferenceableBlock | undefined>
): Map<string, string> {
  const map = new Map<string, string>()
  for (const [id, block] of Object.entries(blocks)) {
    if (!block) continue
    const displayName = block.name?.trim() || block.type || id
    map.set(id, normalizeName(displayName))
  }
  return map
}

function normalizeReferenceContent(content: string, idToName: Map<string, string>): string {
  const parts = content.split(REFERENCE.PATH_DELIMITER)
  if (parts.length === 0) return content

  const [first, ...rest] = parts
  if ((SPECIAL_REFERENCE_PREFIXES as readonly string[]).includes(first)) {
    return content
  }

  if (!isUuid(first)) {
    return content
  }

  const blockName = idToName.get(first)
  if (!blockName) {
    return content
  }

  return rest.length > 0
    ? `${blockName}${REFERENCE.PATH_DELIMITER}${rest.join(REFERENCE.PATH_DELIMITER)}`
    : blockName
}

/**
 * Rewrites `<uuid.field>` references to `<blockName.field>` using the workflow block map.
 */
export function normalizeBlockReferencesInString(
  value: string,
  idToName: Map<string, string>
): string {
  const pattern = createReferencePattern()
  return value.replace(pattern, (full, inner: string) => {
    const normalized = normalizeReferenceContent(inner.trim(), idToName)
    if (normalized === inner.trim()) return full
    return `${REFERENCE.START}${normalized}${REFERENCE.END}`
  })
}

/**
 * Recursively normalizes block references inside input values.
 */
export function normalizeBlockReferencesInValue(
  value: unknown,
  idToName: Map<string, string>
): unknown {
  if (typeof value === 'string') {
    return normalizeBlockReferencesInString(value, idToName)
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeBlockReferencesInValue(item, idToName))
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = normalizeBlockReferencesInValue(nested, idToName)
    }
    return result
  }

  return value
}

export function normalizeBlockReferencesInInputs<T extends Record<string, unknown>>(
  inputs: T,
  blocks: Record<string, ReferenceableBlock | undefined>
): T {
  const idToName = buildBlockIdToNormalizedNameMap(blocks)
  return normalizeBlockReferencesInValue(inputs, idToName) as T
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrites `<oldNormalizedName.…>` tags to `<newNormalizedName.…>` (UI rename parity).
 */
export function rewriteNormalizedBlockNameInValue(
  value: unknown,
  oldNormalizedName: string,
  newNormalizedName: string
): unknown {
  if (!oldNormalizedName || oldNormalizedName === newNormalizedName) return value

  if (typeof value === 'string') {
    const pattern = new RegExp(
      `${REFERENCE.START}${escapeRegExp(oldNormalizedName)}(?=${escapeRegExp(REFERENCE.PATH_DELIMITER)}|${escapeRegExp(REFERENCE.END)})`,
      'g'
    )
    return value.replace(pattern, `${REFERENCE.START}${newNormalizedName}`)
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteNormalizedBlockNameInValue(item, oldNormalizedName, newNormalizedName)
    )
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = rewriteNormalizedBlockNameInValue(nested, oldNormalizedName, newNormalizedName)
    }
    return result
  }

  return value
}

/**
 * After a block rename, rewrite name-based refs in every other block's subBlocks.
 * Matches the canvas `updateBlockName` behavior so merge/function code stays valid.
 */
export function rewriteBlockNameReferencesInWorkflowBlocks(
  blocks: Record<string, ReferenceableBlock | undefined>,
  renamedBlockId: string,
  oldDisplayName: string,
  newDisplayName: string
): void {
  const oldNormalizedName = normalizeName(oldDisplayName)
  const newNormalizedName = normalizeName(newDisplayName)
  if (!oldNormalizedName || oldNormalizedName === newNormalizedName) return

  for (const [blockId, block] of Object.entries(blocks)) {
    if (!block || blockId === renamedBlockId || !block.subBlocks) continue
    for (const subBlock of Object.values(block.subBlocks)) {
      if (!subBlock || typeof subBlock !== 'object') continue
      subBlock.value = rewriteNormalizedBlockNameInValue(
        subBlock.value,
        oldNormalizedName,
        newNormalizedName
      )
    }
  }
}
