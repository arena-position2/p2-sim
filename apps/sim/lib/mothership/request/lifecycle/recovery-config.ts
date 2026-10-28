import { z } from 'zod'
import { COPILOT_REQUEST_MODES } from '@/lib/mothership/constants'
import { ChatPayloadSchema } from '@/lib/mothership/generated/protocol'
import type { CopilotLifecycleOptions } from '@/lib/mothership/request/lifecycle/run'

export const BillingAdmissionSchema = z
  .object({
    billingRequestId: z.uuid(),
    serializedAttribution: z.string().min(1).max(32768),
  })
  .strict()

export type BillingAdmission = z.infer<typeof BillingAdmissionSchema>

/**
 * Start intent excludes transport credentials and receipts; takeover resolves those afresh.
 * `model` is the Arena Copilot catalog id. Hosted ChatRequest uses `modelSelection` and
 * rejects this key, so the Go dispatch drops it before the body leaves this process.
 */
export const DurableChatRequestSchema = ChatPayloadSchema.safeExtend({
  messageId: z.uuid(),
  chatId: z.uuid(),
  model: z.string().min(1).max(100).optional(),
}).transform(
  ({ byokApiKey, delegationToken, receivedTextChars, receivedActivity, ...request }) => request
)
export const StreamRecoveryConfigSchema = z
  .object({
    kind: z.literal('interactive_stream'),
    billingAdmission: BillingAdmissionSchema.optional(),
    request: DurableChatRequestSchema,
    goRoute: z.enum(['/api/mothership', '/api/copilot']),
    /**
     * Backend chosen for the admitted turn. Recovery must keep it: a Local turn
     * reattached to the worker has no run there and surfaces "Run not found".
     */
    copilotBackend: z.enum(['local', 'external']).optional(),
    clientToolPickupExpected: z.boolean(),
    userTimezone: z.string().optional(),
    requestMode: z.enum(COPILOT_REQUEST_MODES).optional(),
  })
  .strict()
  .refine(
    (config) =>
      !config.requestMode ||
      (!config.request.mode && config.requestMode !== 'assistant') ||
      (config.requestMode === 'build' ? 'agent' : config.requestMode) ===
        (config.request.mode ?? 'agent'),
    {
      message: 'Recovery mode must match the admitted request',
    }
  )

export function streamRecoveryConfig(
  options: CopilotLifecycleOptions,
  request: Record<string, unknown>
) {
  if (options.interactive !== true) return undefined
  return StreamRecoveryConfigSchema.parse({
    kind: 'interactive_stream',
    request,
    goRoute: options.goRoute ?? '/api/copilot',
    ...(options.copilotBackend ? { copilotBackend: options.copilotBackend } : {}),
    clientToolPickupExpected: options.clientToolPickupExpected ?? true,
    userTimezone: options.executionContext?.userTimezone,
    requestMode: options.executionContext?.requestMode,
  })
}
