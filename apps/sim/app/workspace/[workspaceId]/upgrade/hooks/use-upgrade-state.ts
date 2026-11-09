'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@sim/emcn'
import { getErrorMessage } from '@sim/utils/errors'
import { useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/lib/api/client/request'
import { billingSwitchPlanContract } from '@/lib/api/contracts/subscription'
import type { WorkspaceHostContext } from '@/lib/api/contracts/workspaces'
import { isArenaBilling } from '@/lib/billing/arena/env'
import { isStarterPlan } from '@/lib/billing/arena/starter-plan'
import { ARENA_CREDIT_TIERS, isArenaMaxPlan } from '@/lib/billing/arena/tier-config'
import { useSubscriptionUpgrade } from '@/lib/billing/client/upgrade'
import { CREDIT_TIERS } from '@/lib/billing/constants'
import { getPlanTierCredits, isEnterprise, isFree, isPro, isTeam } from '@/lib/billing/plan-helpers'
import { useAwsMarketplaceBilling } from '@/hooks/queries/aws-marketplace'
import { invalidateWorkspaceUsage } from '@/hooks/queries/utils/invalidate-usage'
import { subscriptionKeys } from '@/hooks/queries/utils/subscription-keys'
import { workspaceHostKeys } from '@/hooks/queries/workspace-host'

const UPSTREAM_PRO_TIER = CREDIT_TIERS[0]
const UPSTREAM_MAX_TIER = CREDIT_TIERS[1]
const ARENA_PRO_TIER = ARENA_CREDIT_TIERS[0]
const ARENA_MAX_TIER = ARENA_CREDIT_TIERS[1]

type TargetPlan = 'pro' | 'team'

interface UseUpgradeStateOptions {
  hostContext: WorkspaceHostContext
  workspaceId: string
}

export interface UpgradeState {
  isLoading: boolean
  isAnnual: boolean
  setIsAnnual: (v: boolean) => void
  subscription: {
    isFree: boolean
    isPro: boolean
    isTeam: boolean
    isEnterprise: boolean
    isPaid: boolean
    /** True for Stripe-paid plans only — Starter is product-paid but not Stripe-paid. */
    isStripePaid: boolean
    isStarter: boolean
    isOrgScoped: boolean
    plan: string
    status: string
  }
  showUpgradePlans: boolean
  isArena: boolean
  billedThroughMarketplace: boolean
  /** How this workspace is billed could not be read, so plans stay hidden until a retry succeeds. */
  billingLookupFailed: boolean
  isRetryingBillingLookup: boolean
  retryBillingLookup: () => void
  proTier: { credits: number; dollars: number; name: string }
  maxTier: { credits: number; dollars: number; name: string }
  isOnPro: boolean
  isOnMax: boolean
  isOnMaxTier: boolean
  isOnStarter: boolean
  wantsIntervalSwitch: boolean
  /** True while annual/monthly interval switch is in flight. */
  isSwitchingInterval: boolean
  /** True while Stripe checkout or in-place plan upgrade is in flight. */
  isStartingCheckout: boolean
  /**
   * True while the signed-in session is still loading. Checkout CTAs should
   * stay disabled until this is false (and ideally until a user id is present).
   */
  isSessionPending: boolean
  /** True when the session query has a signed-in user. */
  hasAuthenticatedUser: boolean
  doUpgrade: (targetPlan: 'pro' | 'team', creditTier: number) => Promise<void>
  handleSwitchInterval: (interval: 'month' | 'year') => Promise<void>
  upgradeOrSwitchToMax: () => Promise<void>
  onUpgradeToOtherTier: () => Promise<void>
}

/**
 * Plan-selection state hook for the Upgrade page. Surfaces only what the plan
 * cards and billing-period toggle need: the resolved tier, upgrade/downgrade/
 * interval-switch handlers, and whether to show the upgrade plans at all.
 *
 * Plan and billing management (payment method, cancellation, invoices, usage
 * limits) lives on the Billing settings page, not here.
 */
export function useUpgradeState({
  hostContext,
  workspaceId,
}: UseUpgradeStateOptions): UpgradeState {
  const { handleUpgrade, isSessionPending, hasAuthenticatedUser } = useSubscriptionUpgrade()
  const queryClient = useQueryClient()
  const { ownerBilling } = hostContext
  const arenaBilling = isArenaBilling()
  const PRO_TIER = arenaBilling ? ARENA_PRO_TIER : UPSTREAM_PRO_TIER
  const MAX_TIER = arenaBilling ? ARENA_MAX_TIER : UPSTREAM_MAX_TIER
  const starter = isStarterPlan(ownerBilling.plan)
  const stripePaid = ownerBilling.isPaid && !starter
  const marketplace = useAwsMarketplaceBilling(hostContext.hostOrganizationId ?? null)

  const [isAnnual, setIsAnnual] = useState(!stripePaid || ownerBilling.billingInterval === 'year')
  const [isSwitchingInterval, setIsSwitchingInterval] = useState(false)
  const [isStartingCheckout, setIsStartingCheckout] = useState(false)
  /** Synchronous mutex — React state alone races before the next render. */
  const checkoutInFlightRef = useRef(false)
  const intervalInFlightRef = useRef(false)

  const subscription = {
    isFree: isFree(ownerBilling.plan) || starter,
    isPro: isPro(ownerBilling.plan),
    isTeam: isTeam(ownerBilling.plan),
    isEnterprise: isEnterprise(ownerBilling.plan),
    isPaid: ownerBilling.isPaid,
    isStripePaid: stripePaid,
    isStarter: starter,
    isOrgScoped: Boolean(hostContext.hostOrganizationId),
    plan: ownerBilling.plan,
    status: ownerBilling.status ?? 'inactive',
  }

  const isLegacyPlan = subscription.plan === 'pro' || subscription.plan === 'team'

  const beginCheckout = useCallback(() => {
    if (checkoutInFlightRef.current || intervalInFlightRef.current) return false
    checkoutInFlightRef.current = true
    setIsStartingCheckout(true)
    return true
  }, [])

  const endCheckout = useCallback(() => {
    checkoutInFlightRef.current = false
    setIsStartingCheckout(false)
  }, [])

  /**
   * Keeps the toggle aligned when the host context refreshes after a plan change.
   */
  useEffect(() => {
    if (subscription.isStripePaid) {
      setIsAnnual(ownerBilling.billingInterval === 'year')
    }
  }, [ownerBilling.billingInterval, subscription.isStripePaid])

  /**
   * A non-redirect plan switch settles server-side immediately, so every read that
   * describes the plan has to be refetched — the host context the page renders from,
   * the subscription/usage reads the billing surfaces share, the proration invoice the
   * switch just produced, and the workspace credit availability that drives the credits
   * chip and the run gate.
   */
  const refreshBillingState = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceHostKeys.detail(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.users() }),
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.usage() }),
        queryClient.invalidateQueries({ queryKey: subscriptionKeys.invoicesAll() }),
        invalidateWorkspaceUsage(queryClient),
      ]),
    [queryClient, workspaceId]
  )

  const doUpgrade = useCallback(
    async (targetPlan: TargetPlan, creditTier: number) => {
      if (!beginCheckout()) return
      try {
        await handleUpgrade(targetPlan, {
          creditTier,
          annual: isAnnual,
          ...(hostContext.hostOrganizationId
            ? { organizationId: hostContext.hostOrganizationId }
            : {}),
        })
        // Stripe navigation is in progress — keep CTAs locked until unload.
      } catch (error) {
        toast.error(getErrorMessage(error, 'Unknown error occurred'))
        endCheckout()
      }
    },
    [beginCheckout, endCheckout, handleUpgrade, hostContext.hostOrganizationId, isAnnual]
  )

  const currentInterval = ownerBilling.billingInterval

  const handleSwitchInterval = useCallback(
    async (interval: 'month' | 'year') => {
      if (isLegacyPlan) {
        throw new Error(
          'Interval switching is not available on legacy plans. Please upgrade first.'
        )
      }
      if (intervalInFlightRef.current || checkoutInFlightRef.current) return
      intervalInFlightRef.current = true
      setIsSwitchingInterval(true)
      try {
        await requestJson(billingSwitchPlanContract, {
          body: { targetPlanName: subscription.plan, interval, workspaceId },
        })
        // Optimistic: CTA "Current Plan" keys off host-context billingInterval.
        // Dev refetches can lag (or briefly return a stale column); patch the
        // cache and toggle immediately so the UI does not stick on "Switching…".
        setIsAnnual(interval === 'year')
        queryClient.setQueryData<WorkspaceHostContext>(
          workspaceHostKeys.detail(workspaceId),
          (previous) =>
            previous
              ? {
                  ...previous,
                  ownerBilling: { ...previous.ownerBilling, billingInterval: interval },
                }
              : previous
        )
        await refreshBillingState()
      } finally {
        intervalInFlightRef.current = false
        setIsSwitchingInterval(false)
      }
    },
    [isLegacyPlan, queryClient, refreshBillingState, subscription.plan, workspaceId]
  )

  const currentCredits = getPlanTierCredits(subscription.plan)
  const hasPaidPlan = stripePaid && (isPro(subscription.plan) || isTeam(subscription.plan))
  const isLegacyTeam = subscription.plan === 'team'
  const isOnKnownTier = currentCredits === PRO_TIER.credits || currentCredits === MAX_TIER.credits
  const isOnProTier =
    hasPaidPlan &&
    !isLegacyTeam &&
    (currentCredits === PRO_TIER.credits || (!isOnKnownTier && !subscription.isTeam))
  const isOnMaxTier =
    hasPaidPlan &&
    (currentCredits === MAX_TIER.credits ||
      isLegacyTeam ||
      isArenaMaxPlan(subscription.plan) ||
      (!isOnKnownTier && subscription.isTeam))
  const wantsIntervalSwitch =
    hasPaidPlan && !isLegacyPlan && isAnnual !== (currentInterval === 'year')
  const isOnPro = isOnProTier && !wantsIntervalSwitch
  const isOnMax = isOnMaxTier && !wantsIntervalSwitch

  const upgradeOrSwitchToMax = useCallback(async () => {
    // Starter has no Stripe subscription — always run a fresh checkout.
    if (starter || !stripePaid) {
      await doUpgrade(subscription.isOrgScoped ? 'team' : 'pro', MAX_TIER.credits)
      return
    }
    if (!beginCheckout()) return
    try {
      const planType = subscription.isTeam ? 'team' : 'pro'
      await requestJson(billingSwitchPlanContract, {
        body: {
          targetPlanName: `${planType}_${MAX_TIER.credits}`,
          interval: isAnnual ? 'year' : 'month',
          workspaceId,
        },
      })
      await refreshBillingState()
      endCheckout()
    } catch (e) {
      toast.error(getErrorMessage(e, 'Failed to upgrade'))
      endCheckout()
    }
  }, [
    beginCheckout,
    endCheckout,
    starter,
    stripePaid,
    doUpgrade,
    subscription.isOrgScoped,
    subscription.isTeam,
    MAX_TIER.credits,
    isAnnual,
    refreshBillingState,
    workspaceId,
  ])

  const onUpgradeToOtherTier = useCallback(async () => {
    if (starter || !stripePaid) {
      await doUpgrade(subscription.isOrgScoped ? 'team' : 'pro', PRO_TIER.credits)
      return
    }
    if (!beginCheckout()) return
    try {
      const onMax =
        getPlanTierCredits(subscription.plan) === MAX_TIER.credits ||
        subscription.plan === 'team' ||
        isArenaMaxPlan(subscription.plan)
      const targetTier = onMax ? PRO_TIER : MAX_TIER
      const planType = subscription.isTeam ? 'team' : 'pro'
      const targetPlanName = `${planType}_${targetTier.credits}`
      await requestJson(billingSwitchPlanContract, {
        body: { targetPlanName, workspaceId },
      })
      await refreshBillingState()
      endCheckout()
    } catch (e) {
      toast.error(getErrorMessage(e, 'Failed to switch plan'))
      endCheckout()
    }
  }, [
    beginCheckout,
    endCheckout,
    starter,
    stripePaid,
    doUpgrade,
    subscription.isOrgScoped,
    subscription.plan,
    subscription.isTeam,
    PRO_TIER,
    MAX_TIER,
    refreshBillingState,
    workspaceId,
  ])

  return {
    isLoading: false,
    isAnnual,
    setIsAnnual,
    subscription,
    showUpgradePlans:
      !subscription.isEnterprise && marketplace.isResolved && !marketplace.billedThroughMarketplace,
    isArena: arenaBilling,
    billedThroughMarketplace: marketplace.billedThroughMarketplace,
    billingLookupFailed: !marketplace.isResolved && marketplace.isError,
    isRetryingBillingLookup: marketplace.isRetrying,
    retryBillingLookup: marketplace.retry,
    proTier: PRO_TIER,
    maxTier: MAX_TIER,
    isOnPro,
    isOnMax,
    isOnMaxTier,
    isOnStarter: starter,
    wantsIntervalSwitch,
    isSwitchingInterval,
    isStartingCheckout,
    isSessionPending,
    hasAuthenticatedUser,
    doUpgrade,
    handleSwitchInterval,
    upgradeOrSwitchToMax,
    onUpgradeToOtherTier,
  }
}
