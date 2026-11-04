import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { truncate } from '@sim/utils/string'
import { runToolWithStatus } from '@/local-copilot/lib/agent/run-tool-with-status'
import type { SpecialistBudget } from '@/local-copilot/lib/agent/specialists/budget'
import { resolveSpecialistTimeoutMs } from '@/local-copilot/lib/agent/specialists/budget'
import {
  clearSpecialistCheckpoint,
  formatSpecialistCheckpointSystemMessage,
  loadSpecialistCheckpoint,
  persistSpecialistCheckpoint,
} from '@/local-copilot/lib/agent/specialists/checkpoint'
import {
  ALWAYS_ON_TOOL_NAMES,
  domainSystemHint,
  filterToolsByNames,
  type LocalCopilotCloudSpecialistDomain,
  type LocalCopilotSpecialistDomain,
  toolNamesForDomain,
} from '@/local-copilot/lib/agent/specialists/domains'
import {
  buildSpecialistUserMessage,
  getParentSpecialistToolDefinitions,
  isSpecialistTool,
} from '@/local-copilot/lib/agent/specialists/specialist-tools'
import { unresolvedThinkingBlockText } from '@/local-copilot/lib/agent/thinking-block-to-delta'
import type { LocalTurnCostAccumulator } from '@/local-copilot/lib/billing/turn-cost-accumulator'
import { resolveLocalCopilotMaxOutputTokens } from '@/local-copilot/lib/context/context-budget'
import { getLocalCopilotMemorySnapshot } from '@/local-copilot/lib/diagnostics'
import type {
  AnthropicThinkingHistoryBlock,
  ChatMessage,
  GeminiHistoryPart,
  LocalCopilotProvider,
} from '@/local-copilot/lib/providers/types'
import {
  prepareLocalToolConfirmation,
  waitForLocalToolConfirmation,
} from '@/local-copilot/lib/security/request-tool-confirmation'
import { classifyLocalToolConfirmation } from '@/local-copilot/lib/security/tool-confirmation-policy'
import {
  buildDebugInspectionChatAppendix,
  isDebugInspectionToolName,
  type ToolTurnRecord,
} from '@/local-copilot/lib/synthesize-assistant-summary'
import { toolRequiresWorkflowContextRefresh } from '@/local-copilot/lib/tools/context-refresh'
import type { ToolExecutionContext, ToolExecutionResult } from '@/local-copilot/lib/tools/executor'
import {
  bindLocalFileIntentChannel,
  buildFollowUpContinuationMessage,
  clearLocalFileIntentChannel,
  coalesceToolExecutionPayloadForLlm,
  detectMandatoryFollowUpFromExecution,
  formatToolResultForLlm,
  type MandatoryFollowUp,
  resolveMandatoryFollowUps,
  sortToolCallsForExecution,
} from '@/local-copilot/lib/tools/format-tool-result'
import type { LocalCopilotStreamEvent, LocalCopilotToolDefinition } from '@/local-copilot/lib/types'
import { buildDebugExplanationContinuationMessage } from '@/local-copilot/lib/user-facing-text'
import { mutationRequiresVerification } from '@/local-copilot/lib/verification/policy'
import { runPostMutationVerification } from '@/local-copilot/lib/verification/run-verification'
import { buildSpecialistStructuredResult } from '@/local-copilot/lib/verification/specialist-result'
import type {
  MutationOutcome,
  SpecialistStructuredResult,
  VerificationRecord,
} from '@/local-copilot/lib/verification/types'

const logger = createLogger('LocalCopilotSpecialistPass')

/**
 * File writes are sequential (`create_file` → `workspace_file` → `edit_content`)
 * plus discovery. Two office files in one pass need more than a handful of rounds.
 */
export const SPECIALIST_PASS_MAX_ROUNDS = 10
const MAX_SPECIALIST_FORCED_FOLLOW_UP_ROUNDS = 4
/** When log/debug tools finish with no prose, force one closing explanation round. */
const MAX_SPECIALIST_DEBUG_EXPLANATION_ROUNDS = 1
export const SPECIALIST_FINDINGS_MAX_CHARS = 12_000

export interface RunSpecialistPassParams {
  domain: LocalCopilotSpecialistDomain
  userMessage: string
  model: string
  provider: LocalCopilotProvider
  allTools: LocalCopilotToolDefinition[]
  toolCtx: ToolExecutionContext
  signal?: AbortSignal
  userId: string
  workspaceId: string
  workflowId?: string
  usageTurnId: string
  /**
   * Shared with the parent turn so specialist model/tool cost flushes once via
   * `recordLocalCopilotTurnUsage` with chatId / runId / message-scoped keys.
   */
  turnCost: LocalTurnCostAccumulator
  getToolExecutor: () => Promise<typeof import('@/local-copilot/lib/tools/executor')>
  budget: SpecialistBudget
  parentDepth?: number
  /**
   * Outer specialist tool-call id (`file`, `workflow`, …). File Agent passes
   * bind Redis intents and live preview to this id so they match the subagent span.
   */
  parentDispatchToolCallId?: string
  /** Durable run id for authenticated confirmation gating. */
  runId?: string
  /**
   * Live event sink so confirmation UI / status can stream before the specialist
   * loop returns. Without this, `confirmation_required` is buffered until after
   * `waitForLocalToolConfirmation` finishes — the user never gets a chance to Approve.
   */
  onEvent?: (event: LocalCopilotStreamEvent) => void | Promise<void>
  /** Optional thinking-level override (file passes use a capped level). */
  thinkingLevel?: string
}

export interface SpecialistPassResult {
  domain: LocalCopilotSpecialistDomain
  findings: string
  toolRoundCount: number
  events: LocalCopilotStreamEvent[]
  success: boolean
  error?: string
  depth?: number
  structured?: SpecialistStructuredResult
  verifications?: VerificationRecord[]
  mutationOutcomes?: MutationOutcome[]
  pendingFollowUps?: MandatoryFollowUp[]
}

function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * Records a specialist stream event and forwards it live when `onEvent` is set.
 */
async function emitSpecialistEvent(
  events: LocalCopilotStreamEvent[],
  event: LocalCopilotStreamEvent,
  onEvent?: (event: LocalCopilotStreamEvent) => void | Promise<void>
): Promise<void> {
  events.push(event)
  await onEvent?.(event)
}

async function withTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ signal: AbortSignal; clear: () => void }> {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`Specialist timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const signal = parent
    ? mergeAbortSignals([parent, timeoutController.signal])
    : timeoutController.signal
  return { signal, clear: () => clearTimeout(timer) }
}

function buildSpecialistTools(
  domain: LocalCopilotSpecialistDomain,
  allTools: LocalCopilotToolDefinition[],
  depth: number,
  maxDepth: number
): LocalCopilotToolDefinition[] {
  const allowed = toolNamesForDomain(domain)
  // Never widen an empty domain filter to the full catalog — fall back to always-on leaves.
  const leafTools = filterToolsByNames(
    allTools,
    allowed.size > 0 ? allowed : new Set(ALWAYS_ON_TOOL_NAMES)
  )
  if (depth >= maxDepth) return leafTools
  const leafNames = new Set(leafTools.map((tool) => tool.name))
  const specialistTools = getParentSpecialistToolDefinitions().filter(
    (tool) => !leafNames.has(tool.name)
  )
  return [...leafTools, ...specialistTools]
}

export async function executeSpecialistLoop(
  params: RunSpecialistPassParams
): Promise<SpecialistPassResult> {
  const parentDepth = params.parentDepth ?? 0
  const entered = params.budget.tryEnter(parentDepth)
  if (!entered.ok) {
    return {
      domain: params.domain,
      findings: entered.reason,
      toolRoundCount: 0,
      events: [
        { type: 'status', message: `${params.domain} specialist skipped: ${entered.reason}` },
      ],
      success: false,
      error: entered.reason,
    }
  }

  const { signal, clear } = await withTimeoutSignal(
    params.signal,
    resolveSpecialistTimeoutMs(params.domain, params.budget.timeoutMs)
  )
  const events: LocalCopilotStreamEvent[] = []

  try {
    if (params.domain === 'general') {
      return {
        domain: params.domain,
        findings: '',
        toolRoundCount: 0,
        events,
        success: true,
        depth: entered.depth,
      }
    }

    const tools = buildSpecialistTools(
      params.domain,
      params.allTools,
      entered.depth,
      params.budget.maxDepth
    )
    if (tools.length === 0) {
      return {
        domain: params.domain,
        findings: '',
        toolRoundCount: 0,
        events,
        success: true,
        depth: entered.depth,
      }
    }

    await emitSpecialistEvent(events, { type: 'status', message: 'Thinking…' }, params.onEvent)

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are a focused Arena Copilot specialist (${params.domain}). ${domainSystemHint(params.domain)} Complete the request using your tools — you may perform domain writes when needed. You may call other specialist tools if another domain is required (nesting is budgeted). Keep the final reply under 8 sentences with actionable facts and outcomes.`,
      },
      ...(params.toolCtx.relevantSkillGuidance
        ? [{ role: 'system' as const, content: params.toolCtx.relevantSkillGuidance }]
        : []),
      { role: 'user', content: params.userMessage },
    ]

    const chatId = params.toolCtx.chatId
    if (chatId) {
      const checkpoint = await loadSpecialistCheckpoint(chatId, params.userId)
      if (checkpoint && checkpoint.domain === params.domain) {
        messages.push(formatSpecialistCheckpointSystemMessage(checkpoint))
        await emitSpecialistEvent(
          events,
          {
            type: 'status',
            message: `Resuming ${params.domain} specialist from checkpoint…`,
          },
          params.onEvent
        )
      }
    }

    const findings: string[] = []
    const mutationOutcomes: MutationOutcome[] = []
    const verifications: VerificationRecord[] = []
    const errors: string[] = []
    const debugToolRecords: ToolTurnRecord[] = []
    let toolRoundCount = 0
    let pendingFollowUps: MandatoryFollowUp[] = []
    let forcedFollowUpRounds = 0
    let forcedDebugExplanations = 0
    const persistFileIntentChannel =
      params.domain === 'file' && Boolean(params.parentDispatchToolCallId)
    let fileIntentChannelId = persistFileIntentChannel
      ? params.parentDispatchToolCallId
      : params.toolCtx.fileIntentChannelId

    const maxRounds = SPECIALIST_PASS_MAX_ROUNDS + MAX_SPECIALIST_FORCED_FOLLOW_UP_ROUNDS
    for (let round = 0; round < maxRounds; round++) {
      if (signal.aborted) break

      const pendingToolCalls: Array<{
        id: string
        name: string
        arguments: string
        thoughtSignature?: string
      }> = []
      let assistantText = ''
      let roundInputTokens = 0
      let roundOutputTokens = 0
      let roundGeminiModelParts: GeminiHistoryPart[] = []
      let roundReasoningContent = ''
      const roundAnthropicThinkingBlocks: AnthropicThinkingHistoryBlock[] = []

      try {
        for await (const chunk of params.provider.chatCompletionStream({
          model: params.model,
          messages,
          tools,
          maxTokens: resolveLocalCopilotMaxOutputTokens(params.model),
          signal,
          ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
        })) {
          if (chunk.type === 'text' && chunk.content) assistantText += chunk.content
          if (chunk.type === 'thinking' && chunk.content) {
            roundReasoningContent += chunk.content
          }
          if (chunk.type === 'thinking_block' && chunk.thinkingBlock) {
            roundAnthropicThinkingBlocks.push(chunk.thinkingBlock)
            if (chunk.thinkingBlock.type === 'thinking') {
              const suffix = unresolvedThinkingBlockText(
                roundReasoningContent,
                chunk.thinkingBlock.thinking
              )
              if (suffix) roundReasoningContent += suffix
            }
          }
          if (chunk.type === 'gemini_model_parts' && chunk.geminiModelParts) {
            roundGeminiModelParts = chunk.geminiModelParts
          }
          if (chunk.type === 'tool_call' && chunk.toolCall) pendingToolCalls.push(chunk.toolCall)
          if (chunk.type === 'done' && chunk.usage) {
            roundInputTokens = chunk.usage.inputTokens
            roundOutputTokens = chunk.usage.outputTokens
            params.turnCost.addModelUsage({
              model: params.model,
              inputTokens: roundInputTokens,
              outputTokens: roundOutputTokens,
              cacheReadTokens: chunk.usage.cacheReadTokens,
            })
          }
        }
      } catch (error) {
        logger.warn('Specialist pass model round failed', {
          domain: params.domain,
          round,
          error: getErrorMessage(error, 'specialist round failed'),
        })
        break
      }

      // Model cost is recorded from the stream `done` usage chunk above.

      logger.info('Arena Copilot specialist round finished', {
        domain: params.domain,
        depth: entered.depth,
        round,
        usageTurnId: params.usageTurnId,
        toolCallCount: pendingToolCalls.length,
        toolNames: pendingToolCalls.map((call) => call.name),
        budget: params.budget.snapshot(),
        memory: getLocalCopilotMemorySnapshot(),
      })

      if (pendingToolCalls.length === 0) {
        const canForceFollowUp =
          pendingFollowUps.length > 0 &&
          forcedFollowUpRounds < MAX_SPECIALIST_FORCED_FOLLOW_UP_ROUNDS
        if (canForceFollowUp) {
          forcedFollowUpRounds += 1
          messages.push({
            role: 'user',
            content: buildFollowUpContinuationMessage(pendingFollowUps),
          })
          logger.info('Arena Copilot specialist forcing mandatory follow-up', {
            domain: params.domain,
            round,
            forcedFollowUpRounds,
            pendingFollowUpIds: pendingFollowUps.map((item) => item.id),
          })
          continue
        }

        if (
          !assistantText.trim() &&
          debugToolRecords.length > 0 &&
          forcedDebugExplanations < MAX_SPECIALIST_DEBUG_EXPLANATION_ROUNDS &&
          round < maxRounds - 1
        ) {
          forcedDebugExplanations += 1
          // User role — Gemini rejects contents ending on a text-only model turn;
          // system nudges are folded into systemInstruction and would leave that ending.
          messages.push({
            role: 'user',
            content: buildDebugExplanationContinuationMessage(),
          })
          logger.info('Arena Copilot specialist forcing debug-explanation continuation', {
            domain: params.domain,
            round,
            forcedDebugExplanations,
            debugTools: debugToolRecords.map((record) => record.name),
          })
          continue
        }

        if (assistantText.trim()) {
          findings.push(assistantText.trim())
        } else if (debugToolRecords.length > 0) {
          // Model stopped after log tools with no prose — surface a real answer now.
          const synthesized = buildDebugInspectionChatAppendix(debugToolRecords)
          if (synthesized) {
            findings.push(synthesized)
            await emitSpecialistEvent(
              events,
              { type: 'text_delta', content: synthesized },
              params.onEvent
            )
          }
        }
        break
      }

      toolRoundCount += 1
      const ordered = sortToolCallsForExecution(pendingToolCalls)
      messages.push({
        role: 'assistant',
        content: assistantText,
        toolCalls: ordered,
        ...(roundAnthropicThinkingBlocks.length > 0
          ? { anthropicThinkingBlocks: roundAnthropicThinkingBlocks }
          : {}),
        ...(roundGeminiModelParts.length > 0 ? { geminiModelParts: roundGeminiModelParts } : {}),
        ...(roundReasoningContent.trim() ? { reasoningContent: roundReasoningContent } : {}),
      })

      for (const call of ordered) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(call.arguments || '{}') as Record<string, unknown>
        } catch {
          parsedArgs = {}
        }

        await emitSpecialistEvent(
          events,
          {
            type: 'tool_call_start',
            toolCallId: call.id,
            toolName: call.name,
            args: parsedArgs,
          },
          params.onEvent
        )

        if (isSpecialistTool(call.name)) {
          const childDomain = call.name as LocalCopilotCloudSpecialistDomain
          const nested = await executeSpecialistLoop({
            ...params,
            domain: childDomain,
            userMessage: buildSpecialistUserMessage(childDomain, parsedArgs, params.userMessage),
            signal,
            parentDepth: entered.depth,
            onEvent: params.onEvent,
            parentDispatchToolCallId: call.id,
          })
          for (const event of nested.events) events.push(event)

          const nestedOutput = {
            success: nested.success,
            domain: nested.domain,
            findings: nested.findings,
            ...(nested.error ? { error: nested.error } : {}),
          }
          findings.push(
            truncate(
              `[${call.name}] ${nested.success ? nested.findings : (nested.error ?? 'failed')}`,
              4_000
            )
          )
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: formatToolResultForLlm(call.name, nestedOutput, {
              artifactStore: params.toolCtx.artifactStore,
            }),
          })
          await emitSpecialistEvent(
            events,
            {
              type: 'tool_call_result',
              toolCallId: call.id,
              toolName: call.name,
              success: nested.success,
              output: nestedOutput,
              ...(nested.error ? { error: nested.error } : {}),
            },
            params.onEvent
          )
          continue
        }

        const confirmationRequirement = classifyLocalToolConfirmation(call.name, parsedArgs)
        let toolResult: ToolExecutionResult | undefined
        if (confirmationRequirement) {
          const confirmationReady = await prepareLocalToolConfirmation({
            runId: params.runId,
            toolCallId: call.id,
            toolName: call.name,
            args: parsedArgs,
            // Parent abort only — specialist budget timeout must not cancel Approve waits.
            abortSignal: params.signal,
          })
          if (confirmationReady) {
            await emitSpecialistEvent(
              events,
              {
                type: 'confirmation_required',
                toolCallId: call.id,
                toolName: call.name,
                requirement: confirmationRequirement,
              },
              params.onEvent
            )
          }
          const confirmationDecision = confirmationReady
            ? await waitForLocalToolConfirmation({
                toolCallId: call.id,
                // Parent abort only — users may take longer than SPECIALIST_TIMEOUT_MS to Approve.
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
                category: confirmationRequirement.category,
                message,
              },
              error: message,
            }
          }
        }

        const { executeLocalCopilotTool, refreshToolContext } = await params.getToolExecutor()
        if (!toolResult) {
          fileIntentChannelId = bindLocalFileIntentChannel(call.name, call.id, fileIntentChannelId)
          const toolStatus = runToolWithStatus({
            toolCallId: call.id,
            toolName: call.name,
            args: parsedArgs,
            // Tool execution uses parent abort so image/media gen can outlive specialist LLM budget.
            abortSignal: params.signal,
            execute: (onProgress) =>
              executeLocalCopilotTool(call.name, parsedArgs, {
                ...params.toolCtx,
                fileIntentChannelId,
                onProgress,
                activeToolCallId: call.id,
              }),
          })

          let next = await toolStatus.next()
          while (!next.done) {
            await emitSpecialistEvent(events, next.value, params.onEvent)
            next = await toolStatus.next()
          }
          toolResult = next.value
        }

        if (!persistFileIntentChannel) {
          fileIntentChannelId = clearLocalFileIntentChannel(call.name, fileIntentChannelId)
        }

        if (toolResult.createdWorkflowId) {
          params.toolCtx.workflowId = toolResult.createdWorkflowId
        } else if (call.name === 'edit_workflow' && toolResult.success) {
          const output =
            toolResult.result && typeof toolResult.result === 'object'
              ? (toolResult.result as Record<string, unknown>)
              : {}
          const resolvedWorkflowId =
            (typeof output.workflowId === 'string' && output.workflowId.trim()) ||
            (typeof parsedArgs.workflowId === 'string' && parsedArgs.workflowId.trim()) ||
            params.toolCtx.workflowId
          if (resolvedWorkflowId) {
            params.toolCtx.workflowId = resolvedWorkflowId
          }
        }

        if (
          toolRequiresWorkflowContextRefresh({
            toolName: call.name,
            success: toolResult.success,
            createdWorkflowId: toolResult.createdWorkflowId,
            result: toolResult.result,
          })
        ) {
          const refreshed = await refreshToolContext(params.toolCtx)
          params.toolCtx.structuredContext = refreshed.structuredContext
          params.toolCtx.workflowRevision = refreshed.workflowRevision
        }

        const llmPayload = formatToolResultForLlm(
          call.name,
          coalesceToolExecutionPayloadForLlm({
            success: toolResult.success,
            result: toolResult.result,
            error: toolResult.error,
            toolName: call.name,
          }),
          {
            artifactStore: params.toolCtx.artifactStore,
          }
        )
        const mandatoryFollowUp = detectMandatoryFollowUpFromExecution(
          call.name,
          toolResult.success,
          toolResult.result,
          llmPayload
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
        findings.push(truncate(`[${call.name}] ${llmPayload}`, 4_000))
        if (isDebugInspectionToolName(call.name)) {
          debugToolRecords.push({
            name: call.name,
            success: toolResult.success,
            result: toolResult.result,
            ...(toolResult.error ? { error: toolResult.error } : {}),
          })
        }
        if (!toolResult.success && toolResult.error) {
          errors.push(toolResult.error)
        }
        messages.push({ role: 'tool', toolCallId: call.id, content: llmPayload })
        await emitSpecialistEvent(
          events,
          {
            type: 'tool_call_result',
            toolCallId: call.id,
            toolName: call.name,
            success: toolResult.success,
            output: toolResult.result,
            ...(toolResult.error ? { error: toolResult.error } : {}),
            ...(toolResult.resources?.length ? { resources: toolResult.resources } : {}),
          },
          params.onEvent
        )

        if (mutationRequiresVerification(call.name)) {
          mutationOutcomes.push({ toolName: call.name, success: toolResult.success })
        }

        if (toolResult.success && mutationRequiresVerification(call.name)) {
          const verification = await runPostMutationVerification({
            toolCallId: call.id,
            toolName: call.name,
            mutationSuccess: true,
            mutationResult: toolResult.result,
            workflowId: params.toolCtx.workflowId,
            executeVerifier: async (verifierName, args) => {
              const verifierWorkflowId =
                typeof args.workflowId === 'string' && args.workflowId.trim()
                  ? args.workflowId.trim()
                  : params.toolCtx.workflowId
              return executeLocalCopilotTool(verifierName, args, {
                ...params.toolCtx,
                ...(verifierWorkflowId ? { workflowId: verifierWorkflowId } : {}),
              })
            },
          })
          if (verification) {
            verifications.push(verification)
            await emitSpecialistEvent(
              events,
              { type: 'verification_completed', record: verification },
              params.onEvent
            )
            if (verification.status === 'failed') {
              errors.push(`${verification.verifierToolName} failed for ${verification.toolName}`)
            }
          }
        }

        params.turnCost.addToolBilling({
          toolName: call.name,
          billing: toolResult.billing,
        })
      }
    }

    const findingsText = truncate(
      findings.filter(Boolean).join('\n\n'),
      SPECIALIST_FINDINGS_MAX_CHARS
    )

    if (signal.aborted && chatId) {
      await persistSpecialistCheckpoint(chatId, params.userId, {
        domain: params.domain,
        objective: truncate(params.userMessage, 280, ''),
        findings: findingsText,
        toolRound: toolRoundCount,
        updatedAt: new Date().toISOString(),
        status: 'paused',
      }).catch(() => undefined)
      return {
        domain: params.domain,
        findings: findingsText,
        toolRoundCount,
        events,
        success: false,
        error: 'Specialist aborted',
        depth: entered.depth,
        ...(pendingFollowUps.length > 0 ? { pendingFollowUps } : {}),
      }
    }

    if (chatId) {
      await clearSpecialistCheckpoint(chatId, params.userId).catch(() => undefined)
    }

    const structured = buildSpecialistStructuredResult({
      summaryFindings: findingsText,
      mutationOutcomes,
      verifications,
      errors,
    })

    return {
      domain: params.domain,
      findings: structured.findings,
      toolRoundCount,
      events,
      success: true,
      depth: entered.depth,
      structured,
      verifications,
      mutationOutcomes,
      ...(pendingFollowUps.length > 0 ? { pendingFollowUps } : {}),
    }
  } catch (error) {
    const message = getErrorMessage(error, 'specialist failed')
    logger.warn('Specialist loop failed', { domain: params.domain, error: message })
    await emitSpecialistEvent(
      events,
      { type: 'status', message: `${params.domain} specialist failed` },
      params.onEvent
    )
    return {
      domain: params.domain,
      findings: `Specialist (${params.domain}) failed: ${message}`,
      toolRoundCount: 0,
      events,
      success: false,
      error: message,
      depth: entered.depth,
    }
  } finally {
    clear()
    entered.release()
  }
}

/**
 * Runs a specialist pass while streaming events as they happen (including
 * confirmation prompts before the Approve wait).
 */
export async function* runSpecialistPass(
  params: RunSpecialistPassParams
): AsyncGenerator<LocalCopilotStreamEvent, SpecialistPassResult> {
  const liveEvents: LocalCopilotStreamEvent[] = []
  let wake: (() => void) | undefined
  let settled = false

  const resultPromise = executeSpecialistLoop({
    ...params,
    onEvent: async (event) => {
      liveEvents.push(event)
      await params.onEvent?.(event)
      wake?.()
    },
  }).then((result) => {
    settled = true
    wake?.()
    return result
  })

  while (!settled || liveEvents.length > 0) {
    if (liveEvents.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      continue
    }
    yield liveEvents.shift()!
  }

  return await resultPromise
}
