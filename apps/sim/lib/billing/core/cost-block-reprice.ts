import { db } from '@sim/db'
import {
  usageLog,
  workflow,
  workflowBlocks,
  workflowEdges,
  workflowExecutionLogs,
} from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { and, asc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm'
import type { UsageEntry } from '@/lib/billing/core/usage-log'
import { stableEventKey } from '@/lib/billing/core/usage-log'
import { materializeExecutionData } from '@/lib/logs/execution/trace-store'
import type { TraceSpan } from '@/lib/logs/types'
import { BlockType } from '@/executor/constants'
import { CostBlockHandler } from '@/executor/handlers/cost/cost-handler'
import type {
  BlockLog,
  BlockState,
  ExecutionContext,
  NormalizedBlockOutput,
} from '@/executor/types'
import type { SerializedBlock, SerializedConnection, SerializedWorkflow } from '@/serializer/types'

const logger = createLogger('CostBlockReprice')

export const COST_REPRICE_BACKFILL_VERSION = 'cost-reprice-v1'
export const COST_EPSILON = 1e-8

export interface CostBlockWorkflowSummary {
  workflowId: string
  workflowName: string
  workspaceId: string | null
  costBlockCount: number
  costBlockIds: string[]
  costBlockNames: string[]
}

export interface RepriceTargetLine {
  description: string
  target: number
  vendor?: string
  quantity?: number
  unit?: string
  metadata?: Record<string, unknown>
  costBlockId: string
}

export interface RepriceExecutionResult {
  executionId: string
  workflowId: string
  status: 'skipped' | 'adjusted' | 'unchanged' | 'error'
  reason?: string
  targets: RepriceTargetLine[]
  deltas: UsageEntry[]
  ledgerSumBefore: number
  ledgerSumAfter: number
}

interface WorkflowGraph {
  blocks: SerializedBlock[]
  connections: SerializedConnection[]
}

interface TraceSpanLike {
  blockId?: string
  name?: string
  type?: string
  status?: 'success' | 'error'
  executionOrder?: number
  duration?: number
  output?: Record<string, unknown>
  children?: TraceSpanLike[]
}

function extractSubBlockValues(
  subBlocks: Record<string, { value?: unknown } | null | undefined>
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(subBlocks)) {
    if (entry && typeof entry === 'object' && 'value' in entry) {
      values[key] = entry.value
    }
  }
  return values
}

function walkTraceSpans(
  spans: TraceSpanLike[] | undefined,
  visit: (span: TraceSpanLike) => void
): void {
  if (!spans) return
  for (const span of spans) {
    visit(span)
    walkTraceSpans(span.children, visit)
  }
}

export function collectTraceExecutionArtifacts(traceSpans: TraceSpanLike[] | undefined): {
  blockStates: Map<string, BlockState>
  blockLogs: BlockLog[]
} {
  const blockStates = new Map<string, BlockState>()
  const blockLogs: BlockLog[] = []

  walkTraceSpans(traceSpans, (span) => {
    if (!span.blockId) return

    if (span.output !== undefined) {
      blockStates.set(span.blockId, {
        output: span.output,
        executed: true,
        executionTime: span.duration ?? 0,
      })
    }

    if (span.status) {
      const endedAt = new Date().toISOString()
      blockLogs.push({
        blockId: span.blockId,
        startedAt: endedAt,
        endedAt,
        durationMs: span.duration ?? 0,
        success: span.status === 'success',
        executionOrder: span.executionOrder ?? blockLogs.length + 1,
        ...(span.status === 'error' ? { error: 'trace span error' } : {}),
      })
    }
  })

  return { blockStates, blockLogs }
}

export function resolveExternalDescription(
  blockName: string,
  raw: Record<string, unknown>
): string {
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  const vendor = typeof raw.vendor === 'string' ? raw.vendor.trim() : ''
  return blockName.trim() || label || vendor || 'external'
}

export function buildRepriceDeltaEntries(params: {
  executionId: string
  targets: RepriceTargetLine[]
  alreadyBilled: Map<string, number>
}): UsageEntry[] {
  const entries: UsageEntry[] = []

  for (const line of params.targets) {
    const key = `external::${line.description}`
    const billed = params.alreadyBilled.get(key) ?? 0
    const delta = line.target - billed
    if (Math.abs(delta) <= COST_EPSILON) {
      continue
    }

    entries.push({
      category: 'external',
      source: 'workflow',
      description: line.description,
      cost: delta,
      rawCost: delta,
      billableCost: delta,
      vendor: line.vendor,
      quantity: line.quantity,
      unit: line.unit,
      metadata: {
        ...(line.metadata ?? {}),
        backfill: COST_REPRICE_BACKFILL_VERSION,
        repricedTarget: line.target,
        billedBefore: billed,
        costBlockId: line.costBlockId,
      },
      eventKey: stableEventKey({
        backfill: COST_REPRICE_BACKFILL_VERSION,
        executionId: params.executionId,
        category: 'external',
        description: line.description,
        billedBefore: billed.toFixed(8),
        target: line.target.toFixed(8),
      }),
    })
  }

  return entries
}

export async function discoverWorkflowsWithCostBlocks(): Promise<CostBlockWorkflowSummary[]> {
  const rows = await db
    .select({
      workflowId: workflowBlocks.workflowId,
      workflowName: workflow.name,
      workspaceId: workflow.workspaceId,
      blockId: workflowBlocks.id,
      blockName: workflowBlocks.name,
    })
    .from(workflowBlocks)
    .innerJoin(workflow, eq(workflow.id, workflowBlocks.workflowId))
    .where(eq(workflowBlocks.type, BlockType.COST))
    .orderBy(asc(workflow.name), asc(workflowBlocks.name))

  const byWorkflow = new Map<string, CostBlockWorkflowSummary>()
  for (const row of rows) {
    const existing = byWorkflow.get(row.workflowId)
    if (existing) {
      existing.costBlockCount += 1
      existing.costBlockIds.push(row.blockId)
      existing.costBlockNames.push(row.blockName)
      continue
    }
    byWorkflow.set(row.workflowId, {
      workflowId: row.workflowId,
      workflowName: row.workflowName,
      workspaceId: row.workspaceId,
      costBlockCount: 1,
      costBlockIds: [row.blockId],
      costBlockNames: [row.blockName],
    })
  }

  return [...byWorkflow.values()]
}

export async function loadWorkflowGraph(workflowId: string): Promise<WorkflowGraph> {
  const [blocks, connections] = await Promise.all([
    db.select().from(workflowBlocks).where(eq(workflowBlocks.workflowId, workflowId)),
    db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId)),
  ])

  return {
    blocks: blocks.map((block) => ({
      id: block.id,
      position: { x: Number(block.positionX), y: Number(block.positionY) },
      config: {
        tool: block.type,
        params: extractSubBlockValues(block.subBlocks as Record<string, { value?: unknown }>),
      },
      inputs: {},
      outputs: {},
      enabled: block.enabled,
      metadata: { id: block.type, name: block.name },
    })),
    connections: connections.map((edge) => ({
      source: edge.sourceBlockId,
      target: edge.targetBlockId,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
    })),
  }
}

function buildExecutionContext(params: {
  workflowId: string
  graph: WorkflowGraph
  blockStates: Map<string, BlockState>
  blockLogs: BlockLog[]
}): ExecutionContext {
  const serializedWorkflow: SerializedWorkflow = {
    version: '1',
    blocks: params.graph.blocks,
    connections: params.graph.connections,
    loops: {},
    parallels: {},
  }

  return {
    workflowId: params.workflowId,
    blockStates: params.blockStates,
    blockLogs: params.blockLogs,
    metadata: { duration: 0 },
    environmentVariables: {},
    decisions: { router: new Map(), condition: new Map() },
    loopExecutions: new Map(),
    completedLoops: new Set(),
    executedBlocks: new Set(params.blockStates.keys()),
    activeExecutionPath: new Set(),
    workflow: serializedWorkflow,
  }
}

async function repriceCostBlocksForExecution(params: {
  workflowId: string
  executionId: string
  workspaceId: string
  graph: WorkflowGraph
  costBlockIds: string[]
  executionData: Record<string, unknown>
}): Promise<RepriceTargetLine[]> {
  const traceSpans = params.executionData.traceSpans as TraceSpan[] | undefined
  if (!traceSpans?.length) {
    return []
  }

  const { blockStates, blockLogs } = collectTraceExecutionArtifacts(traceSpans)
  const ctx = buildExecutionContext({
    workflowId: params.workflowId,
    graph: params.graph,
    blockStates,
    blockLogs,
  })

  const handler = new CostBlockHandler()
  const targets: RepriceTargetLine[] = []

  for (const costBlockId of params.costBlockIds) {
    const costBlock = params.graph.blocks.find((block) => block.id === costBlockId)
    if (!costBlock || costBlock.metadata?.id !== BlockType.COST) {
      continue
    }

    const mode = String(costBlock.config.params.mode ?? 'fixed')
    if (mode === 'expression') {
      logger.info('Skipping expression-mode cost block during reprice backfill', {
        executionId: params.executionId,
        costBlockId,
      })
      continue
    }

    const inputs = { ...costBlock.config.params }
    const output = (await handler.executeWithNode(ctx, costBlock, inputs, {
      nodeId: costBlockId,
    })) as NormalizedBlockOutput

    if (!output.recorded || !output.cost?.total || output.cost.total <= COST_EPSILON) {
      continue
    }

    const raw = (output.raw ?? {}) as Record<string, unknown>
    const description = resolveExternalDescription(costBlock.metadata?.name ?? costBlockId, raw)

    targets.push({
      description,
      target: output.cost.total,
      vendor: typeof raw.vendor === 'string' ? raw.vendor : undefined,
      quantity: typeof raw.quantity === 'number' ? raw.quantity : output.units,
      unit: typeof raw.unit === 'string' ? raw.unit : undefined,
      metadata: {
        ...(typeof raw.amount === 'number' ? { originalAmount: raw.amount } : {}),
        ...(typeof raw.currency === 'string' ? { originalCurrency: raw.currency } : {}),
        ...(typeof raw.exchangeRate === 'number' ? { exchangeRate: raw.exchangeRate } : {}),
        ...(typeof raw.sourceBlockId === 'string' ? { sourceBlockId: raw.sourceBlockId } : {}),
        ...(typeof raw.responsePath === 'string' ? { responsePath: raw.responsePath } : {}),
        ...(typeof raw.quantityPath === 'string' ? { quantityPath: raw.quantityPath } : {}),
        ...(typeof raw.unitPrice === 'number' ? { unitPrice: raw.unitPrice } : {}),
        ...(typeof raw.source === 'string' ? { source: raw.source } : {}),
      },
      costBlockId,
    })
  }

  return targets
}

export async function loadAlreadyBilledExternal(executionId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      description: usageLog.description,
      cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)`,
    })
    .from(usageLog)
    .where(
      and(
        eq(usageLog.executionId, executionId),
        eq(usageLog.source, 'workflow'),
        eq(usageLog.category, 'external')
      )
    )
    .groupBy(usageLog.description)

  const billed = new Map<string, number>()
  for (const row of rows) {
    billed.set(`external::${row.description}`, Number.parseFloat(row.cost ?? '0'))
  }
  return billed
}

export async function loadWorkflowLedgerSum(executionId: string): Promise<number> {
  const [row] = await db
    .select({ cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)` })
    .from(usageLog)
    .where(and(eq(usageLog.executionId, executionId), eq(usageLog.source, 'workflow')))

  return Number.parseFloat(row?.cost ?? '0')
}

export interface RepriceExecutionOptions {
  workflowId: string
  executionId: string
  workspaceId: string
  costBlockIds: string[]
  graph?: WorkflowGraph
  missingOnly?: boolean
}

export async function repriceExecution(
  options: RepriceExecutionOptions
): Promise<RepriceExecutionResult> {
  const graph = options.graph ?? (await loadWorkflowGraph(options.workflowId))

  try {
    const [executionRow] = await db
      .select({
        executionData: workflowExecutionLogs.executionData,
        status: workflowExecutionLogs.status,
      })
      .from(workflowExecutionLogs)
      .where(eq(workflowExecutionLogs.executionId, options.executionId))
      .limit(1)

    if (!executionRow) {
      return {
        executionId: options.executionId,
        workflowId: options.workflowId,
        status: 'error',
        reason: 'execution_not_found',
        targets: [],
        deltas: [],
        ledgerSumBefore: 0,
        ledgerSumAfter: 0,
      }
    }

    if (executionRow.status !== 'completed') {
      return {
        executionId: options.executionId,
        workflowId: options.workflowId,
        status: 'skipped',
        reason: 'execution_not_completed',
        targets: [],
        deltas: [],
        ledgerSumBefore: 0,
        ledgerSumAfter: 0,
      }
    }

    const executionData = await materializeExecutionData(
      executionRow.executionData as Record<string, unknown>,
      {
        workspaceId: options.workspaceId,
        workflowId: options.workflowId,
        executionId: options.executionId,
      }
    )

    if (!executionData.traceSpans) {
      return {
        executionId: options.executionId,
        workflowId: options.workflowId,
        status: 'skipped',
        reason: 'trace_data_unavailable',
        targets: [],
        deltas: [],
        ledgerSumBefore: 0,
        ledgerSumAfter: 0,
      }
    }

    const targets = await repriceCostBlocksForExecution({
      workflowId: options.workflowId,
      executionId: options.executionId,
      workspaceId: options.workspaceId,
      graph,
      costBlockIds: options.costBlockIds,
      executionData,
    })

    if (targets.length === 0) {
      return {
        executionId: options.executionId,
        workflowId: options.workflowId,
        status: 'skipped',
        reason: 'no_reprice_targets',
        targets: [],
        deltas: [],
        ledgerSumBefore: 0,
        ledgerSumAfter: 0,
      }
    }

    const alreadyBilled = await loadAlreadyBilledExternal(options.executionId)
    const ledgerSumBefore = await loadWorkflowLedgerSum(options.executionId)

    if (options.missingOnly) {
      const hasAnyExternal = [...alreadyBilled.keys()].some((key) => key.startsWith('external::'))
      const missingTargets = targets.filter(
        (target) => !alreadyBilled.has(`external::${target.description}`)
      )
      if (hasAnyExternal && missingTargets.length === 0) {
        return {
          executionId: options.executionId,
          workflowId: options.workflowId,
          status: 'unchanged',
          reason: 'external_rows_already_present',
          targets,
          deltas: [],
          ledgerSumBefore,
          ledgerSumAfter: ledgerSumBefore,
        }
      }
      if (missingTargets.length === 0) {
        return {
          executionId: options.executionId,
          workflowId: options.workflowId,
          status: 'unchanged',
          targets,
          deltas: [],
          ledgerSumBefore,
          ledgerSumAfter: ledgerSumBefore,
        }
      }
    }

    const deltas = buildRepriceDeltaEntries({
      executionId: options.executionId,
      targets,
      alreadyBilled,
    })

    const deltaTotal = deltas.reduce((sum, entry) => sum + entry.cost, 0)
    const ledgerSumAfter = ledgerSumBefore + deltaTotal

    return {
      executionId: options.executionId,
      workflowId: options.workflowId,
      status: deltas.length > 0 ? 'adjusted' : 'unchanged',
      targets,
      deltas,
      ledgerSumBefore,
      ledgerSumAfter,
    }
  } catch (error) {
    return {
      executionId: options.executionId,
      workflowId: options.workflowId,
      status: 'error',
      reason: getErrorMessage(error, 'reprice_failed'),
      targets: [],
      deltas: [],
      ledgerSumBefore: 0,
      ledgerSumAfter: 0,
    }
  }
}

export interface ListCostBlockExecutionsFilter {
  workflowIds?: string[]
  since?: Date
  until?: Date
  limit?: number
  afterStartedAt?: Date
}

export async function listCostBlockExecutionsForReprice(
  filter: ListCostBlockExecutionsFilter
): Promise<
  Array<{ executionId: string; workflowId: string; startedAt: Date; workspaceId: string }>
> {
  const workflowIds =
    filter.workflowIds ?? (await discoverWorkflowsWithCostBlocks()).map((item) => item.workflowId)
  if (workflowIds.length === 0) {
    return []
  }

  const conditions = [
    inArray(workflowExecutionLogs.workflowId, workflowIds),
    eq(workflowExecutionLogs.status, 'completed'),
  ]
  if (filter.since) {
    conditions.push(gte(workflowExecutionLogs.startedAt, filter.since))
  }
  if (filter.until) {
    conditions.push(lt(workflowExecutionLogs.startedAt, filter.until))
  }
  if (filter.afterStartedAt) {
    conditions.push(gt(workflowExecutionLogs.startedAt, filter.afterStartedAt))
  }

  const rows = await db
    .select({
      executionId: workflowExecutionLogs.executionId,
      workflowId: workflowExecutionLogs.workflowId,
      startedAt: workflowExecutionLogs.startedAt,
      workspaceId: workflowExecutionLogs.workspaceId,
    })
    .from(workflowExecutionLogs)
    .where(and(...conditions))
    .orderBy(asc(workflowExecutionLogs.startedAt))
    .limit(filter.limit ?? Number.POSITIVE_INFINITY)

  return rows.filter((row): row is typeof row & { workflowId: string } => Boolean(row.workflowId))
}

export interface ListExecutionsFilter {
  workflowId: string
  since?: Date
  until?: Date
  limit?: number
}

export async function listCompletedExecutionsForWorkflow(
  filter: ListExecutionsFilter
): Promise<Array<{ executionId: string; startedAt: Date; workspaceId: string }>> {
  const conditions = [
    eq(workflowExecutionLogs.workflowId, filter.workflowId),
    eq(workflowExecutionLogs.status, 'completed'),
  ]
  if (filter.since) {
    conditions.push(gte(workflowExecutionLogs.startedAt, filter.since))
  }
  if (filter.until) {
    conditions.push(lt(workflowExecutionLogs.startedAt, filter.until))
  }

  const rows = await db
    .select({
      executionId: workflowExecutionLogs.executionId,
      startedAt: workflowExecutionLogs.startedAt,
      workspaceId: workflowExecutionLogs.workspaceId,
    })
    .from(workflowExecutionLogs)
    .where(and(...conditions))
    .orderBy(asc(workflowExecutionLogs.startedAt))
    .limit(filter.limit ?? Number.POSITIVE_INFINITY)

  return rows
}

export async function listWorkflowsWithCostBlockExecutions(
  workflowIds: string[]
): Promise<Map<string, number>> {
  if (workflowIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({
      workflowId: workflowExecutionLogs.workflowId,
      count: sql<string>`COUNT(*)::text`,
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        inArray(workflowExecutionLogs.workflowId, workflowIds),
        eq(workflowExecutionLogs.status, 'completed')
      )
    )
    .groupBy(workflowExecutionLogs.workflowId)

  return new Map(
    rows
      .filter((row) => row.workflowId)
      .map((row) => [row.workflowId as string, Number.parseInt(row.count ?? '0', 10)])
  )
}
