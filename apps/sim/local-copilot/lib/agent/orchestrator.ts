import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { generateId } from '@sim/utils/id'
import { truncate } from '@sim/utils/string'
import {
  type BillingAttributionSnapshot,
  resolveBillingAttribution,
} from '@/lib/billing/core/billing-attribution'
import type { VfsSnapshotV1 } from '@/lib/mothership/generated/vfs-snapshot-v1'
import { iterateWithIdleStatus } from '@/local-copilot/lib/agent/iterate-with-idle-status'
import {
  HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
  MAX_DEBUG_EXPLANATION_CONTINUATION_ROUNDS,
  MAX_FILE_EDIT_CONTINUATION_ROUNDS,
  MAX_FORCED_FOLLOW_UP_ROUNDS,
  MAX_HTML_EDIT_GREP_NUDGE_ROUNDS,
  MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
  MAX_INCOMPLETE_WORKFLOW_POPULATE_CONTINUATION_ROUNDS,
  MAX_INTENT_CONTINUATION_ROUNDS,
  MAX_POPULATE_EDITS,
  MAX_POPULATE_EDITS_HARD_LOCK,
  MAX_RESEARCH_SEARCH_CONTINUATION_ROUNDS,
  MAX_WORKFLOW_BUILD_CONTINUATION_ROUNDS,
} from '@/local-copilot/lib/agent/limits'
import { runToolWithStatus } from '@/local-copilot/lib/agent/run-tool-with-status'
import { createSpecialistBudget } from '@/local-copilot/lib/agent/specialists/budget'
import {
  classifyLocalCopilotIntent,
  selectParallelSubagentDomains,
  specialistPassDomain,
} from '@/local-copilot/lib/agent/specialists/classify'
import {
  domainSystemHint,
  resolveHybridParentTools,
} from '@/local-copilot/lib/agent/specialists/domains'
import { runParallelSubagents } from '@/local-copilot/lib/agent/specialists/parallel-subagents'
import { runParentSpecialistToolCalls } from '@/local-copilot/lib/agent/specialists/parent-calls'
import { runSpecialistPass } from '@/local-copilot/lib/agent/specialists/specialist-pass'
import {
  getParentSpecialistToolDefinitions,
  isSpecialistTool,
} from '@/local-copilot/lib/agent/specialists/specialist-tools'
import { MODEL_WAIT_STATUS_FALLBACK } from '@/local-copilot/lib/agent/status-messages'
import { unresolvedThinkingBlockText } from '@/local-copilot/lib/agent/thinking-block-to-delta'
import {
  applyModelChunkToThinkingStatus,
  ThinkingDeltaBatcher,
  ThinkingLiveStatusAccumulator,
} from '@/local-copilot/lib/agent/thinking-live-status'
import {
  buildFileExploreSystemMessage,
  createFileExploreTracker,
  createToolStagnationTracker,
  resolveStagnationAction,
} from '@/local-copilot/lib/agent/tool-stagnation'
import { formatUxPhaseStatus, type LocalUxPhase } from '@/local-copilot/lib/agent/ux-phase'
import { logCopilotAction } from '@/local-copilot/lib/audit/logger'
import { sanitizeToolIoForPersistence } from '@/local-copilot/lib/audit/sanitize-persistence'
import { recordLocalCopilotTurnUsage } from '@/local-copilot/lib/billing/record-turn-usage'
import { resolveLocalCopilotSpendCap } from '@/local-copilot/lib/billing/resolve-spend-cap'
import { assertSpendCapAllows } from '@/local-copilot/lib/billing/spend-cap'
import {
  LocalTurnCostAccumulator,
  type LocalTurnCostSummary,
} from '@/local-copilot/lib/billing/turn-cost-accumulator'
import {
  assertLocalCopilotEnabled,
  buildLocalCopilotConfigForCatalog,
  getLocalCopilotConfig,
} from '@/local-copilot/lib/config'
import {
  formatActiveDocumentsSystemMessage,
  persistActiveDocuments,
  updateActiveDocumentsFromTurn,
} from '@/local-copilot/lib/context/active-documents'
import { createArtifactStore, persistArtifacts } from '@/local-copilot/lib/context/artifacts'
import {
  buildLocalCopilotContext,
  contextToPromptJson,
} from '@/local-copilot/lib/context/build-context'
import { mergeCopilotChatConfig } from '@/local-copilot/lib/context/chat-config'
import {
  compactChatHistory,
  estimateChatMessagesTokens,
  estimateToolDefinitionTokens,
  LOCAL_COPILOT_BEDROCK_WORKFLOW_FULL_STATE_TOKEN_BUDGET,
  LOCAL_COPILOT_WORKFLOW_FULL_STATE_TOKEN_BUDGET,
  resolveLocalCopilotMaxOutputTokens,
  resolveLocalCopilotPromptTokenBudget,
  resolveLocalCopilotTokenCountModel,
  resolveWorkflowContextDetail,
} from '@/local-copilot/lib/context/context-budget'
import {
  extractFollowUpDirectives,
  formatActiveDirectiveSystemMessage,
  formatSessionConstraintsSystemMessage,
} from '@/local-copilot/lib/context/follow-up-directives'
import {
  applyMicrocompactInPlace,
  microcompactMessages,
} from '@/local-copilot/lib/context/microcompact'
import { resolveOpenWorkflowId } from '@/local-copilot/lib/context/open-workflow'
import { startPromptContextPrefetch } from '@/local-copilot/lib/context/prefetch-prompt-context'
import { persistInferredUserMemories } from '@/local-copilot/lib/context/promote-durable-memory'
import { fitPromptWithSlots } from '@/local-copilot/lib/context/prompt-slots'
import { rewriteSnapshotSkillsForLocalCopilot } from '@/local-copilot/lib/context/relevant-skills'
import {
  ensureSessionMemory,
  formatRecentToolFailuresSystemMessage,
  formatSessionMemorySystemMessage,
  mergeFollowUpDirectivesIntoSessionMemory,
  mergeSessionMemoryEvidence,
  persistSessionMemory,
  type SessionMemoryTurn,
} from '@/local-copilot/lib/context/session-memory'
import {
  parseWorkspaceSnapshotFingerprints,
  parseWorkspaceSnapshotMeta,
  resolveSnapshotPromptPlan,
  type SnapshotPromptPlan,
  withWorkspaceSnapshotPrefix,
} from '@/local-copilot/lib/context/snapshot-delta'
import { toWorkspaceSnapshotMeta } from '@/local-copilot/lib/context/snapshot-freshness'
import {
  formatTaskStateSystemMessage,
  persistTaskState,
  updateTaskStateFromTurn,
} from '@/local-copilot/lib/context/task-state'
import { getLocalCopilotMemorySnapshot } from '@/local-copilot/lib/diagnostics'
import { createLocalCopilotTurnTiming } from '@/local-copilot/lib/diagnostics/turn-timing'
import {
  extractOptionsTitles,
  formatOptionsTag,
  hasOptionsTag,
  normalizeSingleSelectJsonToOptionsTags,
  stripOptionsTagsForDisplay,
} from '@/local-copilot/lib/format-options-tag'
import {
  DEFAULT_LOCAL_COPILOT_CATALOG_ID,
  type LocalCopilotCatalogId,
} from '@/local-copilot/lib/model-catalog'
import {
  buildOAuthConnectControl,
  type OAuthConnectControl,
} from '@/local-copilot/lib/oauth-connect-text'
import { auditLocalOpsEvent } from '@/local-copilot/lib/ops/audit-metrics'
import { LOCAL_OPS_COUNTERS, recordLocalOpsEvent } from '@/local-copilot/lib/ops/metrics'
import {
  appendMessage,
  createConversation,
  ensureConversationForChat,
  getMessages,
  recordToolCall,
  savePatch,
} from '@/local-copilot/lib/persistence/store'
import { buildLocalCopilotSystemPrompt } from '@/local-copilot/lib/prompts'
import {
  createLocalCopilotProvider,
  getLocalCopilotProvider,
} from '@/local-copilot/lib/providers/registry'
import type {
  AnthropicThinkingHistoryBlock,
  ChatMessage,
  GeminiHistoryPart,
} from '@/local-copilot/lib/providers/types'
import {
  prepareLocalToolConfirmation,
  waitForLocalToolConfirmation,
} from '@/local-copilot/lib/security/request-tool-confirmation'
import { classifyLocalToolConfirmation } from '@/local-copilot/lib/security/tool-confirmation-policy'
import {
  buildGeneratedApiKeyControl,
  formatTrustedControl,
  type LocalTrustedControl,
} from '@/local-copilot/lib/security/trusted-controls'
import {
  buildDebugInspectionChatAppendix,
  buildFileInspectionChatAppendix,
  buildToolFailureEvidenceLines,
  buildWorkflowBuildChatAppendix,
  buildWorkflowRunChatAppendix,
  generatedImageChatMarkdown,
  isWorkflowRunToolName,
  shouldAppendWorkflowRunChatResult,
  stripLeakedToolMarkers,
  synthesizeAssistantSummaryFromTools,
  type ToolTurnRecord,
  turnHasDebugInspectionTools,
  turnHasFileInspectionTools,
  turnHasFileMutationTools,
  turnHasWorkflowDiscoveryTools,
  turnHasWorkflowMutationTools,
} from '@/local-copilot/lib/synthesize-assistant-summary'
import { toolRequiresWorkflowContextRefresh } from '@/local-copilot/lib/tools/context-refresh'
import { LOCAL_COPILOT_TOOLS } from '@/local-copilot/lib/tools/definitions'
import type { ToolExecutionContext, ToolExecutionResult } from '@/local-copilot/lib/tools/executor'
import {
  bindLocalFileIntentChannel,
  buildFollowUpContinuationMessage,
  canEnterToolRound,
  canForceMandatoryFollowUp,
  clearLocalFileIntentChannel,
  coalesceToolExecutionPayloadForLlm,
  detectMandatoryFollowUpFromExecution,
  formatToolResultForLlm,
  type MandatoryFollowUp,
  resolveMandatoryFollowUps,
  sortToolCallsForExecution,
} from '@/local-copilot/lib/tools/format-tool-result'
import { isWorkflowScopedDelegatedTool } from '@/local-copilot/lib/tools/mothership-delegated-tool-defs'
import {
  isParallelReadTool,
  MAX_PARALLEL_READ_TOOLS,
} from '@/local-copilot/lib/tools/parallel-reads'
import type { LocalCopilotStreamEvent, WorkflowPatch } from '@/local-copilot/lib/types'
import {
  admitPrePopulateDiscovery,
  buildBlocksMetadataReuseSystemMessage,
  buildDebugExplanationContinuationMessage,
  buildFileEditContinuationMessage,
  buildIncompleteWorkflowPopulateContinuationMessage,
  buildPrePopulateDiscoveryBlockedMessage,
  buildResearchSearchContinuationMessage,
  buildUnfulfilledIntentContinuationMessage,
  buildUnresolvedFollowUpClosingMessage,
  buildWorkflowBuildCompleteSystemMessage,
  buildWorkflowBuildContinuationMessage,
  buildWorkflowBuildSoftCompleteSystemMessage,
  createAssistantRoundTextStreamer,
  editResultNeedsFollowUp,
  emptyAssistantTurnFallback,
  isBridgingAssistantNarration,
  isFileInspectionBridgeNarration,
  isLiveWebSearchToolCall,
  isUnfulfilledMutationIntentNarration,
  type PostBuildToolMode,
  pendingFollowUpsAreOauthOnly,
  resolvePostBuildRoundTools,
  shouldEmitEmptyAssistantFallback,
  shouldEnsureWorkflowBuildClosingMessage,
  shouldForceDebugExplanationContinuation,
  shouldForceFileEditContinuation,
  shouldForceIncompleteWorkflowPopulateContinuation,
  shouldForceResearchSearchContinuation,
  shouldForceWorkflowBuildContinuation,
  shouldRefundPrePopulateDiscoveryRound,
  shouldSynthesizeAssistantSummary,
  stripIdsFromUserFacingText,
} from '@/local-copilot/lib/user-facing-text'
import {
  type CopilotContextEntry,
  type CopilotFileAttachmentRef,
  getLocalCopilotUserTurnText,
} from '@/local-copilot/lib/user-turn-content'
import { resolveTurnCompletion } from '@/local-copilot/lib/verification/completion'
import { mutationRequiresVerification } from '@/local-copilot/lib/verification/policy'
import { runPostMutationVerification } from '@/local-copilot/lib/verification/run-verification'
import type { MutationOutcome, VerificationRecord } from '@/local-copilot/lib/verification/types'
import {
  buildHtmlEditGrepNudgeMessage,
  buildHtmlEditWriteGiveUpMessage,
  buildHtmlEditWriteNudgeMessage,
  countSuccessfulFileInspections,
  extractHtmlEditGrepTokens,
  hasHtmlEditContext,
  shouldForceHtmlEditGrepNudge,
  shouldForceHtmlEditWriteNudge,
  shouldStopHtmlEditWithoutWrite,
} from '@/local-copilot/lib/writes/html-edit-intent'
import { createTurnMutations } from '@/local-copilot/lib/writes/turn-mutations'
import { MAX_TOOL_ITERATIONS } from '@/providers'

const logger = createLogger('LocalCopilotAgent')

export interface RunAgentParams {
  userId: string
  workspaceId: string
  workflowId?: string
  message: string
  conversationId?: string
  chatId?: string
  /** Scopes workspace_file → edit_content intents (mothership user message id when available). */
  messageId?: string
  /** Copilot run id for Usage joins (`usage_log.run_id`). */
  runId?: string
  selectedBlockId?: string
  executionId?: string
  /** Parent workflow execution when Local runs inside a mothership block. */
  parentExecutionId?: string
  signal?: AbortSignal
  /** Prior turns from mothership chat (`copilot_messages`). */
  priorMessages?: ChatMessage[]
  /** Compact persisted turns with ids for session-memory refresh (mothership path). */
  sessionMemoryTurns?: SessionMemoryTurn[]
  /** When false, skip `local_copilot_*` persistence (mothership chat owns the transcript). */
  persistLocally?: boolean
  /**
   * When false, accumulate cost but do not write `usage_log` (workflow logger owns
   * mothership-block cost via the generator return value). Defaults to true for interactive chat.
   */
  writeChatLedger?: boolean
  /** Workspace permission for write tools (create_file, user_table create, knowledge_base add_file). */
  userPermission?: string
  /** Mothership request context entries (upload hints, resource tags, etc.). */
  contexts?: CopilotContextEntry[]
  /** Raw file attachment refs from the chat request (fallback when context is missing). */
  fileAttachments?: CopilotFileAttachmentRef[]
  /** Workspace markdown snapshot from mothership payload. */
  workspaceContext?: string
  /**
   * Typed workspace inventory snapshot from the mothership payload. Paired with
   * `workspaceContext` (markdown) to seed context building without a second DB fetch.
   */
  workspaceSnapshot?: VfsSnapshotV1
  /**
   * Allowlisted Local Copilot model catalog id. When set, builds a per-request
   * provider config instead of using process-wide `COPILOT_*` env defaults.
   */
  catalogId?: LocalCopilotCatalogId
  /**
   * Workspace payer snapshot from mothership admission. When omitted, turn
   * usage recording resolves attribution from the workspace.
   */
  billingAttribution?: BillingAttributionSnapshot
}

export async function* runLocalCopilotAgent(
  params: RunAgentParams
): AsyncGenerator<LocalCopilotStreamEvent, LocalTurnCostSummary | undefined, undefined> {
  const startedAt = Date.now()
  const timing = createLocalCopilotTurnTiming(startedAt)
  const catalogId = params.catalogId ?? DEFAULT_LOCAL_COPILOT_CATALOG_ID
  const config = params.catalogId
    ? buildLocalCopilotConfigForCatalog(catalogId)
    : getLocalCopilotConfig()
  assertLocalCopilotEnabled(config)
  /**
   * Unique per user turn. Mothership Chat may still lack a local conversation
   * until ensureConversationForChat runs; round indexes reset each turn —
   * without this, usage_log eventKeys collide and later turns are dropped by
   * onConflictDoNothing.
   */
  const usageTurnId = params.messageId?.trim() || generateId()
  logger.info('Arena Copilot agent starting', {
    workspaceId: params.workspaceId,
    workflowId: params.workflowId ?? null,
    chatId: params.chatId ?? null,
    usageTurnId,
    catalogId,
    provider: config.provider,
    model: config.model,
    specialistModel: config.specialistModel,
    hasApiKey: Boolean(config.apiKey),
    messageChars: params.message.length,
    priorTurns: params.priorMessages?.length ?? 0,
    hasCallerSnapshot: Boolean(params.workspaceSnapshot && params.workspaceContext),
    memory: getLocalCopilotMemorySnapshot(),
  })

  const workspaceSnapshotBundle =
    params.workspaceContext && params.workspaceSnapshot
      ? { markdown: params.workspaceContext, snapshot: params.workspaceSnapshot }
      : undefined

  const resolvedWorkflowId = resolveOpenWorkflowId({
    workflowId: params.workflowId,
    contexts: params.contexts,
    snapshotWorkflows: params.workspaceSnapshot?.workflows,
  })

  // Overlap tools / user-turn / chat-config I/O with context build + session setup.
  const promptPrefetch = startPromptContextPrefetch({
    userId: params.userId,
    workspaceId: params.workspaceId,
    ...(params.chatId ? { chatId: params.chatId } : {}),
    message: params.message,
    ...(params.contexts?.length ? { contexts: params.contexts } : {}),
    ...(params.fileAttachments?.length ? { fileAttachments: params.fileAttachments } : {}),
  })
  const snapshotSandboxEntitled =
    params.workspaceSnapshot?.sandboxes !== undefined ? true : undefined
  if (params.workspaceSnapshot?.skills?.length) {
    promptPrefetch.startSkills(
      params.workspaceSnapshot.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description ?? '',
      })),
      snapshotSandboxEntitled
    )
  }
  const earlySessionMemoryPromise = params.priorMessages?.length
    ? ensureSessionMemory({
        chatId: params.chatId,
        userId: params.userId,
        workspaceId: params.workspaceId,
        historyMessages: params.priorMessages,
        turns: params.sessionMemoryTurns ?? [],
        signal: params.signal,
      })
    : null
  // Overlap with context / session / prefetch. Prefer attributed payer check so
  // mothership's earlier UsageMonitor cache hit can make this near-instant.
  const spendCapPromise = resolveLocalCopilotSpendCap({
    userId: params.userId,
    ...(params.billingAttribution ? { billingAttribution: params.billingAttribution } : {}),
  })

  let structuredContext
  try {
    structuredContext = await buildLocalCopilotContext({
      userId: params.userId,
      workspaceId: params.workspaceId,
      ...(resolvedWorkflowId ? { workflowId: resolvedWorkflowId } : {}),
      selectedBlockId: params.selectedBlockId,
      executionId: params.executionId,
      ...(workspaceSnapshotBundle ? { workspaceSnapshot: workspaceSnapshotBundle } : {}),
    })
  } catch (error) {
    logger.error('Arena Copilot context build failed', {
      workspaceId: params.workspaceId,
      workflowId: resolvedWorkflowId ?? params.workflowId ?? null,
      error: getErrorMessage(error, 'context build failed'),
      memory: getLocalCopilotMemorySnapshot(),
    })
    throw error
  }

  const contextSandboxEntitled =
    structuredContext.vfsSnapshot?.sandboxes !== undefined ? true : undefined
  promptPrefetch.startSkills(structuredContext.skills, contextSandboxEntitled)
  timing.mark('contextReady')

  logger.info('Arena Copilot context built', {
    workspaceId: params.workspaceId,
    workflowId: resolvedWorkflowId ?? params.workflowId ?? null,
    openWorkflowLoaded: Boolean(structuredContext.workflow),
    workspaceWorkflowCount: structuredContext.workspaceWorkflows?.length ?? 0,
    availableBlockCount: structuredContext.availableBlocks?.length ?? 0,
    durationMs: timing.elapsed('contextReady'),
    hasCallerSnapshot: Boolean(workspaceSnapshotBundle),
    memory: getLocalCopilotMemorySnapshot(),
  })

  const persistLocally = params.persistLocally !== false
  const writeChatLedger = params.writeChatLedger !== false
  const turnCost = new LocalTurnCostAccumulator()

  let conversationId = params.conversationId
  const extractedDirectives = extractFollowUpDirectives(params.message)
  if (extractedDirectives.preferences.length > 0) {
    void persistInferredUserMemories({
      userId: params.userId,
      workspaceId: params.workspaceId,
      preferences: extractedDirectives.preferences,
    }).catch(() => undefined)
  }

  if (persistLocally) {
    if (!conversationId) {
      conversationId = await createConversation({
        userId: params.userId,
        workspaceId: params.workspaceId,
        workflowId: params.workflowId,
        model: config.model,
        provider: config.provider,
      })
    }

    await appendMessage({
      conversationId,
      role: 'user',
      content: { text: params.message },
    })
  } else if (!conversationId && params.chatId?.trim()) {
    // Chat/mothership keeps messages on copilot_messages, but audit rows need a
    // local conversation_id FK — ensure one keyed by chatId without dual-writing history.
    try {
      conversationId = await ensureConversationForChat({
        userId: params.userId,
        workspaceId: params.workspaceId,
        chatId: params.chatId,
        workflowId: params.workflowId,
        model: config.model,
        provider: config.provider,
      })
    } catch (error) {
      logger.warn('Arena Copilot failed to ensure chat audit conversation', {
        chatId: params.chatId,
        error: getErrorMessage(error),
      })
    }
  }

  void logCopilotAction({
    userId: params.userId,
    workspaceId: params.workspaceId,
    workflowId: params.workflowId,
    conversationId,
    action: 'chat_message',
    summary: params.message.slice(0, 200),
    metadata: {
      chatId: params.chatId,
      runId: params.runId,
      backend: 'local',
      persistLocally,
    },
  }).catch(() => undefined)

  const rawHistory: ChatMessage[] = params.priorMessages?.length
    ? params.priorMessages
    : conversationId
      ? (await getMessages(conversationId)).slice(0, -1).flatMap((row) => {
          const content = row.content as { text?: string }
          if (!content.text) return []
          return [{ role: row.role as 'user' | 'assistant', content: content.text }]
        })
      : []

  const [sessionMemoryInitial, settledPrefetch] = await Promise.all([
    earlySessionMemoryPromise ??
      ensureSessionMemory({
        chatId: params.chatId,
        userId: params.userId,
        workspaceId: params.workspaceId,
        historyMessages: rawHistory,
        turns: params.sessionMemoryTurns ?? [],
        signal: params.signal,
      }),
    promptPrefetch.settle(),
  ])
  timing.mark('sessionPrefetchReady')

  let sessionMemory = sessionMemoryInitial
  if (extractedDirectives.constraints.length > 0 || extractedDirectives.activeDirective) {
    sessionMemory = await mergeFollowUpDirectivesIntoSessionMemory({
      chatId: params.chatId,
      userId: params.userId,
      previous: sessionMemory,
      constraints: extractedDirectives.constraints,
      activeDirective: extractedDirectives.activeDirective,
    })
  }

  const historyMicrocompact = rawHistory.length
    ? microcompactMessages(
        compactChatHistory(rawHistory, { sessionMemoryPresent: Boolean(sessionMemory) })
      )
    : { messages: [] as ChatMessage[], clearedCount: 0, charsFreed: 0 }
  const historyMessages = historyMicrocompact.messages

  const tokenCountModel = resolveLocalCopilotTokenCountModel(config.model, config.provider)
  const workflowFullStateTokenBudget =
    config.provider === 'bedrock'
      ? LOCAL_COPILOT_BEDROCK_WORKFLOW_FULL_STATE_TOKEN_BUDGET
      : LOCAL_COPILOT_WORKFLOW_FULL_STATE_TOKEN_BUDGET
  const workflowDetail = resolveWorkflowContextDetail(
    structuredContext,
    workflowFullStateTokenBudget,
    tokenCountModel
  )

  const {
    relevantSkills,
    allTools,
    userTurn,
    chatConfig,
    chatUploadsInventory,
    activeDocuments,
    activeEditTarget,
    currentRequestUploadPaths,
  } = settledPrefetch
  let taskState = settledPrefetch.taskState
  let activeDocumentsState = activeDocuments
  if (relevantSkills.names.length > 0) {
    logger.info('Arena Copilot loaded relevant workspace skills', {
      workspaceId: params.workspaceId,
      skillNames: relevantSkills.names,
    })
  }
  if (settledPrefetch.autoInlinedPriorUploads) {
    logger.info('Arena Copilot auto-inlined prior chat uploads for proceed turn', {
      workspaceId: params.workspaceId,
      chatId: params.chatId ?? null,
      messageChars: params.message.length,
    })
  }

  let snapshotPromptPlan: SnapshotPromptPlan | null = null
  const vfsSnapshot = structuredContext.vfsSnapshot ?? params.workspaceSnapshot
  const inventoryMarkdownRaw = params.workspaceContext ?? structuredContext.inventoryMarkdown
  const inventoryMarkdown = inventoryMarkdownRaw
    ? rewriteSnapshotSkillsForLocalCopilot(inventoryMarkdownRaw)
    : inventoryMarkdownRaw
  if (vfsSnapshot && inventoryMarkdown && structuredContext.snapshotFreshness) {
    const priorMeta = chatConfig
      ? parseWorkspaceSnapshotMeta(chatConfig.workspaceSnapshotMeta)
      : null
    const priorFingerprints = chatConfig
      ? parseWorkspaceSnapshotFingerprints(chatConfig.workspaceSnapshotFingerprints)
      : null
    snapshotPromptPlan = resolveSnapshotPromptPlan({
      snapshot: vfsSnapshot,
      markdown: inventoryMarkdown,
      workspaceId: params.workspaceId,
      generatedAt: structuredContext.snapshotFreshness.generatedAt,
      contentRevision: structuredContext.snapshotFreshness.contentRevision,
      priorMeta,
      priorFingerprints,
    })
  }

  const inventoryMode = snapshotPromptPlan?.mode ?? 'full'
  const contextJson = contextToPromptJson(structuredContext, {
    workflowDetail,
    inventoryMode,
    ...(snapshotPromptPlan ? { snapshotRevision: snapshotPromptPlan.meta.contentRevision } : {}),
  })
  const userTurnText = getLocalCopilotUserTurnText(userTurn)

  const pinnedDirective =
    extractedDirectives.activeDirective?.trim() || sessionMemory?.activeDirective?.trim() || ''
  const pinnedConstraints = sessionMemory?.constraints?.length
    ? sessionMemory.constraints
    : extractedDirectives.constraints

  const snapshotSystemContent = snapshotPromptPlan
    ? withWorkspaceSnapshotPrefix(snapshotPromptPlan.content)
    : inventoryMarkdown
      ? `Workspace snapshot:\n${inventoryMarkdown}${
          structuredContext.snapshotFreshness
            ? `\n\n(snapshot generatedAt=${structuredContext.snapshotFreshness.generatedAt}; revision=${structuredContext.snapshotFreshness.contentRevision})`
            : ''
        }`
      : null

  const recentFailuresMessage = sessionMemory?.failures?.length
    ? formatRecentToolFailuresSystemMessage(sessionMemory.failures)
    : null

  const intent = classifyLocalCopilotIntent(params.message)
  // Full-catalog turns expose file tools every time; keep configured thinking
  // (do not regex-classify "file turns" to cap thinking).
  const turnThinkingLevel = config.thinkingLevel
  const specialistTools = getParentSpecialistToolDefinitions()
  const hybridTools = resolveHybridParentTools({
    allTools,
    intent,
    specialistTools,
  })
  const tools = hybridTools.tools
  const usedFullCatalog = hybridTools.usedFullCatalog
  const systemPrompt = buildLocalCopilotSystemPrompt({
    ...intent,
    useFullCatalog: usedFullCatalog,
  })

  const estimatedToolDefinitionTokens = estimateToolDefinitionTokens(tools, tokenCountModel)
  const maxOutputTokens = resolveLocalCopilotMaxOutputTokens(config.model)
  const promptBudget = resolveLocalCopilotPromptTokenBudget({
    model: config.model,
    provider: config.provider,
    toolDefinitionTokens: estimatedToolDefinitionTokens,
    maxOutputTokens,
  })

  const messages: ChatMessage[] = fitPromptWithSlots(
    [
      { role: 'system', content: systemPrompt.content },
      ...(relevantSkills.message ? [relevantSkills.message] : []),
      {
        role: 'system',
        content: `Current context:\n${contextJson}`,
      },
      ...(snapshotSystemContent
        ? [
            {
              role: 'system' as const,
              content: snapshotSystemContent,
            },
          ]
        : []),
      ...(taskState ? [formatTaskStateSystemMessage(taskState)] : []),
      ...(activeDocumentsState
        ? [formatActiveDocumentsSystemMessage(activeDocumentsState, activeEditTarget)]
        : activeEditTarget.preferredPath || activeEditTarget.candidates.length > 0
          ? [
              formatActiveDocumentsSystemMessage(
                {
                  documents: activeEditTarget.candidates.map((path) => ({
                    path,
                    role: 'upload' as const,
                    lastTouchedAt: new Date().toISOString(),
                  })),
                  preferredPath: activeEditTarget.preferredPath,
                },
                activeEditTarget
              ),
            ]
          : []),
      ...(sessionMemory ? [formatSessionMemorySystemMessage(sessionMemory)] : []),
      ...(recentFailuresMessage ? [recentFailuresMessage] : []),
      ...(chatUploadsInventory ? [{ role: 'system' as const, content: chatUploadsInventory }] : []),
      ...(pinnedConstraints.length > 0
        ? [formatSessionConstraintsSystemMessage(pinnedConstraints)]
        : []),
      ...(pinnedDirective ? [formatActiveDirectiveSystemMessage(pinnedDirective)] : []),
      ...historyMessages,
      userTurn,
    ],
    promptBudget.tokenBudget,
    tokenCountModel
  )

  const specialistBudget = createSpecialistBudget()
  timing.mark('promptReady')

  logger.info('Arena Copilot prompt budget applied', {
    workflowDetail,
    historyTurns: historyMessages.length,
    sessionMemoryPresent: Boolean(sessionMemory),
    contextEntries: params.contexts?.length ?? 0,
    fileAttachments: params.fileAttachments?.length ?? 0,
    estimatedPromptTokens: estimateChatMessagesTokens(messages, tokenCountModel),
    estimatedToolDefinitionTokens,
    promptTokenBudget: promptBudget.tokenBudget,
    modelContextWindow: promptBudget.contextWindow,
    reservedTokens: promptBudget.reservedTokens,
    promptBudgetSoftCapped: promptBudget.softCapped,
    tokenCountModel,
    toolDefinitionCount: tools.length,
    leafToolCount: hybridTools.leafToolCount,
    specialistEntryCount: hybridTools.specialistEntryCount,
    toolCatalogCount: allTools.length,
    microcompactClearedCount: historyMicrocompact.clearedCount,
    microcompactCharsFreed: historyMicrocompact.charsFreed,
    specialistPrimary: intent.primary,
    specialistSecondary: intent.secondary,
    useFullCatalog: usedFullCatalog,
    systemPromptChars: systemPrompt.content.length,
    systemPromptOmittedSections: systemPrompt.omittedSectionIds,
    partitioning: 'hybrid',
    skillToolEnabled: allTools.length > LOCAL_COPILOT_TOOLS.length,
    memory: getLocalCopilotMemorySnapshot(),
  })

  logger.info('Arena Copilot latency checkpoint', {
    phase: 'prompt_ready',
    usageTurnId,
    workspaceId: params.workspaceId,
    prepMs: timing.elapsed('promptReady'),
    contextBuildMs: timing.elapsed('contextReady'),
    sessionAndPrefetchMs: timing.since('contextReady', 'sessionPrefetchReady'),
    promptAssembleMs: timing.since('sessionPrefetchReady', 'promptReady'),
    hasCallerSnapshot: Boolean(workspaceSnapshotBundle),
    provider: config.provider,
    model: config.model,
    marks: timing.snapshot(),
  })

  // Gate spend only before model/tool cost — overlaps context + prefetch + prompt.
  const usageLimits = await spendCapPromise
  timing.mark('spendCapReady')
  logger.info('Arena Copilot latency checkpoint', {
    phase: 'spend_cap_ready',
    usageTurnId,
    workspaceId: params.workspaceId,
    prepMs: timing.elapsed('promptReady'),
    contextBuildMs: timing.elapsed('contextReady'),
    sessionAndPrefetchMs: timing.since('contextReady', 'sessionPrefetchReady'),
    promptAssembleMs: timing.since('sessionPrefetchReady', 'promptReady'),
    spendCapMs: timing.elapsed('spendCapReady'),
    spendCapWaitAfterPromptMs: timing.since('promptReady', 'spendCapReady'),
    hasCallerSnapshot: Boolean(workspaceSnapshotBundle),
    provider: config.provider,
    model: config.model,
    marks: timing.snapshot(),
  })
  const spendGate = assertSpendCapAllows({
    isExceeded: usageLimits.isExceeded,
    currentUsage: usageLimits.currentUsage,
    limit: usageLimits.limit,
    turnSoFar: 0,
    message: usageLimits.message,
  })
  if (!spendGate.ok) {
    await auditLocalOpsEvent({
      counter: LOCAL_OPS_COUNTERS.spendCapHit,
      userId: params.userId,
      workspaceId: params.workspaceId,
      workflowId: params.workflowId,
      chatId: params.chatId,
      runId: params.runId,
      metadata: {
        currentUsage: usageLimits.currentUsage,
        limit: usageLimits.limit,
      },
    })
    yield {
      type: 'error',
      message: spendGate.error ?? 'Usage limit exceeded',
    }
    return undefined
  }

  const provider = params.catalogId ? createLocalCopilotProvider(config) : getLocalCopilotProvider()
  const billingAttribution =
    params.billingAttribution ??
    (await resolveBillingAttribution({
      actorUserId: params.userId,
      workspaceId: params.workspaceId,
    }))
  if (
    billingAttribution.actorUserId !== params.userId ||
    billingAttribution.workspaceId !== params.workspaceId
  ) {
    throw new Error('Arena Copilot billing attribution does not match its actor and workspace')
  }
  let resolvedSecretTraceRegistry: ToolExecutionContext['resolvedSecretTraceRegistry']
  try {
    const { prepareCopilotEnvironmentContext } = await import(
      '@/lib/mothership/environment-context'
    )
    const environmentContext = await prepareCopilotEnvironmentContext(
      params.userId,
      params.workspaceId
    )
    resolvedSecretTraceRegistry = environmentContext.resolvedSecretTraceRegistry
  } catch (error) {
    logger.warn('Failed to build Arena Copilot model-egress secret catalog', {
      error: getErrorMessage(error),
      userId: params.userId,
      workspaceId: params.workspaceId,
    })
    const { createIncompleteResolvedSecretTraceRegistry } = await import(
      '@/executor/utils/resolved-secret-trace-registry'
    )
    resolvedSecretTraceRegistry = createIncompleteResolvedSecretTraceRegistry({
      userId: params.userId,
      workspaceId: params.workspaceId,
    })
  }

  const toolCtx: ToolExecutionContext = {
    userId: params.userId,
    workspaceId: params.workspaceId,
    workflowId: resolvedWorkflowId ?? params.workflowId,
    chatId: params.chatId,
    messageId: usageTurnId,
    abortSignal: params.signal,
    userPermission: params.userPermission,
    billingAttribution,
    structuredContext,
    selectedBlockId: params.selectedBlockId,
    lastUserMessage: userTurnText,
    mutationIdempotency: new Map(),
    listedIntegrationToolIds: new Set(),
    readVfsPaths: new Set(),
    failedPatchSearches: new Map(),
    livePatchExcerptTokens: new Map(),
    allowedWorkflowIds: new Set(),
    blocksMetadataByType: new Map(),
    artifactStore: createArtifactStore(),
    turnMutations: createTurnMutations(),
    resolvedSecretTraceRegistry,
    ...(relevantSkills.message ? { relevantSkillGuidance: relevantSkills.message.content } : {}),
  }

  if (resolvedWorkflowId) {
    const { loadWorkflowRevision } = await import('@/local-copilot/lib/writes/workflow-access')
    const loaded = await loadWorkflowRevision(resolvedWorkflowId, params.workspaceId)
    if (loaded) toolCtx.workflowRevision = loaded.revision
  }

  /** Loads the heavy tool executor graph on first tool call only. */
  let toolExecutorModule: typeof import('@/local-copilot/lib/tools/executor') | null = null
  async function getToolExecutor() {
    if (!toolExecutorModule) {
      const loadStartedAt = Date.now()
      logger.info('Arena Copilot lazy-loading tool executor', {
        workspaceId: params.workspaceId,
        memory: getLocalCopilotMemorySnapshot(),
      })
      toolExecutorModule = await import('@/local-copilot/lib/tools/executor')
      logger.info('Arena Copilot tool executor loaded', {
        workspaceId: params.workspaceId,
        durationMs: Date.now() - loadStartedAt,
        memory: getLocalCopilotMemorySnapshot(),
      })
    }
    return toolExecutorModule
  }

  let specialistHintInsertAt = 1 + (relevantSkills.message ? 1 : 0)
  if (!intent.useFullCatalog && intent.primary !== 'general') {
    messages.splice(specialistHintInsertAt, 0, {
      role: 'system',
      content: domainSystemHint(intent.primary),
    })
    specialistHintInsertAt += 1
  }

  const parallelDomains = selectParallelSubagentDomains(intent)
  if (parallelDomains.length >= 2) {
    const parallel = runParallelSubagents({
      domains: parallelDomains,
      userMessage: userTurnText,
      model: config.specialistModel,
      provider,
      allTools,
      toolCtx,
      signal: params.signal,
      userId: params.userId,
      workspaceId: params.workspaceId,
      ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      usageTurnId,
      turnCost,
      getToolExecutor,
      budget: specialistBudget,
    })

    let parallelNext = await parallel.next()
    while (!parallelNext.done) {
      yield parallelNext.value
      parallelNext = await parallel.next()
    }

    const { findings, results } = parallelNext.value
    if (findings.trim()) {
      const wroteFiles = results.some((result) =>
        (result.mutationOutcomes ?? []).some(
          (outcome) =>
            outcome.success &&
            (outcome.toolName === 'create_file' ||
              outcome.toolName === 'edit_content' ||
              outcome.toolName === 'workspace_file')
        )
      )
      const wroteWorkflows = results.some((result) =>
        (result.mutationOutcomes ?? []).some(
          (outcome) => outcome.success && outcome.toolName === 'create_workflow'
        )
      )
      const writeGuard = [
        wroteWorkflows ? 'Do NOT call create_workflow again unless a specialist failed.' : null,
        wroteFiles
          ? 'Do NOT call create_file again unless a specialist failed.'
          : 'Research/lookup findings above do not create workspace files — if the user still needs documents or a seeded knowledge base, call create_file (then knowledge_base add_file as needed).',
      ]
        .filter(Boolean)
        .join(' ')

      messages.splice(specialistHintInsertAt, 0, {
        role: 'system',
        content: `Parallel specialist findings. ${writeGuard} Synthesize the outcome for the user using the ids below:\n${findings}`,
      })
    }
    logger.info('Arena Copilot parallel subagents injected', {
      domains: parallelDomains,
      resultCount: results.length,
      findingsChars: findings.length,
      budget: specialistBudget.snapshot(),
      memory: getLocalCopilotMemorySnapshot(),
    })
  } else {
    const passDomain = specialistPassDomain(intent)
    if (passDomain && passDomain !== 'general') {
      const pass = runSpecialistPass({
        domain: passDomain,
        userMessage: userTurnText,
        model: config.specialistModel,
        provider,
        allTools,
        toolCtx,
        signal: params.signal,
        userId: params.userId,
        workspaceId: params.workspaceId,
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
        usageTurnId,
        turnCost,
        getToolExecutor,
        budget: specialistBudget,
        ...(params.runId ? { runId: params.runId } : {}),
        ...(passDomain === 'file' && turnThinkingLevel ? { thinkingLevel: turnThinkingLevel } : {}),
      })

      let passNext = await pass.next()
      while (!passNext.done) {
        yield passNext.value
        passNext = await pass.next()
      }

      const { findings, toolRoundCount } = passNext.value
      if (findings.trim()) {
        messages.splice(specialistHintInsertAt, 0, {
          role: 'system',
          content: `Specialist (${passDomain}) findings — use these; do not repeat the same research tools unless needed:\n${findings}`,
        })
      }
      logger.info('Arena Copilot specialist pass complete', {
        domain: passDomain,
        toolRoundCount,
        findingsChars: findings.length,
        budget: specialistBudget.snapshot(),
        memory: getLocalCopilotMemorySnapshot(),
      })
    }
  }

  let assistantText = ''
  let proposedPatch: WorkflowPatch | undefined
  let recommendations: string[] = []
  /** Last model-emitted follow-up titles (from stripped `<options>` tags). */
  let modelFollowUpTitles: string[] = []
  let blocksMetadataFetchedThisTurn = false
  let streamedCreateProgress = false
  let streamedEditProgress = false
  let workflowBuildCompleteNudgeSent = false
  /** Soft post-build nudge fired; tools stay until settle or hard lock. */
  let postBuildSoftNudgeSent = false
  /** Successful populate edits after create_workflow this turn. */
  let successfulPopulateEdits = 0
  /** Only gate tools after create→populate this turn — not after ordinary prompt edits. */
  let createdWorkflowThisTurn = false
  let postBuildToolMode: PostBuildToolMode = 'all'
  let endTurnAfterThisRound = false
  const pendingOAuthControls: OAuthConnectControl[] = []
  let pendingOAuthToolCallId: string | undefined
  /** Full user-visible prose streamed this turn (survives per-round assistantText resets). */
  let streamedUserFacingText = ''
  /**
   * Length of `streamedUserFacingText` when the latest workflow-run tool finished.
   * Used to detect the stuck "Let me run it." → Running workflow → no result case.
   */
  let streamedCharsAtLastRunTool: number | null = null
  let lastFinishReason: string | undefined
  const turnToolRecords: ToolTurnRecord[] = []
  const turnMutationOutcomes: MutationOutcome[] = []
  const turnVerifications: VerificationRecord[] = []
  const maxToolRounds = MAX_TOOL_ITERATIONS
  let pendingFollowUps: MandatoryFollowUp[] = []
  let forcedFollowUpRounds = 0
  let forcedIntentContinuations = 0
  let forcedDebugExplanations = 0
  let forcedWorkflowBuildContinuations = 0
  let forcedIncompletePopulateContinuations = 0
  let forcedFileEditContinuations = 0
  let forcedHtmlEditGrepNudges = 0
  let forcedHtmlEditWriteNudges = 0
  let forcedResearchSearchContinuations = 0
  /** Successful get_blocks_metadata calls after create and before the first populate edit. */
  let prePopulateDiscoveryCalls = 0
  let refundedPrePopulateDiscoveryRounds = 0
  let roundToolNames: string[] = []
  let roundHadRejectedDiscovery = false
  let turnHasLiveWebSearch = false
  let turnInputTokens = 0
  let turnOutputTokens = 0
  const stagnationTracker = createToolStagnationTracker()
  const fileExploreTracker = createFileExploreTracker()
  let stagnationStopMessage: string | null = null
  /**
   * Explore hard-stops must not wait on another model round — that await is
   * what left Chat blank when the provider hung after endless HTML paging.
   */
  let stagnationSkipModelRound = false

  const applyToolLoopGuards = (
    toolName: string,
    argsJson: string,
    success: boolean,
    result: unknown
  ): {
    stop: boolean
    skipModelRound: boolean
    systemMessage: string | null
    userMessage: string | null
  } => {
    const exploreHit = fileExploreTracker.record(toolName, argsJson, success)
    if (exploreHit) {
      return {
        stop: true,
        skipModelRound: true,
        systemMessage: buildFileExploreSystemMessage(exploreHit),
        userMessage: exploreHit.message,
      }
    }

    const stagnationHit = stagnationTracker.record(toolName, argsJson, success, result)
    if (!stagnationHit) {
      return { stop: false, skipModelRound: false, systemMessage: null, userMessage: null }
    }
    const action = resolveStagnationAction(
      stagnationHit,
      pendingFollowUps.map((item) => item.id)
    )
    return {
      stop: action.stop,
      skipModelRound: false,
      systemMessage: action.systemMessage,
      userMessage: action.stop ? stagnationHit.message : null,
    }
  }

  const needsLiveSearch = intent.primary === 'research' || intent.secondary.includes('research')

  const gatePrePopulateDiscovery = (toolName: string): ToolExecutionResult | null => {
    const decision = admitPrePopulateDiscovery({
      createdWorkflowThisTurn,
      successfulPopulateEdits,
      discoveryCallsSoFar: prePopulateDiscoveryCalls,
      toolName,
    })
    if (decision === 'allow' || decision === 'ignore') return null
    roundHadRejectedDiscovery = true
    const message = buildPrePopulateDiscoveryBlockedMessage()
    return {
      toolName,
      success: false,
      error: message,
      result: { success: false, error: message, message },
    }
  }

  /** Counts only successful get_blocks_metadata toward the pre-populate budget. */
  const recordSuccessfulBlocksMetadataFetch = () => {
    if (!createdWorkflowThisTurn || successfulPopulateEdits > 0) return
    prePopulateDiscoveryCalls += 1
  }

  // Overflow past maxToolRounds is reserved for write-critical follow-ups
  // (workspace_file → edit_content) so prepare-without-apply cannot stall on
  // the last normal round.
  const maxRoundExclusive = maxToolRounds + MAX_FORCED_FOLLOW_UP_ROUNDS
  for (let round = 0; round < maxRoundExclusive; round++) {
    if (stagnationStopMessage) break
    if (postBuildToolMode === 'done') break
    if (
      !canEnterToolRound({
        round,
        maxToolRounds,
        maxForcedFollowUpRounds: MAX_FORCED_FOLLOW_UP_ROUNDS,
        pendingFollowUps,
      })
    ) {
      break
    }

    roundToolNames = []
    roundHadRejectedDiscovery = false

    const midTurnSpend = assertSpendCapAllows({
      isExceeded: usageLimits.isExceeded,
      currentUsage: usageLimits.currentUsage,
      limit: usageLimits.limit,
      turnSoFar: turnCost.summarize().total,
      message: usageLimits.message,
    })
    if (!midTurnSpend.ok) {
      await auditLocalOpsEvent({
        counter: LOCAL_OPS_COUNTERS.spendCapHit,
        userId: params.userId,
        workspaceId: params.workspaceId,
        workflowId: params.workflowId,
        conversationId,
        chatId: params.chatId,
        runId: params.runId,
        metadata: { round, turnSoFar: turnCost.summarize().total },
      })
      yield {
        type: 'error',
        message: midTurnSpend.error ?? 'Usage limit exceeded',
      }
      break
    }

    const pendingToolCalls: Array<{
      id: string
      name: string
      arguments: string
      thoughtSignature?: string
    }> = []
    let roundInputTokens = 0
    let roundOutputTokens = 0
    let roundCacheReadTokens: number | undefined
    let roundCacheCreationTokens: number | undefined

    // Keep tools attached even for `final_only` — Bedrock rejects requests that
    // omit toolConfig once history already has toolUse/toolResult blocks.
    const roundTools = resolvePostBuildRoundTools(postBuildToolMode, tools)

    // Stream user-facing prose live for real replies. Hold bridging narration when
    // tools are available, and stop emitting once a tool_call arrives — otherwise
    // each tool batch opens a repeated "Arena Copilot >" mothership header.
    // `final_only` still attaches tools for Bedrock but expects a text reply.
    const contentBeforeRound = streamedUserFacingText
    const textStreamer = createAssistantRoundTextStreamer({
      toolsAvailable: roundTools.length > 0 && postBuildToolMode !== 'final_only',
      contentBeforeRound,
    })

    // Keep the trailing Thinking… pulse alive across tool → model gaps so the
    // UI never looks finished while the turn is still in flight.
    const proposePhase: LocalUxPhase = 'proposing'
    yield { type: 'ux_phase', phase: proposePhase }
    yield {
      type: 'status',
      message: round === 0 ? formatUxPhaseStatus(proposePhase) : 'Deciding next step…',
    }

    const modelRoundMark = `modelRound${round}Start`
    timing.mark(modelRoundMark)
    let firstModelOutputMs: number | null = null
    logger.info('Arena Copilot model round starting', {
      usageTurnId,
      workspaceId: params.workspaceId,
      round,
      provider: config.provider,
      model: config.model,
      elapsedMs: timing.elapsed(),
      prepMs: timing.elapsed('promptReady'),
      marks: timing.snapshot(),
    })

    const thinkingStatus = new ThinkingLiveStatusAccumulator()
    const thinkingBatcher = new ThinkingDeltaBatcher()
    const roundAnthropicThinkingBlocks: AnthropicThinkingHistoryBlock[] = []
    let roundGeminiModelParts: GeminiHistoryPart[] = []
    let roundReasoningContent = ''

    const flushThinkingBatch = function* (): Generator<
      { type: 'thinking_delta'; content: string },
      void,
      undefined
    > {
      const batched = thinkingBatcher.flush()
      if (batched) yield { type: 'thinking_delta', content: batched }
    }

    for await (const event of iterateWithIdleStatus({
      source: provider.chatCompletionStream({
        model: config.model,
        messages,
        tools: roundTools,
        maxTokens: maxOutputTokens,
        signal: params.signal,
        ...(turnThinkingLevel ? { thinkingLevel: turnThinkingLevel } : {}),
      }),
      abortSignal: params.signal,
      messages: MODEL_WAIT_STATUS_FALLBACK,
      idleMs: 2500,
      intervalMs: 2500,
    })) {
      if (event.type === 'status') {
        if (!thinkingStatus.isPublishing) yield event
        continue
      }

      const chunk = event.item
      if (chunk.type === 'thinking_block' && chunk.thinkingBlock) {
        roundAnthropicThinkingBlocks.push(chunk.thinkingBlock)
        // Claude-via-proxy (and some summarized Anthropic turns) only deliver
        // signed thinking_blocks — promote unread body into the thinking channel.
        if (chunk.thinkingBlock.type === 'thinking') {
          const suffix = unresolvedThinkingBlockText(
            roundReasoningContent,
            chunk.thinkingBlock.thinking
          )
          if (suffix) {
            roundReasoningContent += suffix
            const announceThinking = !thinkingStatus.isPublishing
            applyModelChunkToThinkingStatus(thinkingStatus, {
              type: 'thinking',
              content: suffix,
            })
            const batched = thinkingBatcher.push(suffix) ?? thinkingBatcher.flush()
            if (batched) yield { type: 'thinking_delta', content: batched }
            if (announceThinking) {
              yield { type: 'status', message: 'Thinking…' }
            }
          }
        }
        continue
      }
      if (chunk.type === 'gemini_model_parts' && chunk.geminiModelParts) {
        roundGeminiModelParts = chunk.geminiModelParts
        continue
      }
      if (chunk.type === 'thinking' && (chunk.content || chunk.thoughtSignature)) {
        if (chunk.content) {
          roundReasoningContent += chunk.content
          const announceThinking = !thinkingStatus.isPublishing
          applyModelChunkToThinkingStatus(thinkingStatus, chunk)
          // Thought signatures stay on `gemini_model_parts` / text trailers only.
          // Stamping them onto thinking UI blocks poisons history rebuild and
          // triggers Vertex 400 "Corrupted thought signature."
          const batched = thinkingBatcher.push(chunk.content)
          if (batched) yield { type: 'thinking_delta', content: batched }
          // Announce Thinking… once per model wait — not on every delta
          // (that flooded mothership logs / SSE at ~10Hz).
          if (announceThinking) {
            yield { type: 'status', message: 'Thinking…' }
          }
        }
        // Signature-only thought trailers are absorbed into gemini_model_parts;
        // nothing to show in Thinking chrome.
        continue
      }
      applyModelChunkToThinkingStatus(thinkingStatus, chunk)
      if (chunk.type === 'text' && (chunk.content || chunk.thoughtSignature)) {
        yield* flushThinkingBatch()
        if (!chunk.content) {
          if (chunk.thoughtSignature) {
            yield {
              type: 'text_delta',
              content: '',
              thoughtSignature: chunk.thoughtSignature,
            }
          }
          continue
        }
        const cleaned = stripLeakedToolMarkers(chunk.content, { trim: false })
        if (!cleaned) {
          if (chunk.thoughtSignature) {
            yield {
              type: 'text_delta',
              content: '',
              thoughtSignature: chunk.thoughtSignature,
            }
          }
          continue
        }
        const delta = textStreamer.pushText(cleaned)
        if (delta) {
          if (firstModelOutputMs === null) {
            firstModelOutputMs = timing.elapsed()
            timing.mark('firstModelOutput')
            logger.info('Arena Copilot latency checkpoint', {
              phase: 'ttft',
              usageTurnId,
              workspaceId: params.workspaceId,
              round,
              ttftMs: timing.since(modelRoundMark, 'firstModelOutput'),
              prepMs: timing.elapsed('promptReady'),
              provider: config.provider,
              model: config.model,
            })
          }
          streamedUserFacingText += delta
          yield {
            type: 'text_delta',
            content: delta,
            ...(chunk.thoughtSignature ? { thoughtSignature: chunk.thoughtSignature } : {}),
          }
        } else if (chunk.thoughtSignature) {
          yield {
            type: 'text_delta',
            content: '',
            thoughtSignature: chunk.thoughtSignature,
          }
        }
      }
      if (chunk.type === 'tool_call' && chunk.toolCall) {
        yield* flushThinkingBatch()
        if (firstModelOutputMs === null) {
          firstModelOutputMs = timing.elapsed()
          timing.mark('firstModelOutput')
          logger.info('Arena Copilot latency checkpoint', {
            phase: 'ttft',
            usageTurnId,
            workspaceId: params.workspaceId,
            round,
            ttftMs: timing.since(modelRoundMark, 'firstModelOutput'),
            prepMs: timing.elapsed('promptReady'),
            provider: config.provider,
            model: config.model,
            via: 'tool_call',
          })
        }
        textStreamer.markToolCall()
        pendingToolCalls.push(chunk.toolCall)
      }
      if (chunk.type === 'done') {
        yield* flushThinkingBatch()
        if (chunk.finishReason) lastFinishReason = chunk.finishReason
        if (chunk.usage) {
          roundInputTokens = chunk.usage.inputTokens
          roundOutputTokens = chunk.usage.outputTokens
          roundCacheReadTokens = chunk.usage.cacheReadTokens
          roundCacheCreationTokens = chunk.usage.cacheCreationTokens
        }
      }
    }

    yield* flushThinkingBatch()

    const roundRawText = textStreamer.roundRawText
    {
      const { display, remainder } = textStreamer.finalize()
      if (display) {
        // Always keep model-facing transcript text for the assistant tool message.
        assistantText += display
      }
      if (remainder) {
        streamedUserFacingText += remainder
        yield { type: 'text_delta', content: remainder }
      }
    }

    const roundFollowUps = extractOptionsTitles(roundRawText)
    if (roundFollowUps.length > 0) {
      modelFollowUpTitles = roundFollowUps
    }

    logger.info('Arena Copilot model round finished', {
      round,
      model: config.model,
      provider: config.provider,
      toolCallCount: pendingToolCalls.length,
      toolNames: pendingToolCalls.map((call) => call.name),
      assistantChars: assistantText.length,
      thinkingBlockCount: roundAnthropicThinkingBlocks.length,
      thinkingChars: roundAnthropicThinkingBlocks.reduce(
        (sum, block) => sum + (block.type === 'thinking' ? block.thinking.length : 0),
        0
      ),
      reasoningChars: roundReasoningContent.length,
      geminiModelPartCount: roundGeminiModelParts.length,
      geminiThoughtSignatures: roundGeminiModelParts.filter((part) =>
        Boolean(part.thoughtSignature)
      ).length,
      inputTokens: roundInputTokens,
      outputTokens: roundOutputTokens,
      cacheReadTokens: roundCacheReadTokens,
      cacheCreationTokens: roundCacheCreationTokens,
      roundDurationMs: timing.since(modelRoundMark),
      ttftMs: firstModelOutputMs === null ? null : timing.since(modelRoundMark, 'firstModelOutput'),
      memory: getLocalCopilotMemorySnapshot(),
    })

    if (roundGeminiModelParts.length > 0) {
      yield { type: 'gemini_model_parts', parts: roundGeminiModelParts }
    }

    turnInputTokens += roundInputTokens
    turnOutputTokens += roundOutputTokens

    if (roundInputTokens > 0 || roundOutputTokens > 0) {
      // Arena Copilot (local mothership) accumulates model cost for one end-of-turn
      // ledger write. Sim Cloud mothership uses Go pricing + `workspace-chat` /
      // `mothership_block` via `/api/billing/update-cost` — keep these separate.
      turnCost.addModelUsage({
        model: config.model,
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cacheReadTokens: roundCacheReadTokens,
        provider: config.provider,
      })
    }

    if (pendingToolCalls.length === 0) {
      const shouldForceOauthFollowUp =
        postBuildToolMode === 'oauth_only' && pendingFollowUpsAreOauthOnly(pendingFollowUps)
      const canForceFollowUp = canForceMandatoryFollowUp({
        round,
        maxToolRounds,
        maxForcedFollowUpRounds: MAX_FORCED_FOLLOW_UP_ROUNDS,
        forcedFollowUpRounds,
        pendingFollowUps,
        postBuildAllows: postBuildToolMode === 'all' || shouldForceOauthFollowUp,
      })

      if (canForceFollowUp) {
        forcedFollowUpRounds += 1
        // Record the already-streamed pitch so the next round does not regenerate
        // the same "workflow is fully built + Connect Gmail" paragraph.
        const settledFollowUp =
          stripIdsFromUserFacingText(stripOptionsTagsForDisplay(roundRawText, false)) ||
          roundRawText
        if (settledFollowUp.trim()) {
          messages.push({ role: 'assistant', content: settledFollowUp })
          assistantText = ''
        }
        const continuation = buildFollowUpContinuationMessage(pendingFollowUps)
        messages.push({ role: 'user', content: continuation })
        logger.info('Arena Copilot forcing mandatory follow-up continuation', {
          round,
          forcedFollowUpRounds,
          pendingFollowUpIds: pendingFollowUps.map((item) => item.id),
          postBuildToolMode,
          overflowRound: round >= maxToolRounds,
        })
        continue
      }

      const intentDisplay =
        stripIdsFromUserFacingText(stripOptionsTagsForDisplay(roundRawText, false)) || roundRawText
      const canForceIntentContinuation =
        postBuildToolMode === 'all' &&
        forcedIntentContinuations < MAX_INTENT_CONTINUATION_ROUNDS &&
        round < maxToolRounds - 1 &&
        isUnfulfilledMutationIntentNarration(intentDisplay)

      if (canForceIntentContinuation) {
        forcedIntentContinuations += 1
        if (intentDisplay.trim()) {
          messages.push({ role: 'assistant', content: intentDisplay })
          assistantText = ''
        }
        messages.push({
          role: 'system',
          content: buildUnfulfilledIntentContinuationMessage(),
        })
        logger.info('Arena Copilot forcing mutation-intent continuation', {
          round,
          forcedIntentContinuations,
          preview: truncate(intentDisplay, 120),
        })
        continue
      }

      const canForceResearchSearch = shouldForceResearchSearchContinuation({
        postBuildToolMode,
        needsLiveSearch,
        forcedResearchSearchContinuations,
        maxForcedResearchSearchContinuations: MAX_RESEARCH_SEARCH_CONTINUATION_ROUNDS,
        round,
        maxToolRounds,
        hasLiveWebSearch: turnHasLiveWebSearch,
      })

      if (canForceResearchSearch) {
        forcedResearchSearchContinuations += 1
        if (intentDisplay.trim()) {
          messages.push({ role: 'assistant', content: intentDisplay })
          assistantText = ''
        }
        messages.push({
          role: 'system',
          content: buildResearchSearchContinuationMessage(),
        })
        logger.info('Arena Copilot forcing research live-search continuation', {
          round,
          forcedResearchSearchContinuations,
          intentPrimary: intent.primary,
          preview: truncate(intentDisplay, 120),
        })
        continue
      }

      const canForceDebugExplanation = shouldForceDebugExplanationContinuation({
        postBuildToolMode,
        forcedDebugExplanations,
        maxForcedDebugExplanations: MAX_DEBUG_EXPLANATION_CONTINUATION_ROUNDS,
        round,
        maxToolRounds,
        hasDebugTools: turnHasDebugInspectionTools(turnToolRecords),
        streamedUserFacingText,
        roundDisplayText: intentDisplay,
      })

      if (canForceDebugExplanation) {
        forcedDebugExplanations += 1
        if (intentDisplay.trim()) {
          messages.push({ role: 'assistant', content: intentDisplay })
          assistantText = ''
        }
        messages.push({
          role: 'system',
          content: buildDebugExplanationContinuationMessage(),
        })
        logger.info('Arena Copilot forcing debug-explanation continuation', {
          round,
          forcedDebugExplanations,
          debugTools: turnToolRecords
            .filter((record) =>
              ['query_logs', 'get_execution_logs', 'explain_error'].includes(record.name)
            )
            .map((record) => record.name),
        })
        continue
      }

      const canForceWorkflowBuild = shouldForceWorkflowBuildContinuation({
        postBuildToolMode,
        forcedWorkflowBuildContinuations,
        maxForcedWorkflowBuildContinuations: MAX_WORKFLOW_BUILD_CONTINUATION_ROUNDS,
        round,
        maxToolRounds,
        hasDiscoveryTools: turnHasWorkflowDiscoveryTools(turnToolRecords),
        hasMutationTools: turnHasWorkflowMutationTools(turnToolRecords),
        streamedUserFacingText,
        roundDisplayText: intentDisplay,
      })

      if (canForceWorkflowBuild) {
        forcedWorkflowBuildContinuations += 1
        if (intentDisplay.trim()) {
          messages.push({ role: 'assistant', content: intentDisplay })
          assistantText = ''
        }
        messages.push({
          role: 'system',
          content: buildWorkflowBuildContinuationMessage(),
        })
        logger.info('Arena Copilot forcing workflow-build continuation', {
          round,
          forcedWorkflowBuildContinuations,
          discoveryTools: turnToolRecords
            .filter((record) =>
              ['get_available_blocks', 'get_blocks_metadata'].includes(record.name)
            )
            .map((record) => record.name),
        })
        continue
      }

      const canForceIncompletePopulate = shouldForceIncompleteWorkflowPopulateContinuation({
        postBuildToolMode,
        createdWorkflowThisTurn,
        successfulPopulateEdits,
        pendingFollowUpCount: pendingFollowUps.length,
        forcedIncompletePopulateContinuations,
        maxForcedIncompletePopulateContinuations:
          MAX_INCOMPLETE_WORKFLOW_POPULATE_CONTINUATION_ROUNDS,
        round,
        maxToolRounds,
      })

      if (canForceIncompletePopulate) {
        forcedIncompletePopulateContinuations += 1
        if (intentDisplay.trim()) {
          messages.push({ role: 'assistant', content: intentDisplay })
          assistantText = ''
        }
        messages.push({
          role: 'system',
          content: buildIncompleteWorkflowPopulateContinuationMessage(),
        })
        logger.info('Arena Copilot forcing incomplete-workflow-populate continuation', {
          round,
          forcedIncompletePopulateContinuations,
          createdWorkflowThisTurn,
          successfulPopulateEdits,
        })
        continue
      }

      const hasSuccessfulRead = turnToolRecords.some(
        (record) => record.name === 'read' && record.success
      )
      const hasSuccessfulGrep = turnToolRecords.some(
        (record) => record.name === 'grep' && record.success
      )
      const htmlEditContext = hasHtmlEditContext({
        userMessage: userTurnText,
        preferredPath: activeEditTarget.preferredPath,
        candidatePaths: activeEditTarget.candidates,
      })
      const fileInspectionCount = countSuccessfulFileInspections(turnToolRecords)
      const hasFileMutations = turnHasFileMutationTools(turnToolRecords)
      const htmlEditGrepTokens = extractHtmlEditGrepTokens(userTurnText)

      const canForceHtmlEditGrep = shouldForceHtmlEditGrepNudge({
        postBuildToolMode,
        forcedHtmlEditGrepNudges,
        maxForcedHtmlEditGrepNudges: MAX_HTML_EDIT_GREP_NUDGE_ROUNDS,
        round,
        maxToolRounds,
        userMessage: userTurnText,
        hasHtmlContext: htmlEditContext,
        hasSuccessfulRead,
        hasSuccessfulGrep,
        hasFileMutationTools: hasFileMutations,
        streamedUserFacingText,
        roundDisplayText: intentDisplay,
      })

      if (canForceHtmlEditGrep) {
        forcedHtmlEditGrepNudges += 1
        if (intentDisplay.trim()) {
          messages.push({ role: 'assistant', content: intentDisplay })
          assistantText = ''
        }
        messages.push({
          role: 'system',
          content: buildHtmlEditGrepNudgeMessage(htmlEditGrepTokens),
        })
        logger.info('Arena Copilot forcing HTML edit grep nudge', {
          round,
          forcedHtmlEditGrepNudges,
          grepTokens: htmlEditGrepTokens,
          preferredPath: activeEditTarget.preferredPath,
        })
        continue
      }

      const canForceHtmlEditWrite = shouldForceHtmlEditWriteNudge({
        postBuildToolMode,
        forcedHtmlEditWriteNudges,
        maxForcedHtmlEditWriteNudges: MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
        inspectionsBeforeWriteNudge: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
        inspectionCount: fileInspectionCount,
        round,
        maxToolRounds,
        userMessage: userTurnText,
        hasHtmlContext: htmlEditContext,
        hasFileMutationTools: hasFileMutations,
        streamedUserFacingText,
        roundDisplayText: intentDisplay,
      })

      if (canForceHtmlEditWrite) {
        forcedHtmlEditWriteNudges += 1
        if (intentDisplay.trim()) {
          messages.push({ role: 'assistant', content: intentDisplay })
          assistantText = ''
        }
        messages.push({
          role: 'system',
          content: buildHtmlEditWriteNudgeMessage({
            tokens: htmlEditGrepTokens,
            preferredPath: activeEditTarget.preferredPath,
            attempt: forcedHtmlEditWriteNudges,
            maxAttempts: MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
          }),
        })
        logger.info('Arena Copilot forcing HTML edit write nudge', {
          round,
          forcedHtmlEditWriteNudges,
          fileInspectionCount,
          grepTokens: htmlEditGrepTokens,
          preferredPath: activeEditTarget.preferredPath,
        })
        continue
      }

      if (
        shouldStopHtmlEditWithoutWrite({
          forcedHtmlEditWriteNudges,
          maxForcedHtmlEditWriteNudges: MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
          inspectionsBeforeWriteNudge: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
          inspectionCount: fileInspectionCount,
          userMessage: userTurnText,
          hasHtmlContext: htmlEditContext,
          hasFileMutationTools: hasFileMutations,
        })
      ) {
        stagnationStopMessage = buildHtmlEditWriteGiveUpMessage({
          tokens: htmlEditGrepTokens,
          preferredPath: activeEditTarget.preferredPath,
          userMessage: userTurnText,
        })
        logger.info('Arena Copilot stopping HTML edit without write after write nudges', {
          round,
          forcedHtmlEditWriteNudges,
          fileInspectionCount,
          preferredPath: activeEditTarget.preferredPath,
        })
        break
      }

      const canForceFileEdit = shouldForceFileEditContinuation({
        postBuildToolMode,
        forcedFileEditContinuations,
        maxForcedFileEditContinuations: MAX_FILE_EDIT_CONTINUATION_ROUNDS,
        round,
        maxToolRounds,
        hasFileInspectionTools: turnHasFileInspectionTools(turnToolRecords),
        hasFileMutationTools: hasFileMutations,
        streamedUserFacingText,
        roundDisplayText: intentDisplay,
      })

      if (canForceFileEdit) {
        forcedFileEditContinuations += 1
        if (intentDisplay.trim()) {
          messages.push({ role: 'assistant', content: intentDisplay })
          assistantText = ''
        }
        messages.push({
          role: 'system',
          content: buildFileEditContinuationMessage(),
        })
        logger.info('Arena Copilot forcing file-edit continuation', {
          round,
          forcedFileEditContinuations,
          inspectionTools: turnToolRecords
            .filter((record) =>
              ['read', 'grep', 'glob', 'load_copilot_artifact'].includes(record.name)
            )
            .map((record) => record.name),
        })
        continue
      }

      if (postBuildToolMode === 'final_only' || postBuildToolMode === 'oauth_only') {
        // Text-only (or oauth-only with no call) — finish the turn.
        postBuildToolMode = 'done'
      } else if (postBuildSoftNudgeSent && postBuildToolMode === 'all') {
        // Soft nudge already asked the model to wrap up; it settled with no tools.
        postBuildToolMode = 'done'
      }

      if (pendingFollowUps.length > 0) {
        logger.warn('Arena Copilot ended with unresolved mandatory follow-ups', {
          round,
          pendingFollowUpIds: pendingFollowUps.map((item) => item.id),
        })
      }
      break
    }

    // Post-build text round still attaches tools for Bedrock; discard any calls.
    if (postBuildToolMode === 'final_only') {
      logger.info('Arena Copilot discarding post-build tool calls', {
        round,
        toolNames: pendingToolCalls.map((call) => call.name),
      })
      postBuildToolMode = 'done'
      break
    }

    const orderedToolCalls = sortToolCallsForExecution(
      postBuildToolMode === 'oauth_only'
        ? pendingToolCalls.filter((call) => call.name === 'oauth_get_auth_link')
        : pendingToolCalls
    )
    if (orderedToolCalls.some((call) => isLiveWebSearchToolCall(call.name, call.arguments))) {
      turnHasLiveWebSearch = true
    }
    if (orderedToolCalls.length === 0) {
      postBuildToolMode = postBuildToolMode === 'all' ? 'all' : 'done'
      break
    }

    messages.push({
      role: 'assistant',
      content: assistantText,
      toolCalls: orderedToolCalls,
      ...(roundAnthropicThinkingBlocks.length > 0
        ? { anthropicThinkingBlocks: roundAnthropicThinkingBlocks }
        : {}),
      ...(roundGeminiModelParts.length > 0 ? { geminiModelParts: roundGeminiModelParts } : {}),
      ...(roundReasoningContent.trim() ? { reasoningContent: roundReasoningContent } : {}),
    })
    assistantText = ''
    const deferredSystemMessages: Array<{ role: 'system'; content: string }> = []
    const completedToolCallIds = new Set<string>()

    const specialistCalls = orderedToolCalls.filter((call) => isSpecialistTool(call.name))
    const specialistOutcomes = new Map<
      string,
      { success: boolean; findings: string; error?: string; output: unknown }
    >()

    if (specialistCalls.length > 0) {
      const specialistRunner = runParentSpecialistToolCalls({
        calls: specialistCalls,
        lastUserMessage: userTurnText,
        model: config.specialistModel,
        provider,
        allTools,
        toolCtx,
        signal: params.signal,
        userId: params.userId,
        workspaceId: params.workspaceId,
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
        usageTurnId,
        getToolExecutor,
        budget: specialistBudget,
        parentDepth: 0,
        turnCost,
        ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
      })

      let specialistNext = await specialistRunner.next()
      while (!specialistNext.done) {
        yield specialistNext.value
        specialistNext = await specialistRunner.next()
      }

      for (const outcome of specialistNext.value) {
        specialistOutcomes.set(outcome.toolCallId, {
          success: outcome.success,
          findings: outcome.findings,
          ...(outcome.error ? { error: outcome.error } : {}),
          output: {
            success: outcome.success,
            message: outcome.findings,
            domain: outcome.toolName,
            ...(outcome.result?.structured ? { structured: outcome.result.structured } : {}),
            ...(outcome.result?.verifications?.length
              ? { verifications: outcome.result.verifications }
              : {}),
          },
        })
        if (outcome.result?.verifications?.length) {
          turnVerifications.push(...outcome.result.verifications)
        }
        if (outcome.result?.mutationOutcomes?.length) {
          turnMutationOutcomes.push(...outcome.result.mutationOutcomes)
        }
      }
    }

    for (let callIndex = 0; callIndex < orderedToolCalls.length; callIndex++) {
      const call = orderedToolCalls[callIndex]
      roundToolNames.push(call.name)
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(call.arguments || '{}') as Record<string, unknown>
      } catch {
        parsedArgs = {}
      }

      if (isSpecialistTool(call.name)) {
        const outcome = specialistOutcomes.get(call.id) ?? {
          success: false,
          findings: `Specialist (${call.name}) produced no result`,
          error: `Specialist (${call.name}) produced no result`,
          output: {
            success: false,
            message: `Specialist (${call.name}) produced no result`,
          },
        }

        turnToolRecords.push({
          name: call.name,
          success: outcome.success,
          result: outcome.output,
          ...(outcome.error ? { error: outcome.error } : {}),
        })
        if (isWorkflowRunToolName(call.name)) {
          streamedCharsAtLastRunTool = streamedUserFacingText.length
        }

        if (persistLocally && conversationId) {
          const sanitized = sanitizeToolIoForPersistence({
            arguments: parsedArgs,
            result: outcome.output,
          })
          await recordToolCall({
            conversationId,
            toolCallId: call.id,
            toolName: call.name,
            arguments: sanitized.arguments,
            result: sanitized.result,
          })
        }

        await logCopilotAction({
          userId: params.userId,
          workspaceId: params.workspaceId,
          workflowId: params.workflowId,
          conversationId,
          action: 'specialist_delegation',
          summary: call.name,
          status: outcome.success ? 'success' : 'failure',
          metadata: {
            chatId: params.chatId,
            runId: params.runId,
            backend: 'local',
            toolCallId: call.id,
            domain: call.name,
          },
        }).catch(() => undefined)

        const formattedToolResult = formatToolResultForLlm(call.name, outcome.output, {
          artifactStore: toolCtx.artifactStore,
        })
        const outcomeFollowUps =
          'result' in outcome &&
          outcome.result &&
          typeof outcome.result === 'object' &&
          'pendingFollowUps' in outcome.result &&
          Array.isArray(outcome.result.pendingFollowUps)
            ? outcome.result.pendingFollowUps
            : []
        for (const followUp of outcomeFollowUps) {
          pendingFollowUps = [
            ...pendingFollowUps.filter((item) => item.id !== followUp.id),
            followUp,
          ]
        }
        pendingFollowUps = resolveMandatoryFollowUps(
          pendingFollowUps,
          call.name,
          outcome.success,
          outcome.output
        )

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: formattedToolResult,
        })
        completedToolCallIds.add(call.id)

        if (outcome.success && call.name === 'workflow' && !streamedCreateProgress) {
          const progress = synthesizeAssistantSummaryFromTools([
            { name: call.name, success: true, result: outcome.output },
          ])
          if (progress?.trim()) {
            streamedCreateProgress = true
            const safe = stripIdsFromUserFacingText(progress)
            const chunk = assistantText ? `\n\n${safe}` : safe
            assistantText += chunk
            streamedUserFacingText += chunk
            yield { type: 'text_delta', content: chunk }
          }
        }

        const loopGuard = applyToolLoopGuards(
          call.name,
          call.arguments || '{}',
          outcome.success,
          outcome.output
        )
        if (loopGuard.systemMessage) {
          deferredSystemMessages.push({
            role: 'system',
            content: loopGuard.systemMessage,
          })
        }
        if (loopGuard.stop && loopGuard.userMessage) {
          stagnationStopMessage = loopGuard.userMessage
          stagnationSkipModelRound = loopGuard.skipModelRound
          logger.warn('Arena Copilot tool loop hard-stop', {
            toolName: call.name,
            skipModelRound: loopGuard.skipModelRound,
          })
          break
        }
        if (loopGuard.systemMessage && !loopGuard.stop) {
          logger.warn('Arena Copilot tool stagnation soft-nudge (pending follow-ups)', {
            toolName: call.name,
            pendingFollowUpIds: pendingFollowUps.map((item) => item.id),
          })
        }
        continue
      }

      // Consecutive read-only tools can run concurrently; writers stay serial.
      if (isParallelReadTool(call.name)) {
        const parallelCalls = [call]
        while (
          callIndex + parallelCalls.length < orderedToolCalls.length &&
          parallelCalls.length < MAX_PARALLEL_READ_TOOLS
        ) {
          const next = orderedToolCalls[callIndex + parallelCalls.length]
          if (isSpecialistTool(next.name) || !isParallelReadTool(next.name)) break
          parallelCalls.push(next)
        }

        if (parallelCalls.length >= 2) {
          const { executeLocalCopilotTool } = await getToolExecutor()
          const prepared = parallelCalls.map((parallelCall) => {
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(parallelCall.arguments || '{}') as Record<string, unknown>
            } catch {
              args = {}
            }
            return { call: parallelCall, parsedArgs: args }
          })

          for (const item of prepared) {
            yield {
              type: 'tool_call_start',
              toolCallId: item.call.id,
              toolName: item.call.name,
              args: item.parsedArgs,
              ...(item.call.thoughtSignature
                ? { thoughtSignature: item.call.thoughtSignature }
                : {}),
            }
          }

          yield { type: 'ux_phase', phase: 'executing' }
          yield {
            type: 'status',
            message: `Running ${prepared.length} tools in parallel…`,
          }

          const parallelStartedAt = Date.now()
          logger.info('Arena Copilot parallel read tools starting', {
            toolNames: prepared.map((item) => item.call.name),
            count: prepared.length,
            memory: getLocalCopilotMemorySnapshot(),
          })

          for (const extra of parallelCalls.slice(1)) roundToolNames.push(extra.name)

          const executable: typeof prepared = []
          const rejectedDiscovery: Array<{
            call: (typeof prepared)[number]['call']
            parsedArgs: Record<string, unknown>
            toolResult: ToolExecutionResult
            toolStartedAt: number
          }> = []
          for (const item of prepared) {
            const blocked = gatePrePopulateDiscovery(item.call.name)
            if (blocked) {
              rejectedDiscovery.push({
                call: item.call,
                parsedArgs: item.parsedArgs,
                toolResult: blocked,
                toolStartedAt: Date.now(),
              })
            } else {
              executable.push(item)
            }
          }

          const executed = executable.length
            ? await Promise.all(
                executable.map(async (item) => {
                  const toolStartedAt = Date.now()
                  try {
                    const toolResult = await executeLocalCopilotTool(
                      item.call.name,
                      item.parsedArgs,
                      {
                        ...toolCtx,
                        activeToolCallId: item.call.id,
                      }
                    )
                    return { ...item, toolResult, toolStartedAt }
                  } catch (error) {
                    const message = getErrorMessage(error, 'Tool execution failed')
                    return {
                      ...item,
                      toolResult: {
                        toolName: item.call.name,
                        success: false as const,
                        result: { success: false, message },
                        error: message,
                      },
                      toolStartedAt,
                    }
                  }
                })
              )
            : []
          const parallelResults = [...rejectedDiscovery, ...executed]

          logger.info('Arena Copilot parallel read tools finished', {
            count: parallelResults.length,
            durationMs: Date.now() - parallelStartedAt,
            successes: parallelResults.filter((item) => item.toolResult.success).length,
          })

          let stopAfterParallel = false
          for (const item of parallelResults) {
            const { call: parallelCall, parsedArgs: parallelArgs, toolResult, toolStartedAt } = item

            logger.info('Arena Copilot tool finished', {
              toolName: parallelCall.name,
              toolCallId: parallelCall.id,
              success: toolResult.success,
              error: toolResult.error ?? null,
              durationMs: Date.now() - toolStartedAt,
              parallel: true,
              memory: getLocalCopilotMemorySnapshot(),
            })

            yield {
              type: 'tool_call_result',
              toolCallId: parallelCall.id,
              toolName: parallelCall.name,
              success: toolResult.success,
              output: toolResult.result,
              ...(toolResult.error ? { error: toolResult.error } : {}),
              ...(toolResult.resources?.length ? { resources: toolResult.resources } : {}),
            }

            turnToolRecords.push({
              name: parallelCall.name,
              success: toolResult.success,
              result: toolResult.result,
              ...(toolResult.error ? { error: toolResult.error } : {}),
            })

            turnCost.addToolBilling({
              toolName: parallelCall.name,
              billing: toolResult.billing,
            })

            if (persistLocally && conversationId) {
              const sanitized = sanitizeToolIoForPersistence({
                arguments: parallelArgs,
                result: toolResult.result,
              })
              await recordToolCall({
                conversationId,
                toolCallId: parallelCall.id,
                toolName: parallelCall.name,
                arguments: sanitized.arguments,
                result: sanitized.result,
              })
            }

            await logCopilotAction({
              userId: params.userId,
              workspaceId: params.workspaceId,
              workflowId: params.workflowId,
              conversationId,
              action: 'tool_call',
              summary: parallelCall.name,
              status: toolResult.success ? 'success' : 'failure',
              metadata: {
                chatId: params.chatId,
                runId: params.runId,
                backend: 'local',
                toolCallId: parallelCall.id,
                toolName: parallelCall.name,
                parallel: true,
                ...sanitizeToolIoForPersistence({
                  arguments: parallelArgs,
                  result:
                    toolResult.result && typeof toolResult.result === 'object'
                      ? {
                          success: toolResult.success,
                          error: toolResult.error,
                        }
                      : { success: toolResult.success },
                }),
              },
            }).catch(() => undefined)

            const formattedToolResult = formatToolResultForLlm(
              parallelCall.name,
              coalesceToolExecutionPayloadForLlm({
                success: toolResult.success,
                result: toolResult.result,
                error: toolResult.error,
                toolName: parallelCall.name,
              }),
              {
                artifactStore: toolCtx.artifactStore,
              }
            )
            pendingFollowUps = resolveMandatoryFollowUps(
              pendingFollowUps,
              parallelCall.name,
              toolResult.success,
              toolResult.result
            )

            messages.push({
              role: 'tool',
              toolCallId: parallelCall.id,
              content: formattedToolResult,
            })
            completedToolCallIds.add(parallelCall.id)

            if (parallelCall.name === 'get_blocks_metadata' && toolResult.success) {
              recordSuccessfulBlocksMetadataFetch()
              if (blocksMetadataFetchedThisTurn) {
                deferredSystemMessages.push({
                  role: 'system',
                  content: buildBlocksMetadataReuseSystemMessage(),
                })
              }
              blocksMetadataFetchedThisTurn = true
            }

            const loopGuard = applyToolLoopGuards(
              parallelCall.name,
              parallelCall.arguments || '{}',
              toolResult.success,
              toolResult.result
            )
            if (loopGuard.systemMessage) {
              deferredSystemMessages.push({
                role: 'system',
                content: loopGuard.systemMessage,
              })
            }
            if (loopGuard.stop && loopGuard.userMessage) {
              stagnationStopMessage = loopGuard.userMessage
              stagnationSkipModelRound = loopGuard.skipModelRound
              logger.warn('Arena Copilot tool loop hard-stop', {
                toolName: parallelCall.name,
                skipModelRound: loopGuard.skipModelRound,
                parallel: true,
              })
              stopAfterParallel = true
              break
            }
            if (loopGuard.systemMessage && !loopGuard.stop) {
              logger.warn('Arena Copilot tool stagnation soft-nudge (pending follow-ups)', {
                toolName: parallelCall.name,
                pendingFollowUpIds: pendingFollowUps.map((followUp) => followUp.id),
              })
            }
          }

          callIndex += parallelCalls.length - 1
          if (stopAfterParallel) break
          continue
        }
      }

      yield {
        type: 'tool_call_start',
        toolCallId: call.id,
        toolName: call.name,
        args: parsedArgs,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
      }

      const { executeLocalCopilotTool, refreshToolContext } = await getToolExecutor()
      const confirmationRequirement = classifyLocalToolConfirmation(call.name, parsedArgs)
      let toolResult: ToolExecutionResult | undefined =
        gatePrePopulateDiscovery(call.name) ?? undefined
      if (!toolResult && confirmationRequirement) {
        const confirmationReady = await prepareLocalToolConfirmation({
          runId: params.runId,
          toolCallId: call.id,
          toolName: call.name,
          args: parsedArgs,
          abortSignal: params.signal,
        })
        if (confirmationReady) {
          yield { type: 'ux_phase', phase: 'waiting_approval' }
          yield {
            type: 'status',
            message: formatUxPhaseStatus('waiting_approval'),
          }
          yield {
            type: 'confirmation_required',
            toolCallId: call.id,
            toolName: call.name,
            requirement: confirmationRequirement,
          }
        }
        const confirmationDecision = confirmationReady
          ? await waitForLocalToolConfirmation({
              toolCallId: call.id,
              abortSignal: params.signal,
            })
          : 'unavailable'
        if (confirmationDecision !== 'approved') {
          const message =
            confirmationDecision === 'rejected'
              ? 'The user rejected this action.'
              : `The action was not executed because confirmation was ${confirmationDecision}.`
          toolResult = {
            toolName: call.name,
            success: false,
            result: {
              success: false,
              confirmationRequired: true,
              confirmationDecision,
              message,
            },
            error: message,
          }
          await logCopilotAction({
            userId: params.userId,
            workspaceId: params.workspaceId,
            workflowId: params.workflowId,
            conversationId,
            action: 'tool_confirmation',
            summary: `${call.name}:${confirmationDecision}`,
            status: confirmationDecision === 'rejected' ? 'rejected' : 'failure',
            metadata: {
              chatId: params.chatId,
              runId: params.runId,
              backend: 'local',
              toolCallId: call.id,
              toolName: call.name,
              confirmationDecision,
              category: confirmationRequirement.category,
            },
          }).catch(() => undefined)
        } else {
          await logCopilotAction({
            userId: params.userId,
            workspaceId: params.workspaceId,
            workflowId: params.workflowId,
            conversationId,
            action: 'tool_confirmation',
            summary: `${call.name}:approved`,
            status: 'success',
            metadata: {
              chatId: params.chatId,
              runId: params.runId,
              backend: 'local',
              toolCallId: call.id,
              toolName: call.name,
              confirmationDecision: 'approved',
              category: confirmationRequirement.category,
            },
          }).catch(() => undefined)
        }
      }

      const toolStartedAt = Date.now()
      logger.info('Arena Copilot tool starting', {
        toolName: call.name,
        toolCallId: call.id,
        workflowId: toolCtx.workflowId ?? null,
        memory: getLocalCopilotMemorySnapshot(),
      })
      if (!toolResult) {
        yield { type: 'ux_phase', phase: 'executing' }
        yield { type: 'status', message: formatUxPhaseStatus('executing') }
        toolCtx.fileIntentChannelId = bindLocalFileIntentChannel(
          call.name,
          call.id,
          toolCtx.fileIntentChannelId
        )
        const toolStatus = runToolWithStatus({
          toolCallId: call.id,
          toolName: call.name,
          args: parsedArgs,
          abortSignal: params.signal,
          execute: (onProgress) =>
            executeLocalCopilotTool(call.name, parsedArgs, {
              ...toolCtx,
              onProgress,
              activeToolCallId: call.id,
            }),
        })
        let result = await toolStatus.next()
        while (!result.done) {
          yield result.value
          result = await toolStatus.next()
        }
        toolResult = result.value
      }
      toolCtx.fileIntentChannelId = clearLocalFileIntentChannel(
        call.name,
        toolCtx.fileIntentChannelId
      )
      logger.info('Arena Copilot tool finished', {
        toolName: call.name,
        toolCallId: call.id,
        success: toolResult.success,
        error: toolResult.error ?? null,
        durationMs: Date.now() - toolStartedAt,
        memory: getLocalCopilotMemorySnapshot(),
      })

      if (toolResult.createdWorkflowId) {
        toolCtx.workflowId = toolResult.createdWorkflowId
      } else if (call.name === 'edit_workflow' && toolResult.success) {
        const output =
          toolResult.result && typeof toolResult.result === 'object'
            ? (toolResult.result as Record<string, unknown>)
            : {}
        const resolvedWorkflowId =
          (typeof output.workflowId === 'string' && output.workflowId.trim()) ||
          (typeof parsedArgs.workflowId === 'string' && parsedArgs.workflowId.trim()) ||
          toolCtx.workflowId
        if (resolvedWorkflowId) {
          toolCtx.workflowId = resolvedWorkflowId
        }
      }

      // Reads never mutate the graph — skip the between-round DB reload.
      if (
        toolRequiresWorkflowContextRefresh({
          toolName: call.name,
          success: toolResult.success,
          createdWorkflowId: toolResult.createdWorkflowId,
          result: toolResult.result,
        })
      ) {
        const refreshed = await refreshToolContext(toolCtx)
        toolCtx.structuredContext = refreshed.structuredContext
        toolCtx.workflowRevision = refreshed.workflowRevision
      } else if (
        toolResult.success &&
        (isWorkflowScopedDelegatedTool(call.name) || call.name === 'validate_workflow')
      ) {
        const output =
          toolResult.result && typeof toolResult.result === 'object'
            ? (toolResult.result as Record<string, unknown>)
            : {}
        const resolvedWorkflowId =
          typeof output.workflowId === 'string' && output.workflowId.trim()
            ? output.workflowId.trim()
            : typeof parsedArgs.workflowId === 'string' && parsedArgs.workflowId.trim()
              ? parsedArgs.workflowId.trim()
              : undefined
        if (resolvedWorkflowId) {
          toolCtx.workflowId = resolvedWorkflowId
        }
      }

      yield {
        type: 'tool_call_result',
        toolCallId: call.id,
        toolName: call.name,
        success: toolResult.success,
        output: toolResult.result,
        ...(toolResult.error ? { error: toolResult.error } : {}),
        ...(toolResult.resources?.length ? { resources: toolResult.resources } : {}),
      }

      if (mutationRequiresVerification(call.name)) {
        turnMutationOutcomes.push({ toolName: call.name, success: toolResult.success })
      }

      if (toolResult.success && mutationRequiresVerification(call.name)) {
        yield { type: 'ux_phase', phase: 'verifying' }
        yield { type: 'status', message: formatUxPhaseStatus('verifying') }
        const verification = await runPostMutationVerification({
          toolCallId: call.id,
          toolName: call.name,
          mutationSuccess: true,
          mutationResult: toolResult.result,
          workflowId: toolCtx.workflowId,
          executeVerifier: async (verifierName, args) => {
            const verifierWorkflowId =
              typeof args.workflowId === 'string' && args.workflowId.trim()
                ? args.workflowId.trim()
                : toolCtx.workflowId
            return executeLocalCopilotTool(verifierName, args, {
              ...toolCtx,
              ...(verifierWorkflowId ? { workflowId: verifierWorkflowId } : {}),
            })
          },
        })
        if (verification) {
          turnVerifications.push(verification)
          yield { type: 'verification_completed', record: verification }
          await logCopilotAction({
            userId: params.userId,
            workspaceId: params.workspaceId,
            workflowId: toolCtx.workflowId ?? params.workflowId,
            conversationId,
            action: 'verification',
            summary: `${verification.toolName} → ${verification.verifierToolName}`,
            status: verification.status === 'failed' ? 'failure' : 'success',
            metadata: verification as unknown as Record<string, unknown>,
          }).catch(() => undefined)
        }
      }

      turnToolRecords.push({
        name: call.name,
        success: toolResult.success,
        result: toolResult.result,
        ...(toolResult.error ? { error: toolResult.error } : {}),
      })
      if (isWorkflowRunToolName(call.name)) {
        streamedCharsAtLastRunTool = streamedUserFacingText.length
      }

      turnCost.addToolBilling({
        toolName: call.name,
        billing: toolResult.billing,
      })

      if (persistLocally && conversationId) {
        const sanitized = sanitizeToolIoForPersistence({
          arguments: parsedArgs,
          result: toolResult.result,
        })
        await recordToolCall({
          conversationId,
          toolCallId: call.id,
          toolName: call.name,
          arguments: sanitized.arguments,
          result: sanitized.result,
        })
      }

      await logCopilotAction({
        userId: params.userId,
        workspaceId: params.workspaceId,
        workflowId: params.workflowId,
        conversationId,
        action: 'tool_call',
        summary: call.name,
        status: toolResult.success ? 'success' : 'failure',
        metadata: {
          chatId: params.chatId,
          runId: params.runId,
          backend: 'local',
          toolCallId: call.id,
          toolName: call.name,
          ...sanitizeToolIoForPersistence({
            arguments: parsedArgs,
            result:
              toolResult.result && typeof toolResult.result === 'object'
                ? {
                    success: toolResult.success,
                    error: toolResult.error,
                  }
                : { success: toolResult.success },
          }),
        },
      }).catch(() => undefined)

      if (!toolResult.success && mutationRequiresVerification(call.name)) {
        recordLocalOpsEvent({
          counter: LOCAL_OPS_COUNTERS.mutationFailed,
          userId: params.userId,
          workspaceId: params.workspaceId,
          workflowId: params.workflowId,
          conversationId,
          chatId: params.chatId,
          runId: params.runId,
          metadata: { toolName: call.name },
        })
      }

      if (toolResult.patch) {
        proposedPatch = toolResult.patch
        if (toolResult.patch.recommendations) {
          recommendations = [...recommendations, ...toolResult.patch.recommendations]
        }
      }

      const formattedToolResult = formatToolResultForLlm(
        call.name,
        coalesceToolExecutionPayloadForLlm({
          success: toolResult.success,
          result: toolResult.result,
          error: toolResult.error,
          toolName: call.name,
        }),
        {
          artifactStore: toolCtx.artifactStore,
        }
      )
      const mandatoryFollowUp = detectMandatoryFollowUpFromExecution(
        call.name,
        toolResult.success,
        toolResult.result,
        formattedToolResult
      )
      if (mandatoryFollowUp) {
        pendingFollowUps = [
          ...pendingFollowUps.filter((item) => item.id !== mandatoryFollowUp.id),
          mandatoryFollowUp,
        ]
      }
      pendingFollowUps = resolveMandatoryFollowUps(
        pendingFollowUps,
        call.name,
        toolResult.success,
        toolResult.result
      )

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: formattedToolResult,
      })
      completedToolCallIds.add(call.id)

      if (call.name === 'get_blocks_metadata' && toolResult.success) {
        recordSuccessfulBlocksMetadataFetch()
        if (blocksMetadataFetchedThisTurn) {
          deferredSystemMessages.push({
            role: 'system',
            content: buildBlocksMetadataReuseSystemMessage(),
          })
        }
        blocksMetadataFetchedThisTurn = true
      }

      if (
        call.name === 'edit_workflow' &&
        toolResult.success &&
        createdWorkflowThisTurn &&
        !editResultNeedsFollowUp(formattedToolResult) &&
        (pendingFollowUps.length === 0 || pendingFollowUpsAreOauthOnly(pendingFollowUps)) &&
        !workflowBuildCompleteNudgeSent
      ) {
        successfulPopulateEdits += 1
        if (successfulPopulateEdits >= MAX_POPULATE_EDITS_HARD_LOCK) {
          workflowBuildCompleteNudgeSent = true
          const needsOauth =
            pendingFollowUpsAreOauthOnly(pendingFollowUps) ||
            /needsOAuthConnect|oauth_get_auth_link/i.test(formattedToolResult)
          postBuildToolMode = needsOauth ? 'oauth_only' : 'final_only'
          deferredSystemMessages.push({
            role: 'system',
            content: buildWorkflowBuildCompleteSystemMessage(postBuildToolMode),
          })
          logger.info('Arena Copilot post-build hard lock set', {
            postBuildToolMode,
            needsOauth,
            successfulPopulateEdits,
          })
        } else if (successfulPopulateEdits >= MAX_POPULATE_EDITS && !postBuildSoftNudgeSent) {
          postBuildSoftNudgeSent = true
          deferredSystemMessages.push({
            role: 'system',
            content: buildWorkflowBuildSoftCompleteSystemMessage(),
          })
          logger.info('Arena Copilot post-build soft nudge sent', {
            successfulPopulateEdits,
            maxPopulateEdits: MAX_POPULATE_EDITS,
          })
        }
      }

      if (call.name === 'generate_api_key' && toolResult.success) {
        const control = buildGeneratedApiKeyControl(toolResult.result)
        if (control) {
          yield {
            type: 'trusted_control',
            toolCallId: call.id,
            control,
          }
        }
      }

      if (call.name === 'oauth_get_auth_link' && toolResult.success) {
        postBuildToolMode = 'done'
        endTurnAfterThisRound = true
        const control = buildOAuthConnectControl(toolResult.result)
        if (control) {
          pendingOAuthControls.push(control)
          pendingOAuthToolCallId ??= call.id
        }
        deferredSystemMessages.push({
          role: 'system',
          content:
            '[System] Auth links for this response will be shown together as one Connect control. Stop. Do not call more tools or restate the completion.',
        })
      }

      // Mid-turn progress for create and a clean populate edit so the panel is
      // not left blank if the final model round is empty/aborted.
      if (toolResult.success && call.name === 'create_workflow') {
        createdWorkflowThisTurn = true
        if (!streamedCreateProgress) {
          const progress = synthesizeAssistantSummaryFromTools([
            { name: call.name, success: true, result: toolResult.result },
          ])
          if (progress?.trim()) {
            streamedCreateProgress = true
            const safe = stripIdsFromUserFacingText(progress)
            const chunk = assistantText ? `\n\n${safe}` : safe
            assistantText += chunk
            streamedUserFacingText += chunk
            yield { type: 'text_delta', content: chunk }
          }
        }
      } else if (
        toolResult.success &&
        call.name === 'edit_workflow' &&
        !editResultNeedsFollowUp(formattedToolResult) &&
        !streamedEditProgress
      ) {
        const progress = synthesizeAssistantSummaryFromTools([
          { name: call.name, success: true, result: toolResult.result },
        ])
        if (progress?.trim()) {
          streamedEditProgress = true
          const safe = stripIdsFromUserFacingText(progress)
          const chunk = assistantText ? `\n\n${safe}` : safe
          assistantText += chunk
          streamedUserFacingText += chunk
          yield { type: 'text_delta', content: chunk }
        }
      }

      const loopGuard = applyToolLoopGuards(
        call.name,
        call.arguments || '{}',
        toolResult.success,
        toolResult.result
      )
      if (loopGuard.systemMessage) {
        deferredSystemMessages.push({
          role: 'system',
          content: loopGuard.systemMessage,
        })
      }
      if (loopGuard.stop && loopGuard.userMessage) {
        stagnationStopMessage = loopGuard.userMessage
        stagnationSkipModelRound = loopGuard.skipModelRound
        logger.warn('Arena Copilot tool loop hard-stop', {
          toolName: call.name,
          skipModelRound: loopGuard.skipModelRound,
        })
        break
      }
      if (loopGuard.systemMessage && !loopGuard.stop) {
        logger.warn('Arena Copilot tool stagnation soft-nudge (pending follow-ups)', {
          toolName: call.name,
          pendingFollowUpIds: pendingFollowUps.map((item) => item.id),
        })
      }
    }

    // Anthropic requires every tool_use to have an immediate tool_result. If we
    // stopped mid-batch, synthesize skipped results before any deferred system nudges.
    for (const call of orderedToolCalls) {
      if (completedToolCallIds.has(call.id)) continue
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify({
          success: false,
          error: 'Tool call was skipped before a result was produced.',
        }),
      })
    }
    if (roundHadRejectedDiscovery) {
      deferredSystemMessages.push({
        role: 'system',
        content: `[System] ${buildPrePopulateDiscoveryBlockedMessage()}`,
      })
    }
    for (const deferred of deferredSystemMessages) {
      messages.push(deferred)
    }

    if (
      shouldRefundPrePopulateDiscoveryRound({
        createdWorkflowThisTurn,
        successfulPopulateEdits,
        roundToolNames,
        refundsSoFar: refundedPrePopulateDiscoveryRounds,
        hadRejectedDiscovery: roundHadRejectedDiscovery,
      })
    ) {
      refundedPrePopulateDiscoveryRounds += 1
      round -= 1
      logger.info('Arena Copilot refunded pre-populate discovery round', {
        refundedPrePopulateDiscoveryRounds,
        prePopulateDiscoveryCalls,
      })
    }

    if (!stagnationStopMessage && !endTurnAfterThisRound) {
      yield { type: 'status', message: 'Reviewing results…' }
    }

    const microcompactStats = applyMicrocompactInPlace(messages)
    if (microcompactStats.clearedCount > 0) {
      logger.info('Arena Copilot microcompact applied', {
        round,
        microcompactClearedCount: microcompactStats.clearedCount,
        microcompactCharsFreed: microcompactStats.charsFreed,
      })
    }

    if (estimateChatMessagesTokens(messages, tokenCountModel) > promptBudget.tokenBudget) {
      const refit = fitPromptWithSlots(messages, promptBudget.tokenBudget, tokenCountModel)
      messages.splice(0, messages.length, ...refit)
      logger.info('Arena Copilot prompt re-fit after tool round', {
        round,
        promptTokenBudget: promptBudget.tokenBudget,
        estimatedPromptTokens: estimateChatMessagesTokens(messages, tokenCountModel),
      })
    }

    if (stagnationStopMessage) break
    if (endTurnAfterThisRound) {
      postBuildToolMode = 'done'
      break
    }
  }

  if (stagnationStopMessage) {
    if (stagnationSkipModelRound) {
      // Explore hard-stop: emit the closer immediately so finalize always has
      // assistant content even if the next provider round would hang.
      const safe = stripIdsFromUserFacingText(stagnationStopMessage)
      const chunk = streamedUserFacingText.trim() ? `\n\n${safe}` : safe
      assistantText = streamedUserFacingText.trim() ? `${streamedUserFacingText}${chunk}` : safe
      streamedUserFacingText = assistantText
      yield { type: 'text_delta', content: chunk }
      void logCopilotAction({
        userId: params.userId,
        workspaceId: params.workspaceId,
        workflowId: params.workflowId,
        conversationId,
        action: 'file_explore_hard_stop',
        summary: safe.slice(0, 200),
        status: 'failure',
        metadata: {
          chatId: params.chatId,
          runId: params.runId,
          backend: 'local',
          inspectionToolCount: turnToolRecords.filter((record) =>
            ['read', 'grep', 'glob', 'load_copilot_artifact'].includes(record.name)
          ).length,
        },
      }).catch(() => undefined)
    } else {
      // One more model round with the stagnation system nudge. Keep tools attached
      // — Bedrock requires toolConfig when history already has tool content.
      // If the model stays silent, surface the stop message directly.
      const priorAssistantChars = assistantText.length
      const stagnationThinkingStatus = new ThinkingLiveStatusAccumulator()
      for await (const event of iterateWithIdleStatus({
        source: provider.chatCompletionStream({
          model: config.model,
          messages,
          tools,
          maxTokens: maxOutputTokens,
          signal: params.signal,
          ...(turnThinkingLevel ? { thinkingLevel: turnThinkingLevel } : {}),
        }),
        abortSignal: params.signal,
        messages: MODEL_WAIT_STATUS_FALLBACK,
        idleMs: 2500,
        intervalMs: 2500,
      })) {
        if (event.type === 'status') {
          if (!stagnationThinkingStatus.isPublishing) yield event
          continue
        }
        const chunk = event.item
        if (chunk.type === 'thinking_block') continue
        if (chunk.type === 'gemini_model_parts') continue
        if (chunk.type === 'thinking' && chunk.content) {
          const announceThinking = !stagnationThinkingStatus.isPublishing
          applyModelChunkToThinkingStatus(stagnationThinkingStatus, chunk)
          yield { type: 'thinking_delta', content: chunk.content }
          if (announceThinking) {
            yield { type: 'status', message: 'Thinking…' }
          }
          continue
        }
        applyModelChunkToThinkingStatus(stagnationThinkingStatus, chunk)
        if (chunk.type === 'text' && chunk.content) {
          const cleaned = stripIdsFromUserFacingText(
            stripLeakedToolMarkers(chunk.content, { trim: false })
          )
          if (!cleaned) continue
          assistantText += cleaned
          streamedUserFacingText += cleaned
          yield { type: 'text_delta', content: cleaned }
        }
        if (chunk.type === 'done') {
          if (chunk.finishReason) lastFinishReason = chunk.finishReason
          if (chunk.usage) {
            turnCost.addModelUsage({
              model: config.model,
              inputTokens: chunk.usage.inputTokens,
              outputTokens: chunk.usage.outputTokens,
              cacheReadTokens: chunk.usage.cacheReadTokens,
              provider: config.provider,
            })
            turnInputTokens += chunk.usage.inputTokens
            turnOutputTokens += chunk.usage.outputTokens
          }
        }
      }
      if (assistantText.length === priorAssistantChars) {
        const safe = stripIdsFromUserFacingText(stagnationStopMessage)
        assistantText += safe
        streamedUserFacingText += safe
        yield { type: 'text_delta', content: safe }
      }
    }
  }

  // Prefer the full streamed user-facing transcript for persistence — per-round
  // assistantText is cleared when tool calls continue.
  if (streamedUserFacingText.trim().length > assistantText.trim().length) {
    assistantText = streamedUserFacingText
  }

  // Rewrite leaked single_select JSON into canonical <options> before follow-ups / persist.
  assistantText = normalizeSingleSelectJsonToOptionsTags(assistantText)
  streamedUserFacingText = normalizeSingleSelectJsonToOptionsTags(streamedUserFacingText)

  // Tool-round / bridging narration is buffered (not streamed) to avoid repeated
  // Arena Copilot headers and empty-looking settles. If the UI never got a real
  // answer — or only got a "let me retry…" bridge — synthesize from tools (prefer)
  // or flush non-bridging buffered prose so the turn never ends on a blank bubble.
  // Incomplete workflow builds also re-synthesize even when mid-progress prose exists.
  const createdWithoutPopulate = createdWorkflowThisTurn && successfulPopulateEdits === 0
  if (
    shouldSynthesizeAssistantSummary({
      streamedUserFacingText,
      toolRecordCount: turnToolRecords.length,
      createdWithoutPopulate,
      unresolvedFollowUpCount: pendingFollowUps.length,
    })
  ) {
    if (turnToolRecords.length > 0) {
      const followUpClosing = buildUnresolvedFollowUpClosingMessage(pendingFollowUps)
      const synthesized =
        (createdWithoutPopulate || pendingFollowUps.length > 0
          ? buildWorkflowBuildChatAppendix(turnToolRecords, {
              createdWorkflowThisTurn,
              successfulPopulateEdits,
              unresolvedFollowUpHint: followUpClosing ? (pendingFollowUps[0]?.hint ?? null) : null,
              unresolvedFollowUpUserHint: pendingFollowUps[0]?.userHint ?? null,
            })
          : null) ??
        synthesizeAssistantSummaryFromTools(turnToolRecords) ??
        followUpClosing ??
        buildDebugInspectionChatAppendix(turnToolRecords) ??
        'I finished the requested steps, but had nothing further to add.'
      const safe = stripIdsFromUserFacingText(synthesized)
      assistantText = safe
      streamedUserFacingText = safe
      yield { type: 'text_delta', content: safe }
    } else if (assistantText.trim() && !isBridgingAssistantNarration(assistantText)) {
      const safe = stripIdsFromUserFacingText(assistantText)
      streamedUserFacingText = safe
      assistantText = safe
      yield { type: 'text_delta', content: safe }
    }
  } else if (
    shouldAppendWorkflowRunChatResult({
      streamedUserFacingText,
      streamedCharsAtLastRunTool,
      toolRecords: turnToolRecords,
    })
  ) {
    // Substantive pre-run prose (e.g. "Updated… Let me run it.") blocks full
    // synthesize, but the run finished with no post-run reply — append the result
    // so chat never settles on a completed "Running workflow" row alone.
    const appendix = buildWorkflowRunChatAppendix(turnToolRecords)
    if (appendix) {
      const safe = stripIdsFromUserFacingText(appendix)
      const chunk = streamedUserFacingText.trim() ? `\n\n${safe}` : safe
      assistantText += chunk
      streamedUserFacingText += chunk
      yield { type: 'text_delta', content: chunk }
    }
  }

  // Hard guarantee: debug/log turns (incl. `run` specialist) must leave visible prose.
  // Nested specialist text can sit inside a collapsed agent group while the main
  // bubble stays empty — always promote a top-level explanation when needed.
  if (turnHasDebugInspectionTools(turnToolRecords)) {
    const visible = stripIdsFromUserFacingText(
      stripOptionsTagsForDisplay(streamedUserFacingText, false)
    ).trim()
    const looksEmpty =
      !visible ||
      isBridgingAssistantNarration(visible) ||
      /^Finished the run steps\b/i.test(visible)
    if (looksEmpty) {
      const guaranteed =
        buildDebugInspectionChatAppendix(turnToolRecords) ??
        synthesizeAssistantSummaryFromTools(turnToolRecords) ??
        'I checked the execution logs but could not determine why the run failed. Please share the execution ID or try again.'
      const safe = stripIdsFromUserFacingText(guaranteed)
      if (safe && safe !== visible) {
        assistantText = safe
        streamedUserFacingText = safe
        yield { type: 'text_delta', content: safe }
      }
    }
  }

  // Hard guarantee: file inspection without a write must not settle on empty Thinking….
  if (turnHasFileInspectionTools(turnToolRecords) && !turnHasFileMutationTools(turnToolRecords)) {
    const visible = stripIdsFromUserFacingText(
      stripOptionsTagsForDisplay(streamedUserFacingText, false)
    ).trim()
    const looksEmpty = !visible || isFileInspectionBridgeNarration(visible)
    if (looksEmpty) {
      const guaranteed =
        buildFileInspectionChatAppendix(turnToolRecords) ??
        synthesizeAssistantSummaryFromTools(turnToolRecords) ??
        'I inspected the file but did not finish applying the fix. Please try again.'
      const safe = stripIdsFromUserFacingText(guaranteed)
      if (safe && safe !== visible) {
        assistantText = safe
        streamedUserFacingText = safe
        yield { type: 'text_delta', content: safe }
      }
    }
  }

  // Hard guarantee: complex workflow builds must leave a closing message even when
  // mid-progress create/edit lines already streamed (those previously blocked synthesize).
  if (
    shouldEnsureWorkflowBuildClosingMessage({
      hasDiscoveryTools: turnHasWorkflowDiscoveryTools(turnToolRecords),
      hasMutationTools: turnHasWorkflowMutationTools(turnToolRecords),
      createdWorkflowThisTurn,
      successfulPopulateEdits,
      pendingFollowUpCount: pendingFollowUps.length,
      streamedUserFacingText,
    })
  ) {
    const visible = stripIdsFromUserFacingText(
      stripOptionsTagsForDisplay(streamedUserFacingText, false)
    ).trim()
    const followUp = pendingFollowUps[0]
    const guaranteed =
      buildWorkflowBuildChatAppendix(turnToolRecords, {
        createdWorkflowThisTurn,
        successfulPopulateEdits,
        unresolvedFollowUpHint: followUp?.hint ?? null,
        unresolvedFollowUpUserHint: followUp?.userHint ?? null,
      }) ??
      buildUnresolvedFollowUpClosingMessage(pendingFollowUps) ??
      synthesizeAssistantSummaryFromTools(turnToolRecords)
    const safe = guaranteed ? stripIdsFromUserFacingText(guaranteed) : ''
    if (safe && safe !== visible) {
      // Incomplete builds replace mid-progress; empty/bridging also replace.
      const shouldReplace =
        createdWithoutPopulate ||
        pendingFollowUps.length > 0 ||
        !visible ||
        isBridgingAssistantNarration(visible)
      if (shouldReplace) {
        assistantText = safe
        streamedUserFacingText = safe
        yield { type: 'text_delta', content: safe }
      } else if (!visible.includes(safe.slice(0, Math.min(48, safe.length)))) {
        const chunk = `\n\n${safe}`
        assistantText += chunk
        streamedUserFacingText += chunk
        yield { type: 'text_delta', content: chunk }
      }
    }
  }

  const imageMarkdown = generatedImageChatMarkdown(turnToolRecords)
  if (imageMarkdown) {
    const missing = imageMarkdown
      .split('\n\n')
      .filter((line) => line.length > 0 && !streamedUserFacingText.includes(line))
    if (missing.length > 0) {
      const body = missing.join('\n\n')
      const chunk = streamedUserFacingText.trim() ? `\n\n${body}` : body
      assistantText += chunk
      streamedUserFacingText += chunk
      yield { type: 'text_delta', content: chunk }
    }
  }

  if (pendingOAuthControls.length > 0 && pendingOAuthToolCallId) {
    const control: LocalTrustedControl =
      pendingOAuthControls.length === 1
        ? pendingOAuthControls[0]
        : { type: 'credential_links', links: pendingOAuthControls }
    const text = formatTrustedControl(control)
    const chunk = streamedUserFacingText.trim() ? `\n\n${text}` : text
    streamedUserFacingText += chunk
    assistantText = streamedUserFacingText
    yield {
      type: 'trusted_control',
      toolCallId: pendingOAuthToolCallId,
      control,
    }
  }

  if (
    !params.signal?.aborted &&
    shouldEmitEmptyAssistantFallback({
      streamedUserFacingText,
      toolRecordCount: turnToolRecords.length,
    })
  ) {
    const safe = stripIdsFromUserFacingText(
      emptyAssistantTurnFallback({ finishReason: lastFinishReason })
    )
    assistantText = safe
    streamedUserFacingText = safe
    yield { type: 'text_delta', content: safe }
  }

  // Emit at most one follow-up block for the whole turn (never after each tool round).
  const followUpItems =
    recommendations.length > 0
      ? recommendations
      : modelFollowUpTitles.length > 0
        ? modelFollowUpTitles
        : []
  if (followUpItems.length > 0 && !hasOptionsTag(assistantText)) {
    const optionsTag = formatOptionsTag(followUpItems)
    assistantText += optionsTag
    streamedUserFacingText += optionsTag
    yield { type: 'text_delta', content: optionsTag }
    if (recommendations.length === 0) {
      recommendations = followUpItems
    }
  }

  let patchId: string | undefined
  if (proposedPatch && params.workflowId) {
    let patchConversationId = conversationId
    if (!patchConversationId) {
      patchConversationId = await createConversation({
        userId: params.userId,
        workspaceId: params.workspaceId,
        workflowId: params.workflowId,
        title: 'Arena Copilot (patch)',
        model: config.model,
        provider: config.provider,
      })
    }
    try {
      patchId = await savePatch({
        conversationId: patchConversationId,
        userId: params.userId,
        workflowId: params.workflowId,
        patch: proposedPatch,
      })
    } catch (error) {
      logger.warn('Failed to persist Arena Copilot patch', {
        workflowId: params.workflowId,
        error: getErrorMessage(error),
      })
    }
    yield {
      type: 'ux_phase',
      phase: 'waiting_approval',
    }
    yield {
      type: 'patch_proposed',
      patch: proposedPatch,
      patchId: patchId ?? '',
      workflowId: params.workflowId,
    }
  } else if (proposedPatch) {
    yield {
      type: 'text_delta',
      content:
        '\n\n*(Workflow patch proposed — open a workflow in the editor to review and apply changes.)*',
    }
  }

  let messageId = ''
  if (persistLocally && conversationId) {
    messageId = await appendMessage({
      conversationId,
      role: 'assistant',
      content: {
        text: assistantText,
        patchId,
        recommendations: recommendations.length ? recommendations : undefined,
      },
    })
  }

  const turnCompletion = resolveTurnCompletion({
    mutationOutcomes: turnMutationOutcomes,
    verifications: turnVerifications,
  })
  yield {
    type: 'turn_completion',
    status: turnCompletion,
    verifications: turnVerifications,
  }

  if (turnCompletion === 'completed_verified') {
    recordLocalOpsEvent({
      counter: LOCAL_OPS_COUNTERS.turnVerified,
      userId: params.userId,
      workspaceId: params.workspaceId,
      workflowId: params.workflowId,
      conversationId,
      chatId: params.chatId,
      runId: params.runId,
    })
  } else if (turnCompletion === 'failed') {
    recordLocalOpsEvent({
      counter: LOCAL_OPS_COUNTERS.turnFailed,
      userId: params.userId,
      workspaceId: params.workspaceId,
      workflowId: params.workflowId,
      conversationId,
      chatId: params.chatId,
      runId: params.runId,
    })
  }

  const approvalLines = turnToolRecords
    .filter((record) => {
      const result = record.result
      if (!result || typeof result !== 'object') return false
      const confirmationDecision = (result as Record<string, unknown>).confirmationDecision
      return confirmationDecision === 'approved' || confirmationDecision === 'rejected'
    })
    .map((record) => {
      const result = record.result as Record<string, unknown>
      return `${record.name} ${String(result.confirmationDecision)}`
    })
  const failureLines = buildToolFailureEvidenceLines(turnToolRecords)
  const verificationLines = turnVerifications.map(
    (record) => `${record.verifierToolName} ${record.status}`
  )

  if (params.chatId) {
    const nextTask = updateTaskStateFromTurn({
      previous: taskState,
      objectiveHint: params.message.slice(0, 280),
      approvals: approvalLines,
      verification: turnVerifications.map((record) => ({
        tool: record.verifierToolName,
        status: record.status,
      })),
      failed: turnCompletion === 'failed',
      targetResources: params.workflowId ? [params.workflowId] : [],
    })
    if (nextTask) {
      taskState = nextTask
      await persistTaskState(params.chatId, params.userId, nextTask).catch(() => undefined)
    }

    const nextActiveDocuments = updateActiveDocumentsFromTurn({
      previous: activeDocumentsState,
      currentTurnUploadPaths: currentRequestUploadPaths,
      toolRecords: turnToolRecords,
    })
    if (nextActiveDocuments) {
      activeDocumentsState = nextActiveDocuments
      await persistActiveDocuments(params.chatId, params.userId, nextActiveDocuments).catch(
        () => undefined
      )
    }

    const evidenced = mergeSessionMemoryEvidence(sessionMemory, {
      approvals: approvalLines,
      failures: failureLines,
      verification: verificationLines,
    })
    if (evidenced) {
      sessionMemory = evidenced
      await persistSessionMemory(params.chatId, params.userId, evidenced).catch(() => undefined)
    }

    if (toolCtx.artifactStore && toolCtx.artifactStore.artifacts.size > 0) {
      await persistArtifacts(params.chatId, params.userId, toolCtx.artifactStore).catch(
        () => undefined
      )
    }

    if (snapshotPromptPlan) {
      await mergeCopilotChatConfig(params.chatId, params.userId, {
        workspaceSnapshotMeta: snapshotPromptPlan.meta,
        workspaceSnapshotFingerprints: snapshotPromptPlan.fingerprints,
      }).catch(() => undefined)
    } else if (structuredContext.snapshotFreshness) {
      await mergeCopilotChatConfig(params.chatId, params.userId, {
        workspaceSnapshotMeta: {
          ...structuredContext.snapshotFreshness,
          workspaceId: params.workspaceId,
        },
      }).catch(() => undefined)
    } else if (params.workspaceSnapshot && params.workspaceContext) {
      await mergeCopilotChatConfig(params.chatId, params.userId, {
        workspaceSnapshotMeta: {
          ...toWorkspaceSnapshotMeta({
            markdown: params.workspaceContext,
            snapshot: params.workspaceSnapshot,
          }),
          workspaceId: params.workspaceId,
        },
      }).catch(() => undefined)
    }
  }

  await logCopilotAction({
    userId: params.userId,
    workspaceId: params.workspaceId,
    workflowId: params.workflowId,
    conversationId,
    action: 'turn_completion',
    summary: turnCompletion,
    status: turnCompletion === 'failed' ? 'failure' : 'success',
    metadata: {
      status: turnCompletion,
      verificationCount: turnVerifications.length,
      mutationCount: turnMutationOutcomes.length,
    },
  }).catch(() => undefined)

  const costSummary = turnCost.summarize()

  logger.info('Arena Copilot turn complete', {
    conversationId: conversationId ?? null,
    messageId: messageId || null,
    usageTurnId,
    patchId: patchId ?? null,
    workspaceId: params.workspaceId,
    workflowId: params.workflowId ?? null,
    model: config.model,
    provider: config.provider,
    historyTurns: historyMessages.length,
    assistantChars: assistantText.length,
    toolCallCount: turnToolRecords.length,
    toolNames: turnToolRecords.map((record) => record.name),
    inputTokens: turnInputTokens,
    outputTokens: turnOutputTokens,
    hasPatch: Boolean(proposedPatch),
    turnCost: costSummary.total,
    writeChatLedger,
    durationMs: timing.elapsed(),
    prepMs: timing.elapsed('promptReady'),
    contextBuildMs: timing.elapsed('contextReady'),
    ttftMs: timing.since('modelRound0Start', 'firstModelOutput'),
    hasCallerSnapshot: Boolean(workspaceSnapshotBundle),
    marks: timing.snapshot(),
    memory: getLocalCopilotMemorySnapshot(),
  })

  logger.info('Arena Copilot latency checkpoint', {
    phase: 'turn_complete',
    usageTurnId,
    workspaceId: params.workspaceId,
    durationMs: timing.elapsed(),
    prepMs: timing.elapsed('promptReady'),
    contextBuildMs: timing.elapsed('contextReady'),
    sessionAndPrefetchMs: timing.since('contextReady', 'sessionPrefetchReady'),
    promptAssembleMs: timing.since('sessionPrefetchReady', 'promptReady'),
    spendCapMs: timing.elapsed('spendCapReady'),
    spendCapWaitAfterPromptMs: timing.since('promptReady', 'spendCapReady'),
    ttftMs: timing.since('modelRound0Start', 'firstModelOutput'),
    hasCallerSnapshot: Boolean(workspaceSnapshotBundle),
    provider: config.provider,
    model: config.model,
    marks: timing.snapshot(),
  })

  if (writeChatLedger) {
    await recordLocalCopilotTurnUsage({
      userId: params.userId,
      workspaceId: params.workspaceId,
      workflowId: params.workflowId,
      chatId: params.chatId,
      runId: params.runId,
      conversationId: conversationId ?? undefined,
      messageId: usageTurnId,
      summary: costSummary,
      executionActor: { actorUserId: params.userId, actorType: 'user' },
      parentExecutionId: params.parentExecutionId,
      rootExecutionId: params.parentExecutionId,
      triggeringChatId: params.chatId,
      triggeringRunId: params.runId,
      billingAttribution,
    })
    recordLocalOpsEvent({
      counter: LOCAL_OPS_COUNTERS.costRecorded,
      userId: params.userId,
      workspaceId: params.workspaceId,
      workflowId: params.workflowId,
      conversationId,
      chatId: params.chatId,
      runId: params.runId,
      metadata: { total: costSummary.total },
    })
  }

  yield {
    type: 'done',
    messageId: messageId || usageTurnId,
    ...(turnInputTokens > 0 || turnOutputTokens > 0
      ? {
          usage: {
            model: config.model,
            inputTokens: turnInputTokens,
            outputTokens: turnOutputTokens,
          },
        }
      : {}),
  }

  if (!writeChatLedger && costSummary.total > 0) {
    return costSummary
  }

  return undefined
}

export function formatSSE(event: LocalCopilotStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}
