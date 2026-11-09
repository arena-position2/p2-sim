'use client'

import { ChipModal, ChipModalBody, ChipModalFooter, ChipModalHeader } from '@sim/emcn'
import { CircleX } from '@sim/emcn/icons'
import { DEFAULT_BILLING_CONCURRENCY_LIMITS } from '@/lib/billing/concurrency-defaults'

/**
 * Features called out when canceling a paid plan. Matches the billing cancel
 * confirmation design (Max-tier entitlements users lose access to).
 */
export const CANCEL_PLAN_LOSS_FEATURES: readonly string[] = [
  `${DEFAULT_BILLING_CONCURRENCY_LIMITS.team.toLocaleString('en-US')} concurrent executions`,
  '60-minute run timeout',
  '100 GB of storage and unlimited tables',
  'Mailer & KB Live Sync',
  'Priority support',
]

interface CancelPlanModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Display name of the current paid plan, e.g. `"Max"`. */
  planName: string
  /** When true, show Arena Starter trial copy in the confirmation body. */
  isArena: boolean
  /** Invoked when the user confirms and should proceed to Stripe cancel. */
  onConfirmCancel: () => void
  /** True while the Stripe cancel redirect is being started. */
  isConfirming?: boolean
}

/**
 * Confirms plan cancellation before redirecting to Stripe. Keep stays in-app;
 * Continue to Cancel starts the existing Better Auth cancel flow.
 */
export function CancelPlanModal({
  open,
  onOpenChange,
  isArena,
  onConfirmCancel,
  isConfirming = false,
}: CancelPlanModalProps) {
  const bodyText = isArena
    ? "Starter is a one-time trial for new organizations, so you won't be able to switch back to it once you leave. Canceling ends your organization's access at the end of this billing period. You'll lose:"
    : "Canceling ends your access at the end of this billing period. You'll lose:"

  return (
    <ChipModal
      open={open}
      onOpenChange={onOpenChange}
      size='md'
      srTitle='Cancel your plan'
      dismissDisabled={isConfirming}
    >
      <ChipModalHeader onClose={() => onOpenChange(false)}>Cancel your plan?</ChipModalHeader>
      <ChipModalBody>
        <p className='break-words px-2 text-[var(--text-primary)] text-sm'>{bodyText}</p>
        <ul className='flex flex-col gap-2 px-2 pt-1'>
          {CANCEL_PLAN_LOSS_FEATURES.map((feature) => (
            <li key={feature} className='flex items-start gap-2 text-[var(--text-primary)] text-sm'>
              <CircleX className='mt-0.5 size-[14px] flex-shrink-0 text-[var(--text-error)]' />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </ChipModalBody>
      <ChipModalFooter
        hideCancel
        onCancel={() => onOpenChange(false)}
        cancelDisabled={isConfirming}
        primaryAdjacentAction={{
          label: isConfirming ? 'Redirecting…' : 'Continue to Cancel',
          onClick: onConfirmCancel,
          disabled: isConfirming,
        }}
        primaryAction={{
          label: `Keep Plan`,
          onClick: () => onOpenChange(false),
          disabled: isConfirming,
        }}
      />
    </ChipModal>
  )
}
