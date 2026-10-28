import { normalizeChartOutput } from '@/lib/chart-generation/normalize-chart-output'
import type { ToolConfig, ToolResponse } from '@/tools/types'

export interface ChartValidateParams {
  content: string | Record<string, unknown>
}

export interface ChartValidateResponse extends ToolResponse {
  output: {
    charts: Record<string, unknown>[]
    count: number
    valid: boolean
    skipped: boolean
  }
}

export async function executeChartValidateDirect(
  params: ChartValidateParams
): Promise<ChartValidateResponse> {
  const normalized = normalizeChartOutput(params.content, { allowPlainTextSkip: true })
  return {
    success: true,
    output: {
      charts: normalized.charts as unknown as Record<string, unknown>[],
      count: normalized.count,
      valid: normalized.valid,
      skipped: normalized.skipped,
    },
  }
}

/**
 * Validate and normalize chart JSON without calling an LLM.
 * Accepts agent text, function block output, or any upstream JSON.
 */
export const chartValidateTool: ToolConfig<ChartValidateParams, ChartValidateResponse> = {
  id: 'chart_validate',
  name: 'Validate Chart JSON',
  description:
    'Parse and validate ECharts JSON into a normalized { charts, count } payload for chat rendering.',
  version: '1.0.0',

  params: {
    content: {
      type: 'json',
      required: true,
      description: 'Raw LLM text or JSON object containing ECharts options',
    },
  },

  request: {
    url: '/api/tools/chart/validate',
    method: 'POST',
    headers: () => ({}),
  },

  outputs: {
    charts: { type: 'json', description: 'Normalized ECharts options for rendering' },
    count: { type: 'number', description: 'Number of charts' },
    valid: { type: 'boolean', description: 'True when at least one valid chart was found' },
    skipped: {
      type: 'boolean',
      description: 'True when input was plain text or an intentional empty chart payload',
    },
  },
}
