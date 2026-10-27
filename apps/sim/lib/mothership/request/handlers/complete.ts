import { postStreamBillingUpdateCost } from '@/lib/copilot/request/billing/post-stream-update-cost'
import type { StreamHandler } from './types'
import { flushSubagentThinkingBlock, flushThinkingBlock } from './types'

export const handleCompleteEvent: StreamHandler = async (event, context, execContext) => {
  flushSubagentThinkingBlock(context)
  flushThinkingBlock(context)
  if (event.type !== 'complete') {
    context.streamComplete = true
    return
  }

  if (event.payload.usage) {
    context.usage = {
      prompt: (context.usage?.prompt || 0) + (event.payload.usage.input_tokens || 0),
      completion: (context.usage?.completion || 0) + (event.payload.usage.output_tokens || 0),
    }
  }

  if (event.payload.cost) {
    context.cost = {
      input: (context.cost?.input || 0) + (event.payload.cost.input || 0),
      output: (context.cost?.output || 0) + (event.payload.cost.output || 0),
      total: (context.cost?.total || 0) + (event.payload.cost.total || 0),
    }
  }

  context.completionStatus = event.payload.status
  context.streamComplete = true

  const cumulativeCost = context.cost?.total ?? 0
  if (cumulativeCost > 0 && execContext.userId) {
    await postStreamBillingUpdateCost({
      userId: execContext.userId,
      workspaceId: execContext.workspaceId,
      chatId: context.chatId ?? execContext.chatId,
      runId: context.runId ?? execContext.runId,
      messageId: context.messageId,
      goRoute: context.billingGoRoute ?? '/api/copilot',
      model: context.billingModel,
      cost: cumulativeCost,
      inputTokens: context.usage?.prompt,
      outputTokens: context.usage?.completion,
      ...(context.billingGoRoute?.startsWith('/api/mothership/execute') && execContext.executionId
        ? { parentExecutionId: execContext.executionId }
        : {}),
    })
  }
}
