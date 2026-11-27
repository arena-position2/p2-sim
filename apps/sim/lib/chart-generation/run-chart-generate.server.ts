import { createLogger } from '@sim/logger'
import { CHART_GENERATOR_DEFAULT_MODEL } from '@/lib/chart-generation/chart-generator-config'
import {
  buildChartGeneratorUserPrompt,
  DEFAULT_CHART_GENERATOR_SYSTEM_PROMPT,
} from '@/lib/chart-generation/chart-generator-prompts'
import { normalizeChartOutput } from '@/lib/chart-generation/normalize-chart-output'
import { buildChartSkillsPromptSection } from '@/lib/chart-generation/resolve-chart-skills'
import {
  assertPermissionsAllowed,
  validateModelProvider,
} from '@/ee/access-control/utils/permission-check'
import { DEFAULTS } from '@/executor/constants'
import type { SkillInput } from '@/executor/handlers/agent/types'
import type { ExecutionContext } from '@/executor/types'
import { stringifyJSON } from '@/executor/utils/json'
import { executeBlockProviderRequest } from '@/executor/utils/provider-request'
import { resolveVertexCredential } from '@/executor/utils/vertex-credential'
import { executeProviderRequest } from '@/providers'
import type { ProviderRequest, ProviderResponse } from '@/providers/types'
import { calculateCost, getProviderFromModel } from '@/providers/utils'

const logger = createLogger('RunChartGenerate')

/**
 * Minimal execution context needed to generate a chart. The block handler passes
 * its full ExecutionContext (via `executionContext`) so EE permission checks keep
 * their existing behavior; the agent tool path passes only userId/workspaceId/
 * workflowId resolved from the tool `_context`.
 */
export interface RunChartGenerateContext {
  userId?: string
  workspaceId?: string
  workflowId?: string
  executionContext?: ExecutionContext
}

/** Full output shape shared by the standalone block and the agent tool. */
export interface ChartGenerateResult {
  charts: unknown[]
  count: number
  valid: boolean
  skipped: boolean
  dashboard: { charts: unknown[]; count: number }
  content: string
  model: string
  tokens: { input: number; output: number; total: number }
  cost: { input: number; output: number; total: number }
}

function stringInput(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isStreamingProviderResponse(
  response: Awaited<ReturnType<typeof executeProviderRequest>>
): response is Exclude<Awaited<ReturnType<typeof executeProviderRequest>>, ProviderResponse> {
  return (
    response instanceof ReadableStream ||
    (typeof response === 'object' && response !== null && 'stream' in response)
  )
}

/**
 * A canvas run keeps workspace admission. An agent tool call has only the resolved user.
 */
async function requestChartProvider(
  providerId: string,
  request: ProviderRequest,
  ctx: RunChartGenerateContext
): Promise<ProviderResponse> {
  if (ctx.executionContext) {
    return executeBlockProviderRequest({
      ctx: ctx.executionContext,
      providerId,
      request,
      resolvedSecretTraceRegistry: ctx.executionContext.resolvedSecretTraceRegistry,
    })
  }

  if (!ctx.userId) {
    throw new Error('Unauthorized')
  }

  const response = await executeProviderRequest(providerId, { ...request, userId: ctx.userId })
  if (isStreamingProviderResponse(response)) {
    throw new Error('Provider returned a streaming response for a non-streaming request')
  }
  return response
}

function formatDataInput(data: unknown): string {
  if (data == null) return ''
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

/**
 * Coerce tool/block temperature into a finite number. Agent tool cards often
 * serialize slider values as strings (e.g. "0"), and the provider request
 * rejects those because temperature must be a number.
 */
function resolveTemperature(value: unknown, fallback = 0.2): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

/**
 * Runs the LLM chart-generation flow: builds prompts (with the intent gate that
 * decides text vs chart vs both), calls the provider, and normalizes the result
 * into the `{ charts, count, valid, skipped, dashboard, content, ... }` shape.
 *
 * Shared by ChartGeneratorBlockHandler (canvas/standalone block) and the
 * `chart_generate` agent tool so both behave identically.
 */
export async function runChartGenerate(
  inputs: Record<string, unknown>,
  ctx: RunChartGenerateContext
): Promise<ChartGenerateResult> {
  const model = String(inputs.model || CHART_GENERATOR_DEFAULT_MODEL)
  await validateModelProvider(ctx.userId, ctx.workspaceId, model, ctx.executionContext)

  const providerId = getProviderFromModel(model)
  let apiKey = inputs.apiKey as string | undefined
  if (providerId === 'vertex' && inputs.vertexCredential) {
    apiKey = await resolveVertexCredential({
      credentialId: String(inputs.vertexCredential),
      actingUserId: ctx.userId,
      workspaceId: ctx.workspaceId,
      workflowId: ctx.workflowId,
      callerLabel: 'vertex-chart-generator',
    })
  }

  const userRequest = String(inputs.userRequest || '')
  const data = formatDataInput(inputs.data)

  // Workflows saved with older block versions baked stale defaults into these
  // fields: a userPrompt containing literal <userRequest>/<data> placeholders
  // (which sent the LLM empty inputs) and an outdated system prompt. Ignore
  // both so the backend defaults and real runtime inputs are used instead.
  const savedSystemPrompt = String(inputs.systemPrompt || '').trim()
  let systemPrompt =
    !savedSystemPrompt || savedSystemPrompt.startsWith('You are a chart generation assistant.')
      ? DEFAULT_CHART_GENERATOR_SYSTEM_PROMPT
      : savedSystemPrompt

  const savedUserPrompt = String(inputs.userPrompt || '').trim()
  const userPrompt =
    !savedUserPrompt || /<userRequest>|<data>/.test(savedUserPrompt)
      ? buildChartGeneratorUserPrompt(userRequest, data)
      : savedUserPrompt

  const skillInputs = (inputs.skills as SkillInput[] | undefined) ?? []
  if (skillInputs.length > 0 && ctx.workspaceId) {
    await assertPermissionsAllowed({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      toolKind: 'skill',
      ctx: ctx.executionContext,
    })
    const skillsSection = await buildChartSkillsPromptSection(skillInputs, ctx.workspaceId)
    if (skillsSection) systemPrompt += skillsSection
  }

  try {
    const providerRequest: ProviderRequest = {
      model,
      systemPrompt,
      context: stringifyJSON([{ role: 'user', content: userPrompt }]),
      temperature: resolveTemperature(inputs.temperature),
      apiKey,
      azureEndpoint: stringInput(inputs.azureEndpoint),
      azureApiVersion: stringInput(inputs.azureApiVersion),
      vertexProject: stringInput(inputs.vertexProject),
      vertexLocation: stringInput(inputs.vertexLocation),
      bedrockAccessKeyId: stringInput(inputs.bedrockAccessKeyId),
      bedrockSecretKey: stringInput(inputs.bedrockSecretKey),
      bedrockRegion: stringInput(inputs.bedrockRegion),
      workflowId: ctx.workflowId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
    }

    const result = await requestChartProvider(providerId, providerRequest, ctx)
    const normalized = normalizeChartOutput(result.content, { allowPlainTextSkip: true })

    const usage = result.tokens as
      | (NonNullable<ProviderResponse['tokens']> & { prompt?: number; completion?: number })
      | undefined
    const inputTokens = usage?.input || usage?.prompt || DEFAULTS.TOKENS.PROMPT
    const outputTokens = usage?.output || usage?.completion || DEFAULTS.TOKENS.COMPLETION
    const costCalculation = calculateCost(result.model, inputTokens, outputTokens, false)

    return {
      charts: normalized.charts,
      count: normalized.count,
      valid: normalized.valid,
      skipped: normalized.skipped,
      dashboard: { charts: normalized.charts, count: normalized.count },
      content: typeof result.content === 'string' ? result.content : stringifyJSON(result.content),
      model: result.model,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: result.tokens?.total || DEFAULTS.TOKENS.TOTAL,
      },
      cost: {
        input: costCalculation.input,
        output: costCalculation.output,
        total: costCalculation.total,
      },
    }
  } catch (error) {
    logger.error('Chart generation failed', { error })
    throw error
  }
}
