import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { generateId } from '@sim/utils/id'
import {
  MothershipStreamV1CompletionStatus,
  MothershipStreamV1EventType,
  MothershipStreamV1ResourceOp,
  MothershipStreamV1SessionKind,
  MothershipStreamV1TextChannel,
  MothershipStreamV1ToolExecutor,
  MothershipStreamV1ToolMode,
  MothershipStreamV1ToolOutcome,
  MothershipStreamV1ToolPhase,
} from '@/lib/mothership/generated/mothership-stream-v1'
import type { VfsSnapshotV1 } from '@/lib/mothership/generated/vfs-snapshot-v1'
import {
  createFilePreviewAdapterState,
  type FilePreviewAdapterState,
  processFilePreviewStreamEvent,
} from '@/lib/mothership/request/go/file-preview-adapter'
import {
  handleSubagentRouting,
  sseHandlers,
  subAgentHandlers,
} from '@/lib/mothership/request/handlers'
import {
  flushSubagentThinkingBlock,
  flushThinkingBlock,
} from '@/lib/mothership/request/handlers/types'
import type { CopilotLifecycleOptions } from '@/lib/mothership/request/lifecycle/run'
import {
  isSubagentSpanStreamEvent,
  isToolCallStreamEvent,
  LOCAL_STATUS_PHASE,
} from '@/lib/mothership/request/session'
import { handleResourceSideEffects } from '@/lib/mothership/request/tools/resources'
import type {
  ExecutionContext,
  OrchestratorOptions,
  StreamEvent,
  StreamingContext,
} from '@/lib/mothership/request/types'
import { persistChatResources } from '@/lib/mothership/resources/persistence'
import {
  extractLocalFileChatResources,
  stripLocalFileBodyToolParams,
} from '@/local-copilot/integration/file-turn-persist'
import {
  adaptLocalFilePreviewStreamEvent,
  emitLocalCreateFilePreview,
} from '@/local-copilot/integration/local-file-preview'
import {
  applyLocalSubagentSpanToContext,
  createSpecialistSpanTracker,
  type SpecialistSpanTracker,
  specialistSpanEndEvent,
  specialistSpanStartEvent,
} from '@/local-copilot/integration/specialist-stream-scope'
import { runLocalCopilotAgent } from '@/local-copilot/lib/agent/orchestrator'
import { formatUxPhaseStatus } from '@/local-copilot/lib/agent/ux-phase'
import type { LocalTurnCostSummary } from '@/local-copilot/lib/billing/turn-cost-accumulator'
import { getLocalCopilotConfig } from '@/local-copilot/lib/config'
import { resolveOpenWorkflowId } from '@/local-copilot/lib/context/open-workflow'
import { getLocalCopilotMemorySnapshot } from '@/local-copilot/lib/diagnostics'
import {
  type LocalCopilotCatalogId,
  resolveLocalCopilotCatalogId,
} from '@/local-copilot/lib/model-catalog'
import { loadMothershipChatHistoryForLocalCopilot } from '@/local-copilot/lib/mothership-history'
import type { ChatMessage } from '@/local-copilot/lib/providers/types'
import {
  formatLocalToolConfirmationTag,
  formatLocalWorkflowPatchTag,
} from '@/local-copilot/lib/security/tool-confirmation-policy'
import { formatTrustedControl } from '@/local-copilot/lib/security/trusted-controls'
import type { LocalCopilotStreamEvent } from '@/local-copilot/lib/types'
import { stripIdsFromUserFacingText } from '@/local-copilot/lib/user-facing-text'
import type {
  CopilotContextEntry,
  CopilotFileAttachmentRef,
} from '@/local-copilot/lib/user-turn-content'

const logger = createLogger('LocalCopilotMothershipLifecycle')

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Reads the typed workspace inventory snapshot from the mothership payload. Sim
 * built it in `post.ts` alongside the markdown; forwarding it lets Local context
 * building skip a second identical DB fetch.
 */
function extractWorkspaceSnapshot(value: unknown): VfsSnapshotV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as VfsSnapshotV1
}

function resolveCatalogIdFromPayload(
  requestPayload: Record<string, unknown>
): LocalCopilotCatalogId {
  return resolveLocalCopilotCatalogId(extractString(requestPayload.model))
}

function extractContexts(value: unknown): CopilotContextEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const contexts = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const type = extractString(record.type)
    const content = typeof record.content === 'string' ? record.content : ''
    const path = extractString(record.path)
    if (!type || (!content.trim() && !path)) return []
    return [
      {
        type,
        content,
        ...(extractString(record.tag) ? { tag: extractString(record.tag) } : {}),
        ...(path ? { path } : {}),
      },
    ]
  })
  return contexts.length > 0 ? contexts : undefined
}

function extractFileAttachments(value: unknown): CopilotFileAttachmentRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const attachments = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const key = extractString(record.key)
    const filename = extractString(record.filename)
    const mediaType = extractString(record.media_type)
    const size =
      typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : null
    if (!key || !filename || !mediaType || size === null) return []
    return [{ key, filename, media_type: mediaType, size }]
  })
  return attachments.length > 0 ? attachments : undefined
}

function withStrippedFileToolArgs(event: StreamEvent): StreamEvent {
  if (!isToolCallStreamEvent(event)) return event
  const args = event.payload.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) return event
  const stripped = stripLocalFileBodyToolParams(event.payload.toolName, args)
  if (stripped === args) return event
  return {
    ...event,
    payload: {
      ...event.payload,
      arguments: stripped,
    },
  }
}

interface LocalFilePreviewRuntime {
  adapterState: FilePreviewAdapterState
  createFileSessions: Set<string>
}

async function dispatchStreamEvent(
  event: StreamEvent,
  context: StreamingContext,
  execContext: ExecutionContext,
  options: OrchestratorOptions,
  filePreview: LocalFilePreviewRuntime
): Promise<void> {
  const previewEvent = adaptLocalFilePreviewStreamEvent(event)
  try {
    await processFilePreviewStreamEvent({
      streamId: context.messageId,
      streamEvent: previewEvent,
      context,
      execContext,
      options,
      state: filePreview.adapterState,
    })
  } catch (error) {
    logger.warn('Failed to process file preview stream event', {
      type: event.type,
      requestId: context.requestId,
      messageId: context.messageId,
      error: getErrorMessage(error),
    })
  }

  await emitLocalCreateFilePreview({
    streamEvent: previewEvent,
    options,
    sessions: filePreview.createFileSessions,
  })

  const clientEvent = withStrippedFileToolArgs(event)
  await options.onEvent?.(clientEvent)

  if (isSubagentSpanStreamEvent(clientEvent)) {
    applyLocalSubagentSpanToContext(clientEvent, context)
  }

  if (handleSubagentRouting(clientEvent, context)) {
    const subagentHandler = subAgentHandlers[clientEvent.type]
    if (subagentHandler) {
      await subagentHandler(clientEvent, context, execContext, options)
    }
    return
  }

  const handler = sseHandlers[clientEvent.type]
  if (handler) {
    await handler(clientEvent, context, execContext, options)
  }
}

async function dispatchLocalCopilotEvent(
  event: LocalCopilotStreamEvent,
  context: StreamingContext,
  execContext: ExecutionContext,
  options: CopilotLifecycleOptions,
  toolArgsByCallId: Map<string, Record<string, unknown>>,
  filePreview: LocalFilePreviewRuntime,
  specialistSpans: SpecialistSpanTracker,
  liveStatusDedupe: { lastMessage: string | null }
): Promise<void> {
  if (event.type === 'status') {
    // Ephemeral UI-only: publish synthetic envelope via onEvent, skip content-block handlers.
    // Skip consecutive duplicates — idle fallback used to republish "Thinking…" at 10Hz.
    if (event.message === liveStatusDedupe.lastMessage) {
      return
    }
    liveStatusDedupe.lastMessage = event.message
    const statusEvent: StreamEvent = {
      type: 'run',
      payload: {
        statusPhase: LOCAL_STATUS_PHASE,
        message: event.message,
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(event.toolName ? { toolName: event.toolName } : {}),
      },
    }
    await options.onEvent?.(statusEvent)
    return
  }

  if (event.type === 'tool_call_start') {
    toolArgsByCallId.set(event.toolCallId, event.args ?? {})
    const dispatchFrame = specialistSpans.pushDispatch(event.toolCallId, event.toolName)
    const nestedScope = dispatchFrame ? undefined : specialistSpans.scopeForNested()
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.tool,
        payload: {
          phase: MothershipStreamV1ToolPhase.call,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          // Arena Copilot already ran this tool. Use `go` so Sim's auto-execute
          // path does not look up Arena-only ids (e.g. invoke_integration_tool)
          // in the built-in tools registry.
          executor: MothershipStreamV1ToolExecutor.go,
          mode: MothershipStreamV1ToolMode.sync,
          arguments: event.args,
          ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
        },
        ...(nestedScope ? { scope: nestedScope } : {}),
      },
      context,
      execContext,
      options,
      filePreview
    )
    if (dispatchFrame) {
      await dispatchStreamEvent(
        specialistSpanStartEvent(dispatchFrame),
        context,
        execContext,
        options,
        filePreview
      )
    }
    return
  }

  if (event.type === 'tool_call_result') {
    const toolResult = {
      success: event.success,
      output: event.output,
      error: event.error,
      ...(event.resources?.length ? { resources: event.resources } : {}),
    }

    const dispatchFrame = specialistSpans.popDispatch(event.toolCallId)
    const nestedScope = dispatchFrame ? undefined : specialistSpans.scopeForNested()
    if (dispatchFrame) {
      await dispatchStreamEvent(
        specialistSpanEndEvent(dispatchFrame),
        context,
        execContext,
        options,
        filePreview
      )
    }

    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.tool,
        payload: {
          phase: MothershipStreamV1ToolPhase.result,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          executor: MothershipStreamV1ToolExecutor.go,
          mode: MothershipStreamV1ToolMode.sync,
          success: event.success,
          output: event.output,
          ...(event.error ? { error: event.error } : {}),
          status: event.success
            ? MothershipStreamV1ToolOutcome.success
            : MothershipStreamV1ToolOutcome.error,
        },
        ...(nestedScope ? { scope: nestedScope } : {}),
      },
      context,
      execContext,
      options,
      filePreview
    )

    if (
      event.toolName === 'create_workflow' &&
      event.success &&
      event.output &&
      typeof event.output === 'object'
    ) {
      const workflowId = (event.output as Record<string, unknown>).workflowId
      if (typeof workflowId === 'string' && workflowId.trim()) {
        execContext.workflowId = workflowId
      }
    }

    // Prefer options.chatId, then the streaming context — a missing chatId
    // skips resource upserts and leaves the mothership right panel closed.
    const chatId = options.chatId ?? context.chatId
    if (chatId && event.success) {
      // Pass runtime + projected results (identical on Arena — no secret
      // projection). Omitting projectedResult used to shift chatId into that
      // slot; projected extraction then returned [] and the length mismatch
      // dropped the upsert that opens the right panel.
      await handleResourceSideEffects(
        event.toolName,
        toolArgsByCallId.get(event.toolCallId),
        toolResult,
        toolResult,
        chatId,
        (streamEvent) =>
          dispatchStreamEvent(streamEvent, context, execContext, options, filePreview),
        () => Boolean(options.abortSignal?.aborted)
      )
      const createdResources = extractLocalFileChatResources(
        event.toolName,
        toolArgsByCallId.get(event.toolCallId),
        event.output
      )
      if (createdResources.length > 0) {
        await persistChatResources(chatId, createdResources)
        for (const resource of createdResources) {
          await dispatchStreamEvent(
            {
              type: MothershipStreamV1EventType.resource,
              payload: {
                op: MothershipStreamV1ResourceOp.upsert,
                resource: {
                  type: resource.type,
                  id: resource.id,
                  title: resource.title,
                  ...(resource.path ? { path: resource.path } : {}),
                },
              },
            },
            context,
            execContext,
            options,
            filePreview
          )
        }
      }
    }
    return
  }

  if (event.type === 'text_delta' && (event.content || event.thoughtSignature)) {
    const safeText = event.content ? stripIdsFromUserFacingText(event.content) : ''
    if (!safeText && !event.thoughtSignature) return
    const nestedScope = specialistSpans.scopeForNested()
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.text,
        payload: {
          channel: MothershipStreamV1TextChannel.assistant,
          text: safeText,
          ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
        },
        ...(nestedScope ? { scope: nestedScope } : {}),
      },
      context,
      execContext,
      options,
      filePreview
    )
    return
  }

  if (event.type === 'thinking_delta' && (event.content || event.thoughtSignature)) {
    // UI Thinking chrome is content-only. Opaque thought signatures belong on
    // gemini_model_parts / assistant text trailers — forwarding them here stamps
    // them onto thinking blocks and corrupts Vertex follow-up turns.
    if (!event.content) return
    const nestedScope = specialistSpans.scopeForNested()
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.text,
        payload: {
          channel: MothershipStreamV1TextChannel.thinking,
          text: event.content,
        },
        ...(nestedScope ? { scope: nestedScope } : {}),
      },
      context,
      execContext,
      options,
      filePreview
    )
    return
  }

  if (event.type === 'gemini_model_parts' && event.parts.length > 0) {
    if (!context.geminiModelPartRounds) {
      context.geminiModelPartRounds = []
    }
    context.geminiModelPartRounds.push(event.parts)
    return
  }

  if (event.type === 'trusted_control') {
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.text,
        payload: {
          channel: MothershipStreamV1TextChannel.assistant,
          text: formatTrustedControl(event.control),
        },
      },
      context,
      execContext,
      options,
      filePreview
    )
    return
  }

  if (event.type === 'ux_phase') {
    await options.onEvent?.({
      type: 'run',
      payload: {
        statusPhase: LOCAL_STATUS_PHASE,
        message: formatUxPhaseStatus(event.phase),
      },
    })
    return
  }

  if (event.type === 'confirmation_required') {
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.text,
        payload: {
          channel: MothershipStreamV1TextChannel.assistant,
          text: formatLocalToolConfirmationTag(event.toolCallId, event.toolName, event.requirement),
        },
      },
      context,
      execContext,
      options,
      filePreview
    )
    return
  }

  if (event.type === 'verification_completed') {
    await options.onEvent?.({
      type: 'run',
      payload: {
        statusPhase: LOCAL_STATUS_PHASE,
        message: `Verified ${event.record.toolName}: ${event.record.status}`,
        toolCallId: event.record.toolCallId,
        toolName: event.record.verifierToolName,
      },
    })
    return
  }

  if (event.type === 'turn_completion') {
    // Internal completion verdict — not a user-facing status line. Publishing it
    // as agent_live_status replaced the last useful status ("Reviewing…") with
    // "Turn completion: completed_verified" and then the complete event cleared
    // the line, which made option-only settles look like the reply vanished.
    return
  }

  if (event.type === 'patch_proposed') {
    const workflowId =
      (typeof event.workflowId === 'string' && event.workflowId.trim()) ||
      extractString(execContext.workflowId) ||
      ''
    if (event.patchId && workflowId) {
      await dispatchStreamEvent(
        {
          type: MothershipStreamV1EventType.text,
          payload: {
            channel: MothershipStreamV1TextChannel.assistant,
            text: formatLocalWorkflowPatchTag({
              patchId: event.patchId,
              summary: event.patch.summary,
              workflowId,
            }),
          },
        },
        context,
        execContext,
        options,
        filePreview
      )
      return
    }
    const patchNote = stripIdsFromUserFacingText(
      `\n\n**Proposed workflow change:** ${event.patch.summary}\n\nCould not persist a reviewable patch. Ask Copilot to propose the change again.`
    )
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.text,
        payload: {
          channel: MothershipStreamV1TextChannel.assistant,
          text: patchNote,
        },
      },
      context,
      execContext,
      options,
      filePreview
    )
    return
  }

  if (event.type === 'error') {
    const safeMessage = stripIdsFromUserFacingText(event.message) || event.message
    context.errors.push(safeMessage)
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.error,
        payload: { message: safeMessage, code: 'local_copilot_error' },
      },
      context,
      execContext,
      options,
      filePreview
    )
  }
}

/**
 * Runs Arena Copilot in-process and emits Mothership-compatible stream events
 * so existing `/api/mothership/chat` + `useChat` work without the Go backend.
 */
export async function runLocalCopilotMothershipLifecycle(
  requestPayload: Record<string, unknown>,
  context: StreamingContext,
  execContext: ExecutionContext,
  options: CopilotLifecycleOptions
): Promise<void> {
  const message = extractString(requestPayload.message)
  const contexts = extractContexts(requestPayload.context)
  const fileAttachments = extractFileAttachments(requestPayload.fileAttachments)
  const workspaceContext = extractString(requestPayload.workspaceContext)
  const workspaceSnapshot = extractWorkspaceSnapshot(requestPayload.vfs)
  const workflowId =
    extractString(options.workflowId) ??
    extractString(requestPayload.workflowId) ??
    extractString(execContext.workflowId) ??
    resolveOpenWorkflowId({
      contexts,
      snapshotWorkflows: workspaceSnapshot?.workflows,
    })
  const workspaceId = options.workspaceId ?? extractString(requestPayload.workspaceId)
  const userId = options.userId
  const filePreview: LocalFilePreviewRuntime = {
    adapterState: createFilePreviewAdapterState(),
    createFileSessions: new Set<string>(),
  }

  if (!message) {
    context.errors.push('Message is required')
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.error,
        payload: { message: 'Message is required', code: 'validation_error' },
      },
      context,
      execContext,
      options,
      filePreview
    )
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.complete,
        payload: { status: MothershipStreamV1CompletionStatus.error },
      },
      context,
      execContext,
      options,
      filePreview
    )
    return
  }

  if (!workspaceId || !userId) {
    context.errors.push('Arena Copilot requires workspaceId')
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.error,
        payload: {
          message: 'Workspace context is required for Arena Copilot',
          code: 'missing_workspace_context',
        },
      },
      context,
      execContext,
      options,
      filePreview
    )
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.complete,
        payload: { status: MothershipStreamV1CompletionStatus.error },
      },
      context,
      execContext,
      options,
      filePreview
    )
    return
  }

  logger.info('Running Arena Copilot mothership lifecycle', {
    workflowId: workflowId ?? null,
    workspaceId,
    userId,
    chatId: options.chatId ?? null,
    messageChars: message.length,
    contextEntries: contexts?.length ?? 0,
    fileAttachments: fileAttachments?.length ?? 0,
    hasWorkspaceSnapshot: Boolean(workspaceContext),
    memory: getLocalCopilotMemorySnapshot(),
  })

  const startedAt = Date.now()
  const toolArgsByCallId = new Map<string, Record<string, unknown>>()
  const specialistSpans = createSpecialistSpanTracker()
  /** Workflow created this turn — re-activated at end so KB/file upserts do not steal the right panel. */
  let createdWorkflowResource: { id: string; title: string } | undefined
  const userMessageId =
    typeof requestPayload.messageId === 'string' ? requestPayload.messageId : undefined
  let turnUsage:
    | {
        model: string
        inputTokens: number
        outputTokens: number
      }
    | undefined
  const isMothershipBlockExecute =
    typeof options.goRoute === 'string' && options.goRoute.startsWith('/api/mothership/execute')
  /** Workflow owns block cost via `result.cost`; interactive Local chat writes the ledger. */
  const writeChatLedger = !isMothershipBlockExecute
  let blockExecuteCost: LocalTurnCostSummary | undefined

  let priorMessages: ChatMessage[] = []
  let sessionMemoryTurns: Awaited<
    ReturnType<typeof loadMothershipChatHistoryForLocalCopilot>
  >['sessionMemoryTurns'] = []
  if (options.chatId) {
    const history = await loadMothershipChatHistoryForLocalCopilot({
      chatId: options.chatId,
      userId,
      excludeMessageId: userMessageId,
    })
    priorMessages = history.messages
    sessionMemoryTurns = history.sessionMemoryTurns
    const geminiHistory = priorMessages.filter((m) => m.role === 'assistant' && m.geminiModelParts)
    logger.info('Loaded mothership chat history for Arena Copilot', {
      chatId: options.chatId,
      turns: priorMessages.length,
      sessionMemoryTurns: sessionMemoryTurns.length,
      geminiModelTurns: geminiHistory.length,
      geminiThoughtParts: geminiHistory.reduce(
        (sum, m) =>
          sum + (m.geminiModelParts?.filter((p) => 'thought' in p && p.thought).length ?? 0),
        0
      ),
      geminiSignatureParts: geminiHistory.reduce(
        (sum, m) =>
          sum + (m.geminiModelParts?.filter((p) => Boolean(p.thoughtSignature)).length ?? 0),
        0
      ),
      memory: getLocalCopilotMemorySnapshot(),
    })
  }

  try {
    let eventCount = 0
    let toolCallCount = 0
    const catalogId = resolveCatalogIdFromPayload(requestPayload)
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.session,
        payload: {
          kind: MothershipStreamV1SessionKind.start,
          data: { responseId: generateId() },
        },
      },
      context,
      execContext,
      options,
      filePreview
    )
    const agent = runLocalCopilotAgent({
      userId,
      workspaceId,
      message,
      chatId: options.chatId,
      runId: options.runId ?? execContext.runId,
      catalogId,
      ...(userMessageId ? { messageId: userMessageId } : {}),
      ...(isMothershipBlockExecute && (options.executionId ?? execContext.executionId)
        ? { parentExecutionId: options.executionId ?? execContext.executionId }
        : {}),
      priorMessages,
      sessionMemoryTurns,
      persistLocally: false,
      writeChatLedger,
      ...(contexts ? { contexts } : {}),
      ...(fileAttachments ? { fileAttachments } : {}),
      ...(workspaceContext ? { workspaceContext } : {}),
      ...(workspaceSnapshot ? { workspaceSnapshot } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(execContext.userPermission ? { userPermission: execContext.userPermission } : {}),
      ...(execContext.billingAttribution
        ? { billingAttribution: execContext.billingAttribution }
        : {}),
      signal: options.abortSignal,
    })

    const liveStatusDedupe = { lastMessage: null as string | null }

    while (true) {
      const { done, value } = await agent.next()
      if (done) {
        blockExecuteCost = value
        break
      }

      const event = value
      if (options.abortSignal?.aborted) {
        context.wasAborted = true
        logger.warn('Arena Copilot mothership lifecycle aborted', {
          workspaceId,
          workflowId: workflowId ?? null,
          eventCount,
          toolCallCount,
          durationMs: Date.now() - startedAt,
          memory: getLocalCopilotMemorySnapshot(),
        })
        break
      }

      eventCount += 1
      if (event.type === 'tool_call_start') toolCallCount += 1
      if (event.type === 'done' && event.usage) {
        turnUsage = event.usage
      }
      if (
        event.type === 'tool_call_result' &&
        event.toolName === 'create_workflow' &&
        event.success &&
        event.output &&
        typeof event.output === 'object'
      ) {
        const output = event.output as Record<string, unknown>
        const createdId =
          typeof output.workflowId === 'string' && output.workflowId.trim()
            ? output.workflowId.trim()
            : event.resources?.find((resource) => resource.type === 'workflow')?.id
        if (createdId) {
          const titleFromOutput =
            typeof output.workflowName === 'string' && output.workflowName.trim()
              ? output.workflowName.trim()
              : undefined
          const titleFromResource = event.resources?.find(
            (resource) => resource.type === 'workflow' && resource.id === createdId
          )?.title
          createdWorkflowResource = {
            id: createdId,
            title: titleFromOutput || titleFromResource || 'Workflow',
          }
        }
      }

      await dispatchLocalCopilotEvent(
        event,
        context,
        execContext,
        options,
        toolArgsByCallId,
        filePreview,
        specialistSpans,
        liveStatusDedupe
      )
    }

    // Local defers the wire `complete` event until after `onComplete` persists
    // the assistant row. `handleCompleteEvent` normally flushes open thinking
    // into contentBlocks — without an explicit flush here, CoT stays only in
    // `currentThinkingBlock` / subagent maps and never reaches persistence or
    // the settled UI chrome.
    flushSubagentThinkingBlock(context)
    flushThinkingBlock(context)

    // Re-activate the workflow created this turn last so later KB/file resource
    // upserts do not leave the mothership right panel on the wrong tab.
    const chatIdForResources = options.chatId ?? context.chatId
    if (
      createdWorkflowResource &&
      chatIdForResources &&
      !context.wasAborted &&
      !options.abortSignal?.aborted
    ) {
      await persistChatResources(chatIdForResources, [
        {
          type: 'workflow',
          id: createdWorkflowResource.id,
          title: createdWorkflowResource.title,
        },
      ])
      await dispatchStreamEvent(
        {
          type: MothershipStreamV1EventType.resource,
          payload: {
            op: MothershipStreamV1ResourceOp.upsert,
            resource: {
              type: 'workflow',
              id: createdWorkflowResource.id,
              title: createdWorkflowResource.title,
            },
          },
        },
        context,
        execContext,
        options,
        filePreview
      )
      logger.info('Arena Copilot re-activated created workflow in mothership panel', {
        chatId: chatIdForResources,
        workflowId: createdWorkflowResource.id,
      })
    }

    const status =
      context.errors.length > 0
        ? MothershipStreamV1CompletionStatus.error
        : context.wasAborted
          ? MothershipStreamV1CompletionStatus.cancelled
          : MothershipStreamV1CompletionStatus.complete

    const billingModel = turnUsage?.model || getLocalCopilotConfig().model
    context.billingModel = billingModel
    context.completionStatus = status

    logger.info('Arena Copilot mothership lifecycle finished', {
      workspaceId,
      workflowId: workflowId ?? null,
      status,
      eventCount,
      toolCallCount,
      errorCount: context.errors.length,
      model: billingModel,
      inputTokens: turnUsage?.inputTokens ?? 0,
      outputTokens: turnUsage?.outputTokens ?? 0,
      turnCost: blockExecuteCost?.total ?? 0,
      writeChatLedger,
      durationMs: Date.now() - startedAt,
      memory: getLocalCopilotMemorySnapshot(),
    })

    // Defer the `complete` SSE until after `onComplete` persists the assistant
    // row (run.ts → finalizeStream). Publishing complete here races the client's
    // detail refetch and can replace the rich live turn with an empty message.
    if (turnUsage && (turnUsage.inputTokens > 0 || turnUsage.outputTokens > 0)) {
      context.usage = {
        prompt: turnUsage.inputTokens,
        completion: turnUsage.outputTokens,
      }
    }

    if (blockExecuteCost && blockExecuteCost.total > 0) {
      context.cost = {
        input: blockExecuteCost.input,
        output: blockExecuteCost.output,
        total: blockExecuteCost.total,
      }
    }
  } catch (error) {
    const messageText = getErrorMessage(error, 'Arena Copilot failed')
    logger.error('Arena Copilot mothership lifecycle failed', {
      error: messageText,
      workspaceId,
      workflowId: workflowId ?? null,
      durationMs: Date.now() - startedAt,
      memory: getLocalCopilotMemorySnapshot(),
    })
    context.errors.push(messageText)
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.error,
        payload: { message: messageText, code: 'local_copilot_error' },
      },
      context,
      execContext,
      options,
      filePreview
    )
    await dispatchStreamEvent(
      {
        type: MothershipStreamV1EventType.complete,
        payload: { status: MothershipStreamV1CompletionStatus.error },
      },
      context,
      execContext,
      options,
      filePreview
    )
  }
}
