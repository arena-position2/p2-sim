'use client'

import { Info } from '@sim/emcn'
import { useParams } from 'next/navigation'
import type { CreditUsageSummary } from '@/lib/api/contracts/billing-credit-usage'
import { ON_DEMAND_UNLIMITED } from '@/lib/billing/constants'
import { dollarsToCredits } from '@/lib/billing/credits/conversion'
import { BillingPersonalRemainingCreditsCard } from '@/app/workspace/[workspaceId]/settings/components/billing-usage/billing-remaining-credits-card'
import { BillingUsageSection } from '@/app/workspace/[workspaceId]/settings/components/billing-usage/billing-usage-section'
import { BillingUsageSourceRow } from '@/app/workspace/[workspaceId]/settings/components/billing-usage/billing-usage-source-row'
import {
  formatCreditCount,
  resolveOrgMemberCreditDisplay,
} from '@/app/workspace/[workspaceId]/settings/components/billing-usage/billing-usage-utils'
import { useBillingCreditUsage } from '@/hooks/queries/billing-credit-usage'
import { useMyMemberCredits } from '@/hooks/queries/organization'
import { useSubscriptionData } from '@/hooks/queries/subscription'

const USAGE_BY_SOURCE_TOOLTIP =
  'Mothership includes copilot, workspace chat, and related AI usage. Workflow runs covers workflow execution costs.'

interface UsageBillingStatsProps {
  /**
   * Organization tab always shows org-pool remaining.
   * User tab: personal allocation when set, otherwise the shared org pool.
   */
  view: 'user' | 'organization'
}

/**
 * Billing pool / remaining-credits stats for the Usage settings page.
 * Does not include activity detail — that stays on the existing Usage analytics UI.
 */
export function UsageBillingStats({ view }: UsageBillingStatsProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { data, isLoading } = useBillingCreditUsage(workspaceId, {
    // User tab: admins/owners get their own usage + org pool (same as members).
    personal: view === 'user',
    // Remaining credits should move after runs without waiting on a manual refresh.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 15 * 1000,
  })

  if (isLoading || !data) return null

  if (view === 'organization' && data.scope === 'organization') {
    return <OrgPoolRemainingCredits data={data} />
  }

  if (data.orgPool) {
    return <UserRemainingCredits data={data} workspaceId={workspaceId} />
  }

  return <PersonalBillingStats data={data} workspaceId={workspaceId} />
}

/**
 * User-tab remaining credits.
 * Used credits are this person's agent and workflow runs, counted with the
 * same billable ledger window as the organization pool. A personal cap, when
 * set, is the allowance; otherwise the allowance is the organization pool.
 */
function UserRemainingCredits({
  data,
  workspaceId,
}: {
  data: CreditUsageSummary
  workspaceId: string
}) {
  const { data: memberCredits, isPending: memberCreditsPending } = useMyMemberCredits(workspaceId)
  const orgPool = data.orgPool
  if (!orgPool) return null
  // Wait so a pending allocation does not flash the org pool first.
  if (memberCreditsPending) return null

  const allocatedCredits =
    memberCredits?.limitDollars != null ? dollarsToCredits(memberCredits.limitDollars) : null
  const memberUsedCredits = data.summary.totalCredits

  if (allocatedCredits == null) {
    const isUnlimited = orgPool.isUnlimited
    const totalCredits = isUnlimited ? null : orgPool.totalCredits
    const remainingCredits =
      isUnlimited || totalCredits == null ? null : Math.max(0, totalCredits - memberUsedCredits)

    return (
      <BillingPersonalRemainingCreditsCard
        totalCredits={totalCredits}
        usedCredits={memberUsedCredits}
        remainingCredits={remainingCredits}
        isUnlimited={isUnlimited}
        hint='in the organization pool'
        hideUsedStats
        barColorClassName='bg-emerald-500'
      />
    )
  }

  const display = resolveOrgMemberCreditDisplay({
    orgPool,
    allocatedCredits,
    memberUsedCredits,
  })

  const totalCredits = display.totalCredits === 'unlimited' ? null : display.totalCredits
  const remainingCredits =
    display.remainingCredits === 'unlimited' ? null : display.remainingCredits

  return (
    <BillingPersonalRemainingCreditsCard
      totalCredits={totalCredits}
      usedCredits={memberUsedCredits}
      remainingCredits={remainingCredits}
      isUnlimited={false}
      hint='allocated to you'
      hideUsedStats
      barColorClassName='bg-emerald-500'
    />
  )
}

function OrgPoolRemainingCredits({ data }: { data: CreditUsageSummary }) {
  const orgPool = data.orgPool
  const isUnlimited = orgPool?.isUnlimited ?? false
  const totalCredits = orgPool && !orgPool.isUnlimited ? orgPool.totalCredits : null
  const usedCredits = orgPool?.usedCredits ?? data.summary.totalCredits
  const remainingCredits =
    isUnlimited || totalCredits == null ? null : Math.max(0, totalCredits - usedCredits)

  return (
    <BillingPersonalRemainingCreditsCard
      totalCredits={totalCredits}
      usedCredits={usedCredits}
      remainingCredits={remainingCredits}
      isUnlimited={isUnlimited}
      hint='in the organization pool'
      hideUsedStats
      barColorClassName='bg-emerald-500'
    />
  )
}

function UsageBySourceSection({
  mothershipCredits,
  workflowCredits,
  totalCredits,
}: {
  mothershipCredits: number
  workflowCredits: number
  totalCredits: number
}) {
  const sourceDenominator = Math.max(totalCredits, 1)
  const mothershipPercent = (mothershipCredits / sourceDenominator) * 100
  const workflowPercent = (workflowCredits / sourceDenominator) * 100

  return (
    <BillingUsageSection
      label='Your usage by source'
      headerAccessory={
        <Info side='top' align='start' className='flex-shrink-0 text-[var(--text-icon)]'>
          {USAGE_BY_SOURCE_TOOLTIP}
        </Info>
      }
      action={
        <span className='text-[var(--text-muted)] text-small tabular-nums'>
          {formatCreditCount(totalCredits)} credits total
        </span>
      }
    >
      <div className='flex flex-col gap-4'>
        <BillingUsageSourceRow
          label='Mothership'
          credits={mothershipCredits}
          percent={mothershipPercent}
          badge='M'
          badgeClassName='bg-emerald-600'
          barClassName='bg-emerald-500'
        />
        <BillingUsageSourceRow
          label='Workflow runs'
          credits={workflowCredits}
          percent={workflowPercent}
          badge='W'
          badgeClassName='bg-violet-600'
          barClassName='bg-violet-500'
        />
      </div>
    </BillingUsageSection>
  )
}

function resolvePersonalAllowance(
  usageLimitDollars: number | undefined,
  memberLimitDollars: number | null | undefined
): { totalCredits: number | null; hint: string; isUnlimited: boolean } {
  if (memberLimitDollars != null) {
    return {
      totalCredits: dollarsToCredits(memberLimitDollars),
      hint: 'Your member credit cap',
      isUnlimited: false,
    }
  }

  if (usageLimitDollars != null && usageLimitDollars >= ON_DEMAND_UNLIMITED) {
    return {
      totalCredits: null,
      hint: 'On-demand usage enabled',
      isUnlimited: true,
    }
  }

  return {
    totalCredits: dollarsToCredits(usageLimitDollars ?? 0),
    hint: 'Included in your plan',
    isUnlimited: false,
  }
}

function PersonalBillingStats({
  data,
  workspaceId,
}: {
  data: CreditUsageSummary
  workspaceId: string
}) {
  const { data: subscriptionData } = useSubscriptionData({ workspaceId })
  const { data: memberCredits } = useMyMemberCredits(workspaceId)

  const consumed = data.summary.totalCredits
  const { totalCredits, hint, isUnlimited } = resolvePersonalAllowance(
    subscriptionData?.data?.usage?.limit,
    memberCredits?.limitDollars
  )
  const remaining =
    isUnlimited || totalCredits == null ? null : Math.max(0, totalCredits - consumed)

  return (
    <div className='flex flex-col gap-6'>
      <p className='text-[var(--text-muted)] text-small'>
        Near real-time. Credits reset with your billing cycle.
      </p>
      <BillingPersonalRemainingCreditsCard
        totalCredits={totalCredits}
        usedCredits={consumed}
        remainingCredits={remaining}
        isUnlimited={isUnlimited}
        hint={hint}
      />
      <UsageBySourceSection
        mothershipCredits={data.summary.mothershipCredits}
        workflowCredits={data.summary.workflowCredits}
        totalCredits={consumed}
      />
    </div>
  )
}
