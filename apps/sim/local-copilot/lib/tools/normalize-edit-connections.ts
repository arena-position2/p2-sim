import { createLogger } from '@sim/logger'
import { TRIGGER_TYPES } from '@/lib/workflows/triggers/types'

const logger = createLogger('LocalCopilotEditConnections')

const KNOWN_TRIGGER_TYPES = new Set<string>(Object.values(TRIGGER_TYPES))

const DEFAULT_SOURCE_HANDLES = new Set(['source', 'success', 'default', 'target', ''])

export interface LocalEditConnectionSnapshot {
  blocks?: Record<string, { type?: string; triggerMode?: boolean }>
  edges?: Array<{
    source: string
    target: string
    sourceHandle?: string | null
  }>
  availableBlocks?: Array<{ id: string; category: string }>
}

interface TargetRef {
  blockId: string
  handle?: string
}

interface MutableOp {
  block_id: string
  operation_type: string
  params?: Record<string, unknown>
}

/**
 * Rewrites Arena Copilot `edit_workflow` operations so connections stay
 * source → target. Models often put `connections` on the downstream block
 * (Agent → Start), which the editor drops or treats as a cycle.
 */
export function normalizeLocalEditConnections(
  operations: unknown[],
  snapshot?: LocalEditConnectionSnapshot
): unknown[] {
  const ops = cloneOperations(operations)
  if (ops.length === 0) return operations

  const triggerIds = collectTriggerIds(ops, snapshot)
  const blockTypeById = collectBlockTypes(ops, snapshot)
  let changed = false

  for (const op of ops) {
    if (blockTypeById.get(op.block_id) !== 'condition') continue
    const connections = getConnections(op)
    if (!connections) continue
    if (aliasDefaultConditionHandle(connections)) {
      op.params = { ...op.params, connections }
      changed = true
    }
  }

  for (const op of ops) {
    const connections = getConnections(op)
    if (!connections) continue

    const aliased = aliasTargetHandleToSource(connections)
    if (aliased) {
      op.params = { ...op.params, connections }
      changed = true
    }
  }

  const inverted: Array<{ triggerId: string; downstreamId: string; sourceHandle: string }> = []

  for (const op of ops) {
    if (op.operation_type === 'delete') continue
    const connections = getConnections(op)
    if (!connections) continue

    const kept: Record<string, unknown> = {}
    for (const [rawHandle, value] of Object.entries(connections)) {
      if (value === null) {
        kept[rawHandle] = null
        continue
      }

      const sourceHandle = normalizeSourceHandle(rawHandle)
      const remaining: TargetRef[] = []

      for (const target of parseTargets(value)) {
        if (target.blockId === op.block_id) continue
        if (triggerIds.has(target.blockId)) {
          inverted.push({
            triggerId: target.blockId,
            downstreamId: op.block_id,
            sourceHandle,
          })
          changed = true
          continue
        }
        remaining.push(target)
      }

      if (remaining.length > 0) {
        kept[rawHandle === 'target' ? 'source' : rawHandle] = serializeTargets(remaining)
      }
    }

    if (Object.keys(kept).length > 0) {
      op.params = { ...op.params, connections: kept }
    } else if (op.params && 'connections' in op.params) {
      const nextParams = { ...op.params }
      nextParams.connections = undefined
      op.params = nextParams
    }
  }

  for (const edge of inverted) {
    attachOutgoingConnection(ops, edge.triggerId, 'source', {
      blockId: edge.downstreamId,
    })
    attachRemoveEdge(ops, edge.downstreamId, edge.triggerId, edge.sourceHandle)
    if (edge.sourceHandle !== 'source') {
      attachRemoveEdge(ops, edge.downstreamId, edge.triggerId, 'source')
    }
  }

  const droppedReverses = dropDefaultReversePairs(ops, triggerIds)
  if (droppedReverses > 0) changed = true

  const reverseRemoves = attachExistingReverseRemoves(ops, snapshot)
  if (reverseRemoves > 0) changed = true

  if (changed) {
    logger.info('Rewrote reversed edit_workflow connections', {
      invertedCount: inverted.length,
      droppedReversePairs: droppedReverses,
      reverseRemoves,
      triggerCount: triggerIds.size,
    })
    return ops
  }

  return operations
}

function cloneOperations(operations: unknown[]): MutableOp[] {
  const cloned: MutableOp[] = []
  for (const op of operations) {
    if (!op || typeof op !== 'object') continue
    const record = op as Record<string, unknown>
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
        record.params && typeof record.params === 'object'
          ? structuredClone(record.params as Record<string, unknown>)
          : undefined,
    })
  }
  return cloned
}

function collectBlockTypes(
  ops: MutableOp[],
  snapshot?: LocalEditConnectionSnapshot
): Map<string, string> {
  const types = new Map<string, string>()
  for (const [blockId, block] of Object.entries(snapshot?.blocks ?? {})) {
    if (typeof block?.type === 'string' && block.type) {
      types.set(blockId, block.type)
    }
  }
  for (const op of ops) {
    if (op.operation_type === 'delete') {
      types.delete(op.block_id)
      continue
    }
    const type = typeof op.params?.type === 'string' ? op.params.type : undefined
    if (type) types.set(op.block_id, type)
  }
  return types
}

function aliasDefaultConditionHandle(connections: Record<string, unknown>): boolean {
  let changed = false
  const existingIf = parseTargets(connections.if)

  for (const handle of ['source', 'success', 'default', 'target', '']) {
    if (!(handle in connections) || connections[handle] == null) continue
    const fromDefault = parseTargets(connections[handle])
    delete connections[handle]
    changed = true
    for (const target of fromDefault) {
      if (
        !existingIf.some((item) => item.blockId === target.blockId && item.handle === target.handle)
      ) {
        existingIf.push(target)
      }
    }
  }

  if (existingIf.length > 0) {
    connections.if = serializeTargets(existingIf)
  }
  return changed
}

function collectTriggerIds(ops: MutableOp[], snapshot?: LocalEditConnectionSnapshot): Set<string> {
  const triggerIds = new Set<string>()
  const categoryByType = new Map(
    (snapshot?.availableBlocks ?? []).map((block) => [block.id, block.category])
  )

  for (const [blockId, block] of Object.entries(snapshot?.blocks ?? {})) {
    if (isTriggerLike(block?.type, block?.triggerMode === true, categoryByType)) {
      triggerIds.add(blockId)
    }
  }

  for (const op of ops) {
    if (op.operation_type === 'delete') {
      triggerIds.delete(op.block_id)
      continue
    }
    const type = typeof op.params?.type === 'string' ? op.params.type : undefined
    const triggerMode = op.params?.triggerMode === true
    if (isTriggerLike(type, triggerMode, categoryByType)) {
      triggerIds.add(op.block_id)
    }
  }

  return triggerIds
}

function isTriggerLike(
  type: string | undefined,
  triggerMode: boolean,
  categoryByType: Map<string, string>
): boolean {
  if (triggerMode) return true
  if (!type) return false
  if (KNOWN_TRIGGER_TYPES.has(type)) return true
  return categoryByType.get(type) === 'triggers'
}

function getConnections(op: MutableOp): Record<string, unknown> | undefined {
  const connections = op.params?.connections
  if (!connections || typeof connections !== 'object' || Array.isArray(connections)) {
    return undefined
  }
  return connections as Record<string, unknown>
}

function aliasTargetHandleToSource(connections: Record<string, unknown>): boolean {
  if (!('target' in connections) || connections.target == null) return false
  const fromTarget = parseTargets(connections.target)
  connections.target = undefined
  if (fromTarget.length === 0) return true

  const existing = parseTargets(connections.source)
  const merged = [...existing]
  for (const target of fromTarget) {
    if (!merged.some((item) => item.blockId === target.blockId && item.handle === target.handle)) {
      merged.push(target)
    }
  }
  connections.source = serializeTargets(merged)
  return true
}

function normalizeSourceHandle(handle: string): string {
  if (handle === 'success' || handle === 'target') return 'source'
  return handle
}

function isDefaultSourceHandle(handle: string): boolean {
  return DEFAULT_SOURCE_HANDLES.has(handle)
}

function parseTargets(value: unknown): TargetRef[] {
  if (value == null) return []
  if (typeof value === 'string' && value.trim()) {
    return [{ blockId: value.trim() }]
  }
  if (Array.isArray(value)) {
    return value.flatMap(parseTargets)
  }
  if (typeof value === 'object' && value !== null && 'block' in value) {
    const block = (value as { block?: unknown }).block
    if (typeof block !== 'string' || !block.trim()) return []
    const handle = (value as { handle?: unknown }).handle
    return [
      {
        blockId: block.trim(),
        ...(typeof handle === 'string' && handle.trim() ? { handle: handle.trim() } : {}),
      },
    ]
  }
  return []
}

function serializeTargets(refs: TargetRef[]): unknown {
  if (refs.length === 1 && !refs[0].handle) {
    return refs[0].blockId
  }
  return refs.map((ref) => (ref.handle ? { block: ref.blockId, handle: ref.handle } : ref.blockId))
}

function findOp(
  ops: MutableOp[],
  blockId: string,
  preferred: 'any' | 'edit' = 'any'
): MutableOp | undefined {
  if (preferred === 'edit') {
    return ops.find((op) => op.block_id === blockId && op.operation_type === 'edit')
  }
  return ops.find((op) => op.block_id === blockId && op.operation_type !== 'delete')
}

function attachOutgoingConnection(
  ops: MutableOp[],
  sourceBlockId: string,
  handle: string,
  target: TargetRef
): void {
  let op = findOp(ops, sourceBlockId)
  if (!op) {
    op = {
      block_id: sourceBlockId,
      operation_type: 'edit',
      params: {},
    }
    ops.push(op)
  }

  const connections = { ...(getConnections(op) ?? {}) }
  const existing = parseTargets(connections[handle])
  if (!existing.some((item) => item.blockId === target.blockId && item.handle === target.handle)) {
    existing.push(target)
  }
  connections[handle] = serializeTargets(existing)
  op.params = { ...op.params, connections }
}

function collectDefaultOutgoing(ops: MutableOp[]): Array<{ sourceId: string; targetId: string }> {
  const edges: Array<{ sourceId: string; targetId: string }> = []
  for (const op of ops) {
    if (op.operation_type === 'delete') continue
    const connections = getConnections(op)
    if (!connections) continue
    for (const [rawHandle, value] of Object.entries(connections)) {
      if (!isDefaultSourceHandle(normalizeSourceHandle(rawHandle))) continue
      for (const target of parseTargets(value)) {
        edges.push({ sourceId: op.block_id, targetId: target.blockId })
      }
    }
  }
  return edges
}

function dropDefaultReversePairs(ops: MutableOp[], triggerIds: Set<string>): number {
  const outgoing = collectDefaultOutgoing(ops)
  const pairs: Array<{ keepSource: string; dropSource: string }> = []
  const seen = new Set<string>()

  for (const edge of outgoing) {
    const reverse = outgoing.find(
      (candidate) => candidate.sourceId === edge.targetId && candidate.targetId === edge.sourceId
    )
    if (!reverse) continue
    const key = [edge.sourceId, edge.targetId].sort().join(':')
    if (seen.has(key)) continue
    seen.add(key)

    const keepSource = pickKeptSource(edge.sourceId, reverse.sourceId, triggerIds, ops)
    pairs.push({
      keepSource,
      dropSource: keepSource === edge.sourceId ? reverse.sourceId : edge.sourceId,
    })
  }

  for (const pair of pairs) {
    stripDefaultTarget(ops, pair.dropSource, pair.keepSource)
    attachRemoveEdge(ops, pair.dropSource, pair.keepSource, 'source')
  }
  return pairs.length
}

function pickKeptSource(
  left: string,
  right: string,
  triggerIds: Set<string>,
  ops: MutableOp[]
): string {
  if (triggerIds.has(left) && !triggerIds.has(right)) return left
  if (triggerIds.has(right) && !triggerIds.has(left)) return right
  const leftIndex = ops.findIndex((op) => op.block_id === left)
  const rightIndex = ops.findIndex((op) => op.block_id === right)
  if (leftIndex === -1) return right
  if (rightIndex === -1) return left
  return leftIndex <= rightIndex ? left : right
}

function stripDefaultTarget(ops: MutableOp[], sourceId: string, targetId: string): void {
  const op = findOp(ops, sourceId)
  const connections = op ? getConnections(op) : undefined
  if (!op || !connections) return

  const kept: Record<string, unknown> = {}
  for (const [rawHandle, value] of Object.entries(connections)) {
    if (value === null) {
      kept[rawHandle] = null
      continue
    }
    if (!isDefaultSourceHandle(normalizeSourceHandle(rawHandle))) {
      kept[rawHandle] = value
      continue
    }
    const remaining = parseTargets(value).filter((target) => target.blockId !== targetId)
    if (remaining.length > 0) {
      kept[rawHandle] = serializeTargets(remaining)
    }
  }

  if (Object.keys(kept).length > 0) {
    op.params = { ...op.params, connections: kept }
  } else if (op.params) {
    const nextParams = { ...op.params }
    nextParams.connections = undefined
    op.params = nextParams
  }
}

function attachExistingReverseRemoves(
  ops: MutableOp[],
  snapshot?: LocalEditConnectionSnapshot
): number {
  const existing = snapshot?.edges ?? []
  if (existing.length === 0) return 0

  let count = 0
  for (const edge of collectDefaultOutgoing(ops)) {
    const hasReverse = existing.some(
      (candidate) =>
        candidate.source === edge.targetId &&
        candidate.target === edge.sourceId &&
        isDefaultSourceHandle(normalizeSourceHandle(candidate.sourceHandle ?? 'source'))
    )
    if (!hasReverse) continue
    attachRemoveEdge(ops, edge.targetId, edge.sourceId, 'source')
    count += 1
  }
  return count
}

function attachRemoveEdge(
  ops: MutableOp[],
  sourceBlockId: string,
  targetBlockId: string,
  sourceHandle: string
): void {
  let op = findOp(ops, sourceBlockId, 'edit')
  if (!op) {
    op = {
      block_id: sourceBlockId,
      operation_type: 'edit',
      params: {},
    }
    ops.push(op)
  }

  const existing = Array.isArray(op.params?.removeEdges) ? [...op.params.removeEdges] : []
  const alreadyListed = existing.some((item) => {
    if (!item || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    return (
      record.targetBlockId === targetBlockId &&
      (record.sourceHandle === sourceHandle ||
        ((!record.sourceHandle || record.sourceHandle === 'source') && sourceHandle === 'source'))
    )
  })
  if (!alreadyListed) {
    existing.push({ targetBlockId, sourceHandle })
  }
  op.params = { ...op.params, removeEdges: existing }
}
