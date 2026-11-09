import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { sleep } from '@sim/utils/helpers'
import { truncateStatusMessage } from '@/local-copilot/lib/agent/status-messages'
import { getLocalCopilotConfig } from '@/local-copilot/lib/config'
import { collectCompletionText } from '@/local-copilot/lib/providers/collect-text'
import { createOpenAiCompatibleProvider } from '@/local-copilot/lib/providers/openai-compatible'
import { getLocalCopilotProvider } from '@/local-copilot/lib/providers/registry'
import type { LocalCopilotProvider } from '@/local-copilot/lib/providers/types'
import type { LocalCopilotConfig, LocalCopilotProviderId } from '@/local-copilot/lib/types'

const logger = createLogger('LocalCopilotEngagementStatus')

const ENGAGEMENT_BATCH_SIZE = 6
const ENGAGEMENT_MAX_TOKENS = 256
const ENGAGEMENT_TIMEOUT_MS = 5000
const ENGAGEMENT_TEMPERATURE = 0.7

/** Default model for optional tool engagement / chat titles (override with `COPILOT_ENGAGEMENT_MODEL`). */
export const DEFAULT_ENGAGEMENT_MODEL = 'gpt-4.1-nano'

export type EngagementPhase = 'model_wait' | 'tool'

export interface EngagementStatusContext {
  phase: EngagementPhase
  toolName?: string
  fileName?: string
  workflowName?: string
  /** Optional short user-turn hint so lines feel task-aware (never secrets). */
  userHint?: string
  signal?: AbortSignal
}

/**
 * Model used for optional tool engagement / chat titles. Defaults to {@link DEFAULT_ENGAGEMENT_MODEL}.
 */
export function resolveEngagementModel(
  _provider?: LocalCopilotProviderId,
  override = process.env.COPILOT_ENGAGEMENT_MODEL?.trim()
): string {
  return override || DEFAULT_ENGAGEMENT_MODEL
}

function resolveOpenAiApiKey(): string | undefined {
  return (
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY_1?.trim() ||
    process.env.OPENAI_API_KEY_2?.trim() ||
    process.env.OPENAI_API_KEY_3?.trim() ||
    undefined
  )
}

function isOpenAiFamilyModel(model: string): boolean {
  const id = model.toLowerCase()
  return (
    id.startsWith('gpt-') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.includes('gpt-4.1')
  )
}

/**
 * Status engagement prefers OpenAI when the engagement model is GPT-family
 * (even if the main Local agent uses Anthropic). Falls back to the Local provider.
 */
export function resolveEngagementProvider(
  model: string,
  _config: LocalCopilotConfig = getLocalCopilotConfig()
): LocalCopilotProvider {
  if (isOpenAiFamilyModel(model)) {
    const apiKey = resolveOpenAiApiKey()
    if (apiKey) {
      return createOpenAiCompatibleProvider({
        enabled: true,
        provider: 'openai',
        model,
        specialistModel: model,
        apiKey,
      })
    }
    logger.warn('Engagement model needs OpenAI key; falling back to Local Copilot provider', {
      model,
    })
  }
  return getLocalCopilotProvider()
}

const SYSTEM_PROMPT = `You write short live status lines for a product UI while an AI assistant is working.
Rules:
- Quiet, trustworthy progress only (present continuous + ellipsis).
- Vary the wording — each line must feel different.
- No jokes, no exclamation spam, no fake percentages, no secrets, no tool IDs.
- Each line ≤ 72 characters.
- Return ONLY a JSON array of exactly ${ENGAGEMENT_BATCH_SIZE} distinct strings.`

function buildUserPrompt(ctx: EngagementStatusContext): string {
  const parts: string[] = []
  if (ctx.phase === 'model_wait') {
    parts.push(
      'The assistant is deciding what to do next (planning / reasoning). Write dynamic status lines for that wait.'
    )
  } else {
    parts.push('The assistant is running a tool. Write dynamic status lines for that wait.')
  }
  if (ctx.toolName) parts.push(`Tool: ${ctx.toolName}`)
  if (ctx.fileName) parts.push(`File: ${ctx.fileName}`)
  if (ctx.workflowName) parts.push(`Workflow: ${ctx.workflowName}`)
  if (ctx.userHint?.trim()) {
    parts.push(`User request (hint only): ${truncateStatusMessage(ctx.userHint.trim(), 120)}`)
  }
  parts.push(
    'Prefer concrete quiet progress over generic “thinking”. Include the file/workflow name when present.'
  )
  return parts.join('\n')
}

function fileNameFromUnknown(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined
  for (const key of ['fileName', 'filename', 'name', 'path']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      const base = value.trim().split('/').pop()
      if (base) return base
    }
  }
  return undefined
}

export function engagementContextFromTool(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  userHint?: string
): EngagementStatusContext {
  const workflowName =
    typeof args.workflowName === 'string' && args.workflowName.trim()
      ? args.workflowName.trim()
      : undefined
  return {
    phase: 'tool',
    toolName,
    fileName: fileNameFromUnknown(args),
    workflowName,
    ...(userHint?.trim() ? { userHint: userHint.trim() } : {}),
    signal,
  }
}

/** Parses a JSON string array from model output; returns null when invalid. */
export function parseEngagementMessages(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start < 0 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }

  if (!Array.isArray(parsed)) return null

  const messages = parsed
    .filter((item): item is string => typeof item === 'string')
    .map((item) => truncateStatusMessage(item.replace(/\s+/g, ' ').trim()))
    .filter((item) => item.length > 0)
    .slice(0, ENGAGEMENT_BATCH_SIZE)

  return messages.length >= 2 ? messages : null
}

/**
 * Asks gpt-4.1-nano (or `COPILOT_ENGAGEMENT_MODEL`) for a batch of dynamic quiet progress lines.
 * Never throws — returns null on timeout, abort, parse failure, or provider error.
 */
export async function generateEngagementStatusMessages(
  ctx: EngagementStatusContext,
  deps?: {
    config?: LocalCopilotConfig
    provider?: LocalCopilotProvider
    model?: string
  }
): Promise<string[] | null> {
  if (ctx.signal?.aborted) return null

  const config = deps?.config ?? getLocalCopilotConfig()
  const model = deps?.model ?? resolveEngagementModel(config.provider)
  const provider = deps?.provider ?? resolveEngagementProvider(model, config)
  const prompt = buildUserPrompt(ctx)

  const timeout = new AbortController()
  const onParentAbort = () => timeout.abort()
  ctx.signal?.addEventListener('abort', onParentAbort, { once: true })

  try {
    const completion = collectCompletionText({
      provider,
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: ENGAGEMENT_TEMPERATURE,
      maxTokens: ENGAGEMENT_MAX_TOKENS,
      signal: timeout.signal,
    })
    const raced = await Promise.race([
      completion.then((text) => ({ ok: true as const, text })),
      sleep(ENGAGEMENT_TIMEOUT_MS).then(() => ({ ok: false as const })),
    ])

    timeout.abort()

    if (!raced.ok) {
      logger.info('Engagement status generation timed out', { model, phase: ctx.phase })
      return null
    }

    const messages = parseEngagementMessages(raced.text)
    if (!messages) {
      logger.info('Engagement status parse failed; keeping fallback copy', {
        model,
        phase: ctx.phase,
        preview: raced.text.slice(0, 120),
      })
      return null
    }

    logger.info('Engagement status batch ready', {
      model,
      phase: ctx.phase,
      count: messages.length,
    })
    return messages
  } catch (error) {
    if (ctx.signal?.aborted || timeout.signal.aborted) return null
    logger.warn('Engagement status generation failed; keeping fallback copy', {
      model,
      phase: ctx.phase,
      error: getErrorMessage(error),
    })
    return null
  } finally {
    ctx.signal?.removeEventListener('abort', onParentAbort)
  }
}
