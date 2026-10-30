import { createLogger } from '@sim/logger'
import { traverseObjectPath } from '@/lib/core/utils/response-format'
import type { BlockOutput } from '@/blocks/types'
import { BlockType, isUuid, normalizeName } from '@/executor/constants'
import type { BlockHandler, ExecutionContext } from '@/executor/types'
import { collectBlockData } from '@/executor/utils/block-data'
import { extractBaseBlockId } from '@/executor/utils/subflow'
import type { SerializedBlock } from '@/serializer/types'

const logger = createLogger('CostBlockHandler')

type CostMode = 'fixed' | 'expression' | 'response_path' | 'per_unit'

interface CostRawOutput {
  amount: number
  currency: string
  exchangeRate?: number
  vendor?: string
  label?: string
  source: CostMode
  quantity?: number
  unit?: string
  unitPrice?: number
  quantityPath?: string
  sourceBlockId?: string
  responsePath?: string
}

function isSwitchEnabled(value: unknown, defaultValue = true): boolean {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }
  if (typeof value === 'boolean') {
    return value
  }
  return value === 'true'
}

function coerceToNonNegativeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined
  }

  const num = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(num) || num < 0) {
    return undefined
  }

  return num
}

function convertToUsd(amount: number, currency: string, exchangeRate?: number): number {
  if (currency === 'USD') {
    return amount
  }

  const rate = coerceToNonNegativeNumber(exchangeRate)
  if (rate === undefined || rate <= 0) {
    throw new Error(`Exchange rate is required when currency is ${currency}`)
  }

  return amount * rate
}

function resolveSourceBlockId(ctx: ExecutionContext, sourceBlock: string): string | undefined {
  const trimmed = sourceBlock.trim()
  if (!trimmed) {
    return undefined
  }

  if (isUuid(trimmed)) {
    return ctx.workflow?.blocks.find((block) => block.id === trimmed)?.id
  }

  const normalized = normalizeName(trimmed)
  const byName = ctx.workflow?.blocks.find(
    (block) => block.metadata?.name && normalizeName(block.metadata.name) === normalized
  )
  return byName?.id
}

function resolveUpstreamBlockId(
  ctx: ExecutionContext,
  currentBlockId: string,
  explicitSource?: string
): string | undefined {
  if (explicitSource) {
    return resolveSourceBlockId(ctx, explicitSource)
  }

  const connections = ctx.workflow?.connections ?? []
  const baseCurrentId = extractBaseBlockId(currentBlockId)
  const candidates = connections
    .filter(
      (connection) => connection.target === currentBlockId || connection.target === baseCurrentId
    )
    .map((connection) => connection.source)
    .filter((sourceId) => {
      const state = ctx.blockStates.get(sourceId)
      return state?.executed && state.output !== undefined
    })

  if (candidates.length === 0) {
    return undefined
  }

  if (candidates.length === 1) {
    return candidates[0]
  }

  let bestSource = candidates[0]
  let bestOrder = -1
  for (const sourceId of candidates) {
    const logs = ctx.blockLogs.filter((log) => log.blockId === sourceId)
    const maxOrder = logs.reduce((max, log) => Math.max(max, log.executionOrder), -1)
    if (maxOrder > bestOrder) {
      bestOrder = maxOrder
      bestSource = sourceId
    }
  }

  return bestSource
}

function didBlockError(ctx: ExecutionContext, blockId: string): boolean {
  const matchingLogs = ctx.blockLogs.filter((log) => log.blockId === blockId)
  if (matchingLogs.length > 0) {
    return matchingLogs.some((log) => !log.success)
  }

  const output = ctx.blockStates.get(blockId)?.output
  if (output && typeof output === 'object' && output !== null && 'error' in output) {
    const errorValue = (output as Record<string, unknown>).error
    return errorValue !== undefined && errorValue !== null && errorValue !== ''
  }

  return false
}

function buildZeroOutput(raw: Partial<CostRawOutput>, passthrough?: unknown): BlockOutput {
  return {
    cost: { total: 0, input: 0, output: 0 },
    usd: 0,
    ...(raw.quantity !== undefined ? { units: raw.quantity } : {}),
    ...(raw.unitPrice !== undefined ? { unitPrice: raw.unitPrice } : {}),
    raw: {
      amount: 0,
      currency: raw.currency ?? 'USD',
      vendor: raw.vendor,
      label: raw.label,
      source: raw.source ?? 'fixed',
      quantity: raw.quantity,
      unit: raw.unit,
      unitPrice: raw.unitPrice,
      quantityPath: raw.quantityPath,
      sourceBlockId: raw.sourceBlockId,
      responsePath: raw.responsePath,
      exchangeRate: raw.exchangeRate,
    },
    recorded: false,
    ...(passthrough !== undefined ? { passthrough } : {}),
  }
}

function buildRecordedOutput(
  usdTotal: number,
  raw: CostRawOutput,
  passthrough?: unknown
): BlockOutput {
  return {
    cost: {
      total: usdTotal,
      input: 0,
      output: 0,
    },
    usd: usdTotal,
    ...(raw.quantity !== undefined ? { units: raw.quantity } : {}),
    ...(raw.unitPrice !== undefined ? { unitPrice: raw.unitPrice } : {}),
    raw,
    recorded: usdTotal > 0,
    ...(passthrough !== undefined ? { passthrough } : {}),
  }
}

/**
 * Handler for Cost blocks that record external vendor spend not metered by Sim.
 */
export class CostBlockHandler implements BlockHandler {
  canHandle(block: SerializedBlock): boolean {
    return block.metadata?.id === BlockType.COST
  }

  async execute(
    ctx: ExecutionContext,
    block: SerializedBlock,
    inputs: Record<string, any>
  ): Promise<BlockOutput> {
    return this.executeWithNode(ctx, block, inputs, { nodeId: block.id })
  }

  async executeWithNode(
    ctx: ExecutionContext,
    block: SerializedBlock,
    inputs: Record<string, any>,
    nodeMetadata: { nodeId: string }
  ): Promise<BlockOutput> {
    const mode = (inputs.mode || 'fixed') as CostMode
    const currency =
      typeof inputs.currency === 'string' && inputs.currency.trim()
        ? inputs.currency.trim().toUpperCase()
        : 'USD'
    const vendor = typeof inputs.vendor === 'string' ? inputs.vendor.trim() : undefined
    const label =
      typeof inputs.label === 'string' && inputs.label.trim() ? inputs.label.trim() : vendor
    const quantity = coerceToNonNegativeNumber(inputs.quantity)
    const unit = typeof inputs.unit === 'string' ? inputs.unit.trim() : undefined
    const exchangeRate = coerceToNonNegativeNumber(inputs.exchangeRate)
    const sourceBlockInput =
      typeof inputs.sourceBlock === 'string' ? inputs.sourceBlock.trim() : undefined
    const responsePath =
      typeof inputs.responsePath === 'string' ? inputs.responsePath.trim() : undefined
    const quantityPath =
      typeof inputs.quantityPath === 'string' ? inputs.quantityPath.trim() : undefined
    const unitPrice = coerceToNonNegativeNumber(inputs.unitPrice)
    const usesSourceBlock = mode === 'per_unit' || mode === 'response_path'
    const sourceBlockId = usesSourceBlock
      ? resolveUpstreamBlockId(ctx, nodeMetadata.nodeId, sourceBlockInput)
      : sourceBlockInput
        ? resolveSourceBlockId(ctx, sourceBlockInput)
        : undefined

    const rawBase: Partial<CostRawOutput> = {
      currency,
      vendor,
      label,
      source: mode,
      quantity,
      unit,
      unitPrice: mode === 'per_unit' ? unitPrice : undefined,
      quantityPath: mode === 'per_unit' ? quantityPath : undefined,
      sourceBlockId,
      responsePath,
      exchangeRate: currency !== 'USD' ? exchangeRate : undefined,
    }

    if (!isSwitchEnabled(inputs.enabled, true)) {
      logger.info('Cost block disabled; skipping recording', { blockId: block.id })
      return buildZeroOutput(rawBase)
    }

    if (
      isSwitchEnabled(inputs.onlyOnSuccess, true) &&
      sourceBlockId &&
      didBlockError(ctx, sourceBlockId)
    ) {
      logger.info('Skipping cost recording because source block errored', {
        blockId: block.id,
        sourceBlockId,
      })
      const passthrough = this.getPassthroughOutput(ctx, sourceBlockId, nodeMetadata.nodeId)
      return buildZeroOutput(rawBase, passthrough)
    }

    let resolvedAmount: number | undefined
    let resolvedQuantity = quantity
    let passthrough: unknown

    if (mode === 'fixed') {
      resolvedAmount = coerceToNonNegativeNumber(inputs.amount)
    } else if (mode === 'expression') {
      resolvedAmount = coerceToNonNegativeNumber(inputs.amountExpression)
    } else if (mode === 'per_unit') {
      if (!quantityPath) {
        throw new Error('Units path is required for per unit mode')
      }
      if (unitPrice === undefined) {
        throw new Error('Price per unit is required for per unit mode')
      }
      if (!sourceBlockId) {
        throw new Error(
          sourceBlockInput
            ? `Source block not found: ${sourceBlockInput}`
            : 'No upstream block found to read units from'
        )
      }

      const { blockData } = collectBlockData(ctx, nodeMetadata.nodeId)
      const sourceOutput = blockData[sourceBlockId]
      passthrough = sourceOutput
      const pathValue =
        sourceOutput !== undefined ? traverseObjectPath(sourceOutput, quantityPath) : undefined
      resolvedQuantity = coerceToNonNegativeNumber(pathValue)
      if (resolvedQuantity === undefined) {
        logger.warn('Cost block could not resolve units from upstream block', {
          blockId: block.id,
          sourceBlockId,
          quantityPath,
        })
        return buildZeroOutput(rawBase, passthrough)
      }

      resolvedAmount = resolvedQuantity * unitPrice
    } else if (mode === 'response_path') {
      if (!responsePath) {
        throw new Error('Response path is required for response path mode')
      }
      if (!sourceBlockId) {
        throw new Error(
          sourceBlockInput
            ? `Source block not found: ${sourceBlockInput}`
            : 'No upstream block found to read amount from'
        )
      }

      const { blockData } = collectBlockData(ctx, nodeMetadata.nodeId)
      const sourceOutput = blockData[sourceBlockId]
      passthrough = sourceOutput
      const pathValue =
        sourceOutput !== undefined ? traverseObjectPath(sourceOutput, responsePath) : undefined
      resolvedAmount = coerceToNonNegativeNumber(pathValue)
    } else {
      throw new Error(`Unknown cost mode: ${mode}`)
    }

    if (resolvedAmount === undefined) {
      logger.warn('Cost block could not resolve a valid non-negative amount', {
        blockId: block.id,
        mode,
        sourceBlockId,
        responsePath,
        quantityPath,
      })
      return buildZeroOutput(rawBase, passthrough)
    }

    if (isSwitchEnabled(inputs.skipIfZero, true) && resolvedAmount === 0) {
      return buildZeroOutput(
        {
          ...rawBase,
          amount: 0,
          quantity: resolvedQuantity,
        },
        passthrough
      )
    }

    const usdTotal = convertToUsd(resolvedAmount, currency, exchangeRate)

    return buildRecordedOutput(
      usdTotal,
      {
        amount: resolvedAmount,
        currency,
        exchangeRate: currency !== 'USD' ? exchangeRate : undefined,
        vendor,
        label,
        source: mode,
        quantity: resolvedQuantity,
        unit,
        unitPrice: mode === 'per_unit' ? unitPrice : undefined,
        quantityPath: mode === 'per_unit' ? quantityPath : undefined,
        sourceBlockId,
        responsePath,
      },
      passthrough
    )
  }

  private getPassthroughOutput(
    ctx: ExecutionContext,
    sourceBlockId: string,
    currentNodeId: string
  ): unknown {
    const { blockData } = collectBlockData(ctx, currentNodeId)
    return blockData[sourceBlockId]
  }
}
