import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import {
  assertBillingAttributionSnapshot,
  type BillingAttributionSnapshot,
  resolveBillingAttribution,
  toBillingContext,
} from '@/lib/billing/core/attribution'
import { recordUsage } from '@/lib/billing/core/usage-log'
import type { ExecutionActor } from '@/lib/execution/actor-resolution'
import {
  buildLocalCopilotComponentEventKey,
  buildLocalCopilotTurnEventKey,
} from '@/local-copilot/lib/billing/event-keys'
import type { LocalTurnCostSummary } from '@/local-copilot/lib/billing/turn-cost-accumulator'

const logger = createLogger('LocalCopilotTurnBilling')

export interface RecordLocalCopilotTurnUsageParams {
  userId: string
  workspaceId: string
  workflowId?: string
  chatId?: string
  runId?: string
  conversationId?: string
  messageId: string
  summary: LocalTurnCostSummary
  executionActor?: ExecutionActor
  parentExecutionId?: string
  rootExecutionId?: string
  triggeringChatId?: string
  triggeringRunId?: string
  /**
   * Prefer the mothership-resolved snapshot when present so ledger writes match
   * the admission payer. Resolved from the workspace when omitted.
   */
  billingAttribution?: BillingAttributionSnapshot
}

/**
 * Writes one idempotent Local Arena Copilot turn to the ledger as component
 * rows (model + hosted tools). Excludes zero-cost turns. Child workflow cost
 * must already be excluded from `summary` by the accumulator.
 *
 * Passes vendor COGS as `cost`; `recordUsage` applies USAGE_LOG_COST_MULTIPLIER.
 */
export async function recordLocalCopilotTurnUsage(
  params: RecordLocalCopilotTurnUsageParams
): Promise<void> {
  if (params.summary.total <= 0 || params.summary.components.length === 0) {
    return
  }

  const turnEventKey = buildLocalCopilotTurnEventKey({
    messageId: params.messageId,
    chatId: params.chatId,
    conversationId: params.conversationId,
    workspaceId: params.workspaceId,
  })

  try {
    const attribution = params.billingAttribution
      ? assertBillingAttributionSnapshot(params.billingAttribution)
      : await resolveBillingAttribution({
          actorUserId: params.userId,
          workspaceId: params.workspaceId,
        })

    if (
      attribution.actorUserId !== params.userId ||
      attribution.workspaceId !== params.workspaceId
    ) {
      throw new Error('Local Copilot billing attribution does not match its actor and workspace')
    }

    const billingContext = toBillingContext(attribution)

    await recordUsage({
      userId: attribution.actorUserId,
      workspaceId: attribution.workspaceId,
      ...billingContext,
      workflowId: params.workflowId,
      chatId: params.chatId,
      runId: params.runId,
      executionActor: params.executionActor ?? {
        actorUserId: params.userId,
        actorType: 'user',
      },
      parentExecutionId: params.parentExecutionId,
      rootExecutionId: params.rootExecutionId ?? params.parentExecutionId,
      triggeringChatId: params.triggeringChatId ?? params.chatId,
      triggeringRunId: params.triggeringRunId ?? params.runId,
      entries: params.summary.components.map((component) => {
        const eventKey = buildLocalCopilotComponentEventKey({
          turnEventKey,
          component: component.kind,
          componentId: component.id,
        })
        return {
          category: component.kind === 'model' ? ('model' as const) : ('tool' as const),
          source: 'copilot' as const,
          description: component.id,
          cost: component.cost,
          eventKey,
          sourceReference: turnEventKey,
          metadata: {
            backend: 'local',
            ...(component.inputTokens != null ? { inputTokens: component.inputTokens } : {}),
            ...(component.outputTokens != null ? { outputTokens: component.outputTokens } : {}),
          },
          ...(component.provider ? { provider: component.provider } : {}),
          ...(component.vendor ? { vendor: component.vendor } : {}),
          ...(component.toolId ? { toolId: component.toolId } : {}),
          ...(params.chatId ? { chatId: params.chatId } : {}),
          ...(params.runId ? { runId: params.runId } : {}),
        }
      }),
    })
    logger.info('Recorded Local Arena Copilot turn usage', {
      userId: params.userId,
      workspaceId: params.workspaceId,
      chatId: params.chatId ?? null,
      runId: params.runId ?? null,
      messageId: params.messageId,
      turnEventKey,
      billingEntityType: billingContext.billingEntity.type,
      billingEntityId: billingContext.billingEntity.id,
      componentCount: params.summary.components.length,
      total: params.summary.total,
    })
  } catch (error) {
    logger.error('Failed to record Local Arena Copilot turn usage', {
      error: toError(error).message,
      userId: params.userId,
      workspaceId: params.workspaceId,
      chatId: params.chatId,
      messageId: params.messageId,
      total: params.summary.total,
    })
  }
}
