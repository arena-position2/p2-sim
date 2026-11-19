import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { isRecordLike } from '@sim/utils/object'
import { DEFAULTS } from '@/executor/constants'
import type { ContextExtensions } from '@/executor/execution/types'
import {
  type BlockLog,
  type ExecutionContext,
  getNextExecutionOrder,
  type NormalizedBlockOutput,
} from '@/executor/types'
import { buildContainerIterationContext } from '@/executor/utils/iteration-context'
import {
  buildLoopScopedId,
  buildLoopSentinelEndId,
  buildLoopSentinelStartId,
  extractBaseBlockId as codecExtractBaseBlockId,
  extractLoopIdFromSentinel as codecExtractLoopIdFromSentinel,
  extractParallelIdFromSentinel as codecExtractParallelIdFromSentinel,
  buildParallelSentinelEndId as codecParallelSentinelEndId,
  buildParallelSentinelStartId as codecParallelSentinelStartId,
} from '@/executor/utils/subflow-node-id-codec'
import type { SerializedWorkflow } from '@/serializer/types'

const logger = createLogger('SubflowUtils')

/**
 * Builds the loop sentinel-start node ID for a container.
 */
export function buildSentinelStartId(loopId: string): string {
  return buildLoopSentinelStartId(loopId)
}

/**
 * Builds the loop sentinel-end node ID for a container.
 */
export function buildSentinelEndId(loopId: string): string {
  return buildLoopSentinelEndId(loopId)
}

export function buildParallelSentinelStartId(parallelId: string): string {
  return codecParallelSentinelStartId(parallelId)
}

export function buildParallelSentinelEndId(parallelId: string): string {
  return codecParallelSentinelEndId(parallelId)
}

export function extractLoopIdFromSentinel(sentinelId: string): string | null {
  return codecExtractLoopIdFromSentinel(sentinelId)
}

export function extractParallelIdFromSentinel(sentinelId: string): string | null {
  return codecExtractParallelIdFromSentinel(sentinelId)
}

export function extractBaseBlockId(branchNodeId: string): string {
  return codecExtractBaseBlockId(branchNodeId)
}

/**
 * Collects contiguous `_loop0`…`_loopN` outputs for a block. Stops at the first gap.
 */
export function collectLoopScopedOutputs(
  getOutput: (id: string) => NormalizedBlockOutput | undefined,
  blockId: string
): NormalizedBlockOutput[] {
  const outputs: NormalizedBlockOutput[] = []
  for (let iteration = 0; iteration <= DEFAULTS.DEFAULT_LOOP_ITERATIONS; iteration++) {
    const output = getOutput(buildLoopScopedId(blockId, iteration))
    if (output === undefined) break
    outputs.push(output)
  }
  return outputs
}

/**
 * Deletes contiguous `_loop0`…`_loopN` states for a block. Stops at the first gap.
 */
export function deleteLoopScopedOutputs(
  getOutput: (id: string) => unknown,
  deleteState: (id: string) => void,
  blockId: string
): void {
  for (let iteration = 0; iteration <= DEFAULTS.DEFAULT_LOOP_ITERATIONS; iteration++) {
    const scopedId = buildLoopScopedId(blockId, iteration)
    if (getOutput(scopedId) === undefined) break
    deleteState(scopedId)
  }
}

/**
 * Field-wise aggregation so `<InnerBlock.result>` after a loop is `[r0, r1, …]`.
 */
export function aggregateLoopIterationOutputs(
  outputs: NormalizedBlockOutput[]
): NormalizedBlockOutput | undefined {
  if (outputs.length === 0) return undefined
  if (outputs.length === 1) return outputs[0]

  const keys = new Set<string>()
  for (const output of outputs) {
    if (!isRecordLike(output)) continue
    for (const key of Object.keys(output)) keys.add(key)
  }

  const aggregated: Record<string, unknown> = {}
  for (const key of keys) {
    aggregated[key] = outputs.map((output) => (isRecordLike(output) ? output[key] : undefined))
  }
  return aggregated as NormalizedBlockOutput
}

type SubflowContainerType = 'loop' | 'parallel'

function getSubflowNodes(
  workflow: Pick<SerializedWorkflow, 'loops' | 'parallels'>,
  type: SubflowContainerType,
  id: string
): string[] | undefined {
  return type === 'loop' ? workflow.loops?.[id]?.nodes : workflow.parallels?.[id]?.nodes
}

export function subflowContainsBlock(
  workflow: Pick<SerializedWorkflow, 'loops' | 'parallels'>,
  containerType: SubflowContainerType,
  containerId: string,
  baseBlockId: string,
  visited = new Set<string>()
): boolean {
  const visitKey = `${containerType}:${containerId}`
  if (visited.has(visitKey)) return false
  visited.add(visitKey)

  const nodes = getSubflowNodes(workflow, containerType, containerId)
  if (!nodes) return false

  for (const nodeId of nodes) {
    if (nodeId === baseBlockId) return true
    if (workflow.loops?.[nodeId]) {
      if (subflowContainsBlock(workflow, 'loop', nodeId, baseBlockId, visited)) return true
    } else if (workflow.parallels?.[nodeId]) {
      if (subflowContainsBlock(workflow, 'parallel', nodeId, baseBlockId, visited)) return true
    }
  }
  return false
}

export function isSubflowNestedInside(
  workflow: Pick<SerializedWorkflow, 'loops' | 'parallels'>,
  childType: SubflowContainerType,
  childId: string,
  ancestorType: SubflowContainerType,
  ancestorId: string,
  visited = new Set<string>()
): boolean {
  const visitKey = `${ancestorType}:${ancestorId}`
  if (visited.has(visitKey)) return false
  visited.add(visitKey)

  const nodes = getSubflowNodes(workflow, ancestorType, ancestorId)
  if (!nodes) return false

  for (const nodeId of nodes) {
    if (
      nodeId === childId &&
      (childType === 'loop' ? workflow.loops?.[childId] : workflow.parallels?.[childId])
    ) {
      return true
    }
    if (workflow.loops?.[nodeId]) {
      if (isSubflowNestedInside(workflow, childType, childId, 'loop', nodeId, visited)) {
        return true
      }
    } else if (workflow.parallels?.[nodeId]) {
      if (isSubflowNestedInside(workflow, childType, childId, 'parallel', nodeId, visited)) {
        return true
      }
    }
  }
  return false
}

/**
 * Creates and logs an error for a subflow (loop or parallel).
 */
export async function addSubflowErrorLog(
  ctx: ExecutionContext,
  blockId: string,
  blockType: 'loop' | 'parallel',
  errorMessage: string,
  inputData: Record<string, any>,
  contextExtensions: ContextExtensions | null
): Promise<void> {
  const now = new Date().toISOString()
  const execOrder = getNextExecutionOrder(ctx)

  const block = ctx.workflow?.blocks?.find((b) => b.id === blockId)
  const blockName = block?.metadata?.name || (blockType === 'loop' ? 'Loop' : 'Parallel')

  const blockLog: BlockLog = {
    blockId,
    blockName,
    blockType,
    startedAt: now,
    executionOrder: execOrder,
    endedAt: now,
    durationMs: 0,
    success: false,
    error: errorMessage,
    input: inputData,
    output: { error: errorMessage },
    ...(blockType === 'loop' ? { loopId: blockId } : { parallelId: blockId }),
  }
  ctx.blockLogs.push(blockLog)

  if (contextExtensions?.onBlockStart) {
    try {
      await contextExtensions.onBlockStart(blockId, blockName, blockType, execOrder)
    } catch (error) {
      logger.warn('Subflow error start callback failed', {
        blockId,
        blockType,
        error: toError(error).message,
      })
    }
  }

  if (contextExtensions?.onBlockComplete) {
    try {
      await contextExtensions.onBlockComplete(blockId, blockName, blockType, {
        input: inputData,
        output: { error: errorMessage },
        executionTime: 0,
        startedAt: now,
        executionOrder: execOrder,
        endedAt: now,
      })
    } catch (error) {
      logger.warn('Subflow error completion callback failed', {
        blockId,
        blockType,
        error: toError(error).message,
      })
    }
  }
}

/**
 * Emits the BlockLog + onBlockComplete callback for a loop/parallel container that
 * finished successfully. Without this, successful container runs produce no top-level BlockLog,
 * which forces the trace-span builder to fall back
 * to generic counter-based names ("Loop 1", "Parallel 1") instead of the user-configured
 * block name.
 */
export async function emitSubflowSuccessEvents(
  ctx: ExecutionContext,
  blockId: string,
  blockType: 'loop' | 'parallel',
  output: { results: unknown },
  contextExtensions: ContextExtensions | null
): Promise<void> {
  const now = new Date().toISOString()
  const executionOrder = getNextExecutionOrder(ctx)
  const block = ctx.workflow?.blocks.find((b) => b.id === blockId)
  const blockName = block?.metadata?.name ?? blockType
  const iterationContext = buildContainerIterationContext(ctx, blockId)
  const provenance = ctx.blockStates.get(blockId)?.resolvedSecretTraceProvenance

  ctx.blockLogs.push({
    blockId,
    blockName,
    blockType,
    startedAt: now,
    endedAt: now,
    durationMs: DEFAULTS.EXECUTION_TIME,
    success: true,
    output,
    executionOrder,
    ...(provenance ? { displayResolvedSecretTraceProvenance: provenance } : {}),
  })

  if (contextExtensions?.onBlockComplete) {
    try {
      await contextExtensions.onBlockComplete(
        blockId,
        blockName,
        blockType,
        {
          output,
          ...(provenance ? { resolvedSecretTraceProvenance: provenance } : {}),
          ...(provenance ? { displayResolvedSecretTraceProvenance: provenance } : {}),
          executionTime: DEFAULTS.EXECUTION_TIME,
          startedAt: now,
          executionOrder,
          endedAt: now,
        },
        iterationContext
      )
    } catch (error) {
      logger.warn('Subflow success completion callback failed', {
        blockId,
        blockType,
        error: toError(error).message,
      })
    }
  }
}
