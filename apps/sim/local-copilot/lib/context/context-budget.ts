import { getAccurateTokenCount, truncateToTokenLimit } from '@/lib/tokenization/accurate'
import { sanitizeForExport } from '@/lib/workflows/sanitization/json-sanitizer'
import { getMessageContentText } from '@/local-copilot/lib/providers/message-content'
import type { ChatMessage } from '@/local-copilot/lib/providers/types'
import { sanitizeForLlm } from '@/local-copilot/lib/security/sanitize'
import type {
  LocalCopilotProviderId,
  LocalCopilotStructuredContext,
} from '@/local-copilot/lib/types'
import { findCatalogModel } from '@/providers/models'

/**
 * Stable tiktoken encoding for prompt fitting. Bedrock IDs have no encoding and
 * would otherwise under-count Claude/JSON tokens via a silent gpt-4 fallback.
 */
export const LOCAL_COPILOT_TOKEN_COUNT_MODEL = 'gpt-4o'

/** Fallback tiktoken model when the configured provider model has no encoding. */
const DEFAULT_TOKEN_COUNT_MODEL = LOCAL_COPILOT_TOKEN_COUNT_MODEL

/**
 * Soft ceiling for prompt tokens on large-context models.
 * Keeps cost/latency bounded even when the catalog window is 200k–1M+.
 */
export const LOCAL_COPILOT_PROMPT_TOKEN_BUDGET = 120_000

/**
 * Higher soft ceiling for Gemini 3.8 Flash (1M context). Still well below the
 * catalog window so cost/latency stay bounded for Local Copilot turns.
 */
export const LOCAL_COPILOT_GEMINI_38_FLASH_PROMPT_TOKEN_BUDGET = 300_000

/**
 * Tighter ceiling for Bedrock Converse. Catalog Claude entries list 1M windows
 * (and Llama Scout 10M) but on-demand Converse is typically 200k without the
 * 1M beta, Llama/Mistral/GLM do not cache, and tiktoken undercounts Claude.
 */
export const LOCAL_COPILOT_BEDROCK_PROMPT_TOKEN_BUDGET = 48_000

/**
 * Budgeting cap for Bedrock catalog windows. Extended 1M Claude on Bedrock
 * requires a beta header we do not send.
 */
export const LOCAL_COPILOT_BEDROCK_CONTEXT_WINDOW_CAP = 200_000

/** Floor so extreme reservations still leave a usable prompt. */
export const LOCAL_COPILOT_MIN_PROMPT_TOKEN_BUDGET = 8_000

/** Matches Bedrock/Anthropic local-copilot default `maxTokens`. */
export const LOCAL_COPILOT_DEFAULT_MAX_OUTPUT_TOKENS = 8_192

/**
 * Higher generation cap for Gemini 3.8 Flash (catalog max 65,536). 32k leaves
 * headroom for thinking/tool turns without spending the full output quota.
 */
export const LOCAL_COPILOT_GEMINI_38_FLASH_MAX_OUTPUT_TOKENS = 32_768

/**
 * Higher generation cap for Claude (catalog max often 64k–128k). 32k lets
 * Local Copilot finish medium HTML/CSS in one create_file without spending the
 * full quota — Arena/Figma megabyte exports still need modular/patch flows.
 */
export const LOCAL_COPILOT_CLAUDE_MAX_OUTPUT_TOKENS = 32_768

/**
 * Headroom for tokenizer mismatch, message framing, and cache/tool overhead
 * that `estimateChatMessagesTokens` does not see.
 */
export const LOCAL_COPILOT_CONTEXT_SAFETY_BUFFER_TOKENS = 4_000

/** Extra Converse framing / toolConfig / cache-point overhead on Bedrock. */
export const LOCAL_COPILOT_BEDROCK_CONTEXT_SAFETY_BUFFER_TOKENS = 8_000

/** Assumed window when the model is missing from the pricing catalog. */
export const LOCAL_COPILOT_DEFAULT_CONTEXT_WINDOW = 128_000

/** Workflow JSON above this size is sent as block summaries instead of full state. */
export const LOCAL_COPILOT_WORKFLOW_FULL_STATE_TOKEN_BUDGET = 24_000

/** Compact sooner on Bedrock so multi-agent graphs do not fill the 48k cap. */
export const LOCAL_COPILOT_BEDROCK_WORKFLOW_FULL_STATE_TOKEN_BUDGET = 8_000

export interface ResolveLocalCopilotPromptTokenBudgetOptions {
  model: string
  /** When `bedrock`, applies the tighter Converse window and soft cap. */
  provider?: LocalCopilotProviderId
  /** Estimated tokens for tool definitions sent beside the prompt. */
  toolDefinitionTokens?: number
  /** Actual `maxTokens` / max output for this request (not catalog capability). */
  maxOutputTokens?: number
  /** Soft ceiling — never request more than this even if the model allows it. */
  softCap?: number
}

export interface ResolvedLocalCopilotPromptTokenBudget {
  /** Tokens available for chat messages (system + history + user). */
  tokenBudget: number
  /** Catalog (or default) context window used for the calculation. */
  contextWindow: number
  /** Tokens reserved for output + tools + safety buffer. */
  reservedTokens: number
  /** True when the soft cap, not the model window, bound the budget. */
  softCapped: boolean
}

/**
 * Resolves a model-aware prompt token budget:
 * `min(softCap, max(minBudget, contextWindow − maxOutput − tools − safety))`.
 *
 * Smaller Bedrock windows (e.g. Llama 128k) shrink below the 120k soft cap so
 * input + tools + maxTokens fit. Larger Anthropic/OpenAI windows stay
 * soft-capped at 120k. Bedrock uses a 48k soft cap and a 200k window cap.
 * Gemini 3.8 Flash uses a 300k soft cap.
 */
export function resolveLocalCopilotPromptTokenBudget(
  options: ResolveLocalCopilotPromptTokenBudgetOptions
): ResolvedLocalCopilotPromptTokenBudget {
  const isBedrock = options.provider === 'bedrock'
  const softCap =
    options.softCap ?? resolveDefaultPromptTokenSoftCap(options.model, options.provider)
  const maxOutputTokens = Math.max(
    0,
    options.maxOutputTokens ?? LOCAL_COPILOT_DEFAULT_MAX_OUTPUT_TOKENS
  )
  const toolDefinitionTokens = Math.max(0, Math.ceil(options.toolDefinitionTokens ?? 0))
  const safetyBuffer = isBedrock
    ? LOCAL_COPILOT_BEDROCK_CONTEXT_SAFETY_BUFFER_TOKENS
    : LOCAL_COPILOT_CONTEXT_SAFETY_BUFFER_TOKENS
  const reservedTokens = maxOutputTokens + toolDefinitionTokens + safetyBuffer

  const catalog = findCatalogModel(options.model)
  const catalogWindow = catalog?.model.contextWindow
  let contextWindow =
    typeof catalogWindow === 'number' && catalogWindow > 0
      ? catalogWindow
      : LOCAL_COPILOT_DEFAULT_CONTEXT_WINDOW
  if (isBedrock) {
    contextWindow = Math.min(contextWindow, LOCAL_COPILOT_BEDROCK_CONTEXT_WINDOW_CAP)
  }

  const usable = Math.max(LOCAL_COPILOT_MIN_PROMPT_TOKEN_BUDGET, contextWindow - reservedTokens)
  const softCapped = usable > softCap
  const tokenBudget = Math.min(softCap, usable)

  return { tokenBudget, contextWindow, reservedTokens, softCapped }
}

/**
 * Soft cap by provider/model. Explicit `options.softCap` still wins at the
 * call site.
 */
export function resolveDefaultPromptTokenSoftCap(
  model: string,
  provider?: LocalCopilotProviderId
): number {
  if (provider === 'bedrock') return LOCAL_COPILOT_BEDROCK_PROMPT_TOKEN_BUDGET
  const normalized = normalizeLocalCopilotModelId(model)
  if (normalized === 'gemini-3.8-flash') {
    return LOCAL_COPILOT_GEMINI_38_FLASH_PROMPT_TOKEN_BUDGET
  }
  return LOCAL_COPILOT_PROMPT_TOKEN_BUDGET
}

/**
 * Max completion tokens for a Local Copilot parent/specialist request.
 * Gemini 3.8 Flash and Claude get 32k; everyone else keeps the 8k default.
 */
export function resolveLocalCopilotMaxOutputTokens(model: string): number {
  const normalized = normalizeLocalCopilotModelId(model)
  if (normalized === 'gemini-3.8-flash') {
    return LOCAL_COPILOT_GEMINI_38_FLASH_MAX_OUTPUT_TOKENS
  }
  if (normalized.includes('claude')) {
    return LOCAL_COPILOT_CLAUDE_MAX_OUTPUT_TOKENS
  }
  return LOCAL_COPILOT_DEFAULT_MAX_OUTPUT_TOKENS
}

function normalizeLocalCopilotModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/^vertex\//, '')
    .trim()
}

/**
 * Encoding used to fit prompts. Bedrock model IDs are not in tiktoken.
 */
export function resolveLocalCopilotTokenCountModel(
  model: string,
  provider?: LocalCopilotProviderId
): string {
  if (provider === 'bedrock') return LOCAL_COPILOT_TOKEN_COUNT_MODEL
  return model || DEFAULT_TOKEN_COUNT_MODEL
}

/** Recent user/assistant turns kept verbatim (full message bodies) in chat history. */
export const LOCAL_COPILOT_RECENT_TURNS_FULL = 6

/**
 * Hard cap on prior chat rows considered for history.
 * Sized for longer multi-tool threads (user + assistant + tool result rows).
 */
export const LOCAL_COPILOT_MAX_HISTORY_MESSAGES = 200

export type WorkflowContextDetail = 'full' | 'compact'

export interface CompactChatHistoryOptions {
  recentTurnsFull?: number
  maxMessages?: number
  /**
   * @deprecated Older turns are never extractively summarized anymore.
   * Session memory (injected separately) covers aged context. Kept for call-site compat.
   */
  sessionMemoryPresent?: boolean
}

export type ContextInventoryMode = 'full' | 'delta' | 'unchanged'

export interface BuildContextPromptOptions {
  workflowDetail?: WorkflowContextDetail
  /**
   * When `delta` or `unchanged`, omit duplicate workspace inventory arrays —
   * the `Workspace snapshot:` system block is authoritative.
   */
  inventoryMode?: ContextInventoryMode
  /** Snapshot revision echoed into slim context payloads. */
  snapshotRevision?: string
}

interface HistoryTurn {
  messages: ChatMessage[]
}

/**
 * Counts tokens for chat messages with js-tiktoken (`getAccurateTokenCount`).
 * Falls back to chars/4 only if encoding fails inside the tokenizer helper.
 */
export function estimateChatMessagesTokens(
  messages: ChatMessage[],
  model: string = DEFAULT_TOKEN_COUNT_MODEL
): number {
  return messages.reduce(
    (sum, message) => sum + getAccurateTokenCount(getMessageContentText(message.content), model),
    0
  )
}

/**
 * Estimates tokens for tool definitions sent alongside the prompt (not counted by message budget).
 */
export function estimateToolDefinitionTokens(
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  model: string = DEFAULT_TOKEN_COUNT_MODEL
): number {
  if (tools.length === 0) return 0
  try {
    return getAccurateTokenCount(JSON.stringify(tools), model)
  } catch {
    return Math.ceil(JSON.stringify(tools).length / 4)
  }
}

/**
 * Keeps the last K turns verbatim with full message bodies.
 * Older turns are omitted here — structured session memory (injected by the
 * orchestrator) is the summary for aged conversational + technical context.
 * Overall size is still enforced by {@link fitPromptToTokenBudget}.
 */
export function compactChatHistory(
  messages: ChatMessage[],
  options: CompactChatHistoryOptions = {}
): ChatMessage[] {
  const recentTurnsFull = options.recentTurnsFull ?? LOCAL_COPILOT_RECENT_TURNS_FULL
  const maxMessages = options.maxMessages ?? LOCAL_COPILOT_MAX_HISTORY_MESSAGES

  const trimmed = messages.slice(-maxMessages)
  const turns = groupHistoryTurns(trimmed)

  if (turns.length <= recentTurnsFull) {
    return trimmed
  }

  return turns.slice(turns.length - recentTurnsFull).flatMap((turn) => turn.messages)
}

/**
 * Drops oldest non-system chat rows until the prompt fits the token budget.
 */
export function fitPromptToTokenBudget(
  messages: ChatMessage[],
  tokenBudget: number = LOCAL_COPILOT_PROMPT_TOKEN_BUDGET,
  model: string = DEFAULT_TOKEN_COUNT_MODEL
): ChatMessage[] {
  if (estimateChatMessagesTokens(messages, model) <= tokenBudget) return messages

  const systemMessages = messages.filter((message) => message.role === 'system')
  const conversational = messages.filter((message) => message.role !== 'system')
  const turns = groupHistoryTurns(conversational)

  const keptTurns = [...turns]
  while (
    keptTurns.length > 1 &&
    estimateChatMessagesTokens(
      [...systemMessages, ...keptTurns.flatMap((turn) => turn.messages)],
      model
    ) > tokenBudget
  ) {
    keptTurns.shift()
  }

  let trimmedConversation = keptTurns.flatMap((turn) => turn.messages)

  if (
    trimmedConversation.length === 1 &&
    estimateChatMessagesTokens([...systemMessages, ...trimmedConversation], model) > tokenBudget
  ) {
    const last = trimmedConversation[0]
    const overhead = estimateChatMessagesTokens(systemMessages, model)
    const remainingTokens = Math.max(125, tokenBudget - overhead)
    const lastText = getMessageContentText(last.content)
    const truncatedText = truncateToTokenLimit(lastText, remainingTokens, model)
    trimmedConversation = [
      {
        ...last,
        content:
          typeof last.content === 'string'
            ? truncatedText
            : [
                {
                  type: 'text' as const,
                  text: truncatedText,
                },
                ...last.content.filter((part) => part.type === 'image'),
              ],
      },
    ]
  }

  return [...systemMessages, ...trimmedConversation]
}

/**
 * Picks full vs compact workflow detail based on serialized workflow size.
 */
export function resolveWorkflowContextDetail(
  context: LocalCopilotStructuredContext,
  workflowFullStateTokenBudget: number = LOCAL_COPILOT_WORKFLOW_FULL_STATE_TOKEN_BUDGET,
  model: string = DEFAULT_TOKEN_COUNT_MODEL
): WorkflowContextDetail {
  if (!context.workflow) return 'full'

  const fullWorkflowJson = JSON.stringify(
    buildWorkflowPromptPayload(context.workflow, 'full', context.selectedBlockId),
    null,
    2
  )
  if (getAccurateTokenCount(fullWorkflowJson, model) <= workflowFullStateTokenBudget) return 'full'
  return 'compact'
}

/**
 * Builds the JSON string embedded in the system context message.
 */
export function buildContextPromptPayload(
  context: LocalCopilotStructuredContext,
  options: BuildContextPromptOptions = {}
): string {
  const workflowDetail = options.workflowDetail ?? 'full'
  const inventoryMode = options.inventoryMode ?? 'full'
  const slimInventory = inventoryMode === 'delta' || inventoryMode === 'unchanged'
  const workflowPayload = context.workflow
    ? buildWorkflowPromptPayload(context.workflow, workflowDetail, context.selectedBlockId)
    : null

  return JSON.stringify(
    sanitizeForLlm({
      workspace: context.workspace,
      currentUser: context.currentUser,
      connectedIntegrations: context.connectedIntegrations,
      envVariables: slimInventory ? undefined : context.envVariables,
      hostedKeysAvailable: context.hostedKeysAvailable,
      e2b: context.e2b,
      guidance: slimInventory
        ? 'Workspace inventory lives in the Workspace snapshot system block (delta/unchanged mode). Prefer that over inventing resource lists.'
        : context.guidance,
      workflow: workflowPayload,
      workspaceWorkflows: slimInventory ? undefined : context.workspaceWorkflows,
      knowledgeBases: slimInventory ? undefined : context.knowledgeBases,
      tables: slimInventory ? undefined : context.tables,
      workspaceFiles: slimInventory ? undefined : context.workspaceFiles,
      skills: context.skills,
      userMemories: context.userMemories,
      execution: context.execution,
      availableIntegrations: context.availableIntegrations,
      // Full ~300-block catalog omitted — use get_available_blocks / get_blocks_metadata.
      availableBlocksNote:
        'Block catalog omitted to save tokens. Call get_available_blocks or get_blocks_metadata for the types you need.',
      selectedBlockId: context.selectedBlockId,
      ...(slimInventory
        ? {
            inventoryMode,
            ...(options.snapshotRevision ? { snapshotRevision: options.snapshotRevision } : {}),
          }
        : {}),
    }),
    null,
    2
  )
}

export function buildWorkflowPromptPayload(
  workflow: NonNullable<LocalCopilotStructuredContext['workflow']>,
  detail: WorkflowContextDetail,
  selectedBlockId?: string
) {
  if (detail === 'full') {
    return {
      id: workflow.id,
      name: workflow.name,
      detail: 'full' as const,
      state: sanitizeForExport({
        blocks: workflow.blocks,
        edges: workflow.edges,
        loops: workflow.loops,
        parallels: workflow.parallels,
        variables: workflow.variables,
        metadata: { name: workflow.name },
      }).state,
      credentials: workflow.credentials,
    }
  }

  return {
    id: workflow.id,
    name: workflow.name,
    detail: 'compact' as const,
    note: 'Block subBlock values omitted to save context. Call get_workflow_context with blockNames (or blockIds) for the blocks you need before edit_workflow.',
    state: buildCompactWorkflowState(workflow, selectedBlockId),
    credentials: workflow.credentials,
  }
}

export interface GetWorkflowContextSelector {
  blockIds?: string[]
  blockNames?: string[]
}

/**
 * Standalone get_workflow_context payload. Returns the open workflow only —
 * never the full workspace snapshot (that is already in the system prompt and
 * offloading it as an artifact stalls the following edit).
 */
export function buildGetWorkflowContextResult(
  context: LocalCopilotStructuredContext,
  selector: GetWorkflowContextSelector = {}
): Record<string, unknown> {
  const workflow = context.workflow
  if (!workflow) {
    return {
      workflow: null,
      message:
        'No workflow is open. After create_workflow, use the returned workflowId and startBlockId with edit_workflow. Do not call get_workflow_context for workspace inventory.',
    }
  }

  const blockIds = (selector.blockIds ?? []).filter((id) => id.trim().length > 0)
  const blockNames = (selector.blockNames ?? []).filter((name) => name.trim().length > 0)
  if (blockIds.length > 0 || blockNames.length > 0) {
    return buildWorkflowBlockInspection(workflow, { blockIds, blockNames }) as Record<
      string,
      unknown
    >
  }

  const detail = resolveWorkflowContextDetail(context)
  const payload = buildWorkflowPromptPayload(workflow, detail, context.selectedBlockId)
  const blockCount = Object.keys(workflow.blocks ?? {}).length
  if (blockCount <= 1) {
    return {
      ...payload,
      hint: 'Start-only workflow. Call edit_workflow to add blocks. Do not call get_workflow_context or load_copilot_artifact again.',
    }
  }
  return payload
}

export interface WorkflowBlockInspectionSelector {
  blockIds?: string[]
  blockNames?: string[]
}

/**
 * Returns full sanitized detail for selected blocks (by id and/or display name).
 * Used when compact workflow context omits subBlock values.
 */
export function buildWorkflowBlockInspection(
  workflow: NonNullable<LocalCopilotStructuredContext['workflow']>,
  selector: WorkflowBlockInspectionSelector
) {
  const idSet = new Set(
    (selector.blockIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
  )
  const nameSet = new Set(
    (selector.blockNames ?? [])
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0)
  )

  const matched = Object.values(workflow.blocks).filter((block) => {
    if (idSet.has(block.id)) return true
    const name = typeof block.name === 'string' ? block.name.trim().toLowerCase() : ''
    return name.length > 0 && nameSet.has(name)
  })

  const sanitized = sanitizeForExport({
    blocks: Object.fromEntries(matched.map((block) => [block.id, block])),
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
    metadata: { name: workflow.name },
  }).state

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    requestedBlockIds: [...idSet],
    requestedBlockNames: [...nameSet],
    matchedCount: matched.length,
    blocks: sanitized.blocks,
    note:
      matched.length === 0
        ? 'No blocks matched. Use display names or UUIDs from the compact workflow context.'
        : undefined,
  }
}

function buildCompactWorkflowState(
  workflow: NonNullable<LocalCopilotStructuredContext['workflow']>,
  selectedBlockId?: string
) {
  const blocks = Object.values(workflow.blocks).map((block) => {
    const summary = {
      id: block.id,
      type: block.type,
      name: block.name,
      enabled: block.enabled,
      subBlockKeys: Object.keys(block.subBlocks ?? {}),
    }

    if (selectedBlockId && block.id === selectedBlockId) {
      return { ...summary, subBlocks: block.subBlocks }
    }

    return summary
  })

  const edges = workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }))

  const variables = Object.fromEntries(
    Object.entries(workflow.variables ?? {}).map(([key, variable]) => [
      key,
      {
        id: variable.id,
        name: variable.name,
        type: variable.type,
      },
    ])
  )

  return {
    blocks,
    edges,
    variables,
    loops: workflow.loops,
    parallels: workflow.parallels,
  }
}

function groupHistoryTurns(messages: ChatMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = []
  let current: ChatMessage[] = []

  for (const message of messages) {
    if (message.role === 'user' && current.length > 0) {
      turns.push({ messages: current })
      current = []
    }
    current.push(message)
  }

  if (current.length > 0) {
    turns.push({ messages: current })
  }

  return turns
}
