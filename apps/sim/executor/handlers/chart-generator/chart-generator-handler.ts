import { normalizeChartOutput } from '@/lib/chart-generation/normalize-chart-output'
import { runChartGenerate } from '@/lib/chart-generation/run-chart-generate.server'
import type { BlockOutput } from '@/blocks/types'
import { BlockType } from '@/executor/constants'
import type { BlockHandler, ExecutionContext } from '@/executor/types'
import type { SerializedBlock } from '@/serializer/types'

/**
 * Handler for Chart Generator blocks — LLM-driven chart JSON or validate-only mode.
 * Chart intent and types are resolved by prompts/skills, not hardcoded rules in code.
 * The generate path is shared with the `chart_generate` agent tool via runChartGenerate.
 */
export class ChartGeneratorBlockHandler implements BlockHandler {
  canHandle(block: SerializedBlock): boolean {
    return block.metadata?.id === BlockType.CHART_GENERATOR
  }

  async execute(
    ctx: ExecutionContext,
    _block: SerializedBlock,
    inputs: Record<string, unknown>
  ): Promise<BlockOutput> {
    const operation = String(inputs.operation || 'generate')

    if (operation === 'validate') {
      const normalized = normalizeChartOutput(inputs.rawContent ?? inputs.content, {
        allowPlainTextSkip: true,
      })
      return {
        charts: normalized.charts,
        count: normalized.count,
        valid: normalized.valid,
        skipped: normalized.skipped,
        dashboard: { charts: normalized.charts, count: normalized.count },
      }
    }

    return (await runChartGenerate(inputs, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      workflowId: ctx.workflowId,
      executionContext: ctx,
    })) as unknown as BlockOutput
  }
}
