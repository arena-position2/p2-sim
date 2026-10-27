import { ChartBarIcon } from '@/components/icons'
import { CHART_GENERATOR_DEFAULT_MODEL } from '@/lib/chart-generation/chart-generator-config'
import type { BlockConfig, SubBlockConfig, SuggestedSkill } from '@/blocks/types'
import {
  getModelOptions,
  getProviderCredentialSubBlocks,
  PROVIDER_CREDENTIAL_INPUTS,
} from '@/blocks/utils'

function credentialDependsOn(dependsOn: SubBlockConfig['dependsOn']): string[] {
  return Array.isArray(dependsOn) ? dependsOn : []
}

const ECHARTS_JSON_GENERATOR_SKILL: SuggestedSkill = {
  name: 'echarts-json-generator',
  description:
    'Produce valid Apache ECharts option JSON with correct series types, axes, and data mapping.',
  content: `# ECharts JSON Generator

When generating charts:
- Lock the chart type the user requested; do not substitute another type.
- Output pure JSON: a single bare ECharts option object for one chart, or a bare JSON array of option objects for multiple charts. No wrapper keys (no "charts"/"count"), no "option =" prefix.
- Each chart option must include a non-empty \`series\` array with valid \`type\` strings.
- Use only data from the provided dataset; never invent metrics.
- Valid JSON only — no markdown fences, no JavaScript functions, no trailing commas.
- Radar needs a \`radar.indicator\` array; heatmap data is \`[xIndex, yIndex, value]\` triples plus a \`visualMap\`; candlestick rows are \`[open, close, low, high]\`; graph/sankey use \`nodes\`/\`links\` instead of axes.`,
}

export const ChartGeneratorBlock: BlockConfig = {
  type: 'chart_generator',
  name: 'Chart Generator',
  description: 'Answer data questions in text and generate ECharts visualizations',
  longDescription:
    'Core workflow block. A standalone data-analysis assistant: answers questions in text/markdown like an Agent block, and produces valid ECharts JSON when the user explicitly asks for a visualization — or both in one response. No hardcoded chart rules — prompts and skills drive behavior. Works with any JSON/tabular data source. For deployed chat, select the "content" output.',
  docsLink: 'https://docs.sim.ai/workflows/blocks/chart-generator',
  category: 'blocks',
  bgColor: '#7C3AED',
  icon: ChartBarIcon,
  subBlocks: [
    {
      id: 'operation',
      title: 'Mode',
      type: 'dropdown',
      options: [
        { label: 'Generate (LLM)', id: 'generate' },
        { label: 'Validate JSON only', id: 'validate' },
      ],
      value: () => 'generate',
    },
    {
      id: 'userRequest',
      title: 'Chart request',
      type: 'long-input',
      placeholder: 'e.g. <start.input> or describe the visualization',
      condition: { field: 'operation', value: 'generate' },
    },
    {
      id: 'data',
      title: 'Data',
      type: 'long-input',
      placeholder: 'JSON or table from any upstream block (e.g. <googleadsv11.results>)',
      condition: { field: 'operation', value: 'generate' },
    },
    {
      id: 'rawContent',
      title: 'Chart JSON / agent output',
      type: 'long-input',
      placeholder: 'Paste LLM or agent output to validate (e.g. <agent1.content>)',
      condition: { field: 'operation', value: 'validate' },
    },
    {
      id: 'model',
      title: 'Model',
      type: 'combobox',
      placeholder: 'Type or select a model...',
      required: true,
      defaultValue: CHART_GENERATOR_DEFAULT_MODEL,
      options: getModelOptions,
      condition: { field: 'operation', value: 'generate' },
    },
    ...getProviderCredentialSubBlocks().map(
      (subBlock): SubBlockConfig => ({
        ...subBlock,
        // Keep model-specific credential visibility (OpenAI vs Vertex vs Bedrock) — do not
        // replace with operation-only or deploy will require every provider field.
        condition: (values?: Record<string, unknown>) => {
          if (values?.operation !== 'generate') {
            return { field: 'operation', value: '__never_show__' }
          }
          if (!subBlock.condition) {
            return { field: 'operation', value: 'generate' }
          }
          const inner =
            typeof subBlock.condition === 'function'
              ? subBlock.condition(values)
              : subBlock.condition
          if (inner && typeof inner === 'object' && 'field' in inner) {
            return {
              field: 'operation',
              value: 'generate',
              and: {
                field: inner.field,
                value: inner.value,
                ...(inner.not !== undefined ? { not: inner.not } : {}),
              },
            }
          }
          return { field: 'operation', value: 'generate' }
        },
        dependsOn: [...credentialDependsOn(subBlock.dependsOn), 'operation', 'model'],
      })
    ),
    {
      id: 'skills',
      title: 'Skills',
      type: 'skill-input',
      defaultValue: [],
      condition: { field: 'operation', value: 'generate' },
    },
    {
      // No value() default here: baking the default prompt into the saved workflow
      // freezes it (backend updates stop applying) — leave empty so the handler
      // falls back to DEFAULT_CHART_GENERATOR_SYSTEM_PROMPT at runtime.
      id: 'systemPrompt',
      title: 'System prompt',
      type: 'code',
      placeholder: 'Leave empty to use the built-in analysis + chart instructions',
      mode: 'advanced',
      condition: { field: 'operation', value: 'generate' },
    },
    {
      // No value() default here: it used to serialize literal <userRequest>/<data>
      // placeholders into the workflow, which overrode the runtime-built prompt and
      // sent the LLM empty inputs.
      id: 'userPrompt',
      title: 'User prompt template',
      type: 'code',
      placeholder: 'Leave empty to auto-build from Chart request + Data',
      mode: 'advanced',
      condition: { field: 'operation', value: 'generate' },
    },
    {
      id: 'temperature',
      title: 'Temperature',
      type: 'slider',
      min: 0,
      max: 1,
      defaultValue: 0.2,
      mode: 'advanced',
      condition: { field: 'operation', value: 'generate' },
    },
  ],
  tools: {
    access: ['chart_validate', 'chart_generate'],
    config: {
      // Canvas execution is intercepted by ChartGeneratorBlockHandler (by block
      // type) before the generic tool path, so this selector only drives agent /
      // copilot tool usage: 'generate' -> LLM chart tool, 'validate' -> normalizer.
      tool: (params) => (params.operation === 'validate' ? 'chart_validate' : 'chart_generate'),
      params: (params) => {
        if (params.operation === 'validate') {
          return { content: params.rawContent ?? params.content }
        }
        // Forward the block's own fields as-is (model + provider credentials +
        // prompts already live on the block config in the exact shape
        // runChartGenerate expects). Only strip the routing/validate-only keys.
        const { operation, rawContent, content, ...generateParams } = params
        return generateParams
      },
    },
  },
  inputs: {
    operation: { type: 'string', description: 'generate or validate' },
    userRequest: { type: 'string', description: 'Natural language chart request' },
    data: { type: 'json', description: 'Source data from any block' },
    rawContent: { type: 'json', description: 'Raw JSON/text to validate' },
    skills: { type: 'json', description: 'Selected chart skills' },
    systemPrompt: { type: 'string', description: 'Chart system prompt override' },
    userPrompt: { type: 'string', description: 'Chart user prompt override' },
    ...PROVIDER_CREDENTIAL_INPUTS,
    temperature: { type: 'number', description: 'LLM temperature' },
  },
  outputs: {
    charts: {
      type: 'json',
      description: 'ECharts option objects (array)',
    },
    dashboard: {
      type: 'json',
      description: 'Deploy to chat: { charts, count } for the renderer',
    },
    count: { type: 'number', description: 'Number of charts' },
    valid: { type: 'boolean', description: 'True when at least one chart was produced' },
    skipped: {
      type: 'boolean',
      description: 'True when no chart was requested or output was plain text',
    },
    content: {
      type: 'string',
      description: 'Deploy to chat: text answer and/or chart JSON in one response',
    },
    model: { type: 'string', description: 'Model used' },
    tokens: { type: 'json', description: 'Token usage' },
    cost: { type: 'json', description: 'Cost breakdown' },
  },
}

export const ChartGeneratorBlockMeta = {
  tags: ['data-analytics', 'llm'] as const,
  skills: [ECHARTS_JSON_GENERATOR_SKILL],
} as const satisfies {
  tags: readonly import('@/blocks/types').IntegrationTag[]
  skills: readonly SuggestedSkill[]
}
