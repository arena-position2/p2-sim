/**
 * Helper functions for subscription-related computations
 * These are pure functions that compute values from subscription data
 */

import {
  hasArenaMaxProductAccess,
  hasArenaTeamProductAccess,
  isArenaStarterProductAccess,
} from '@/lib/billing/arena/access'
import { DEFAULT_FREE_CREDITS } from '@/lib/billing/constants'
import { isFree, isPro } from '@/lib/billing/plan-helpers'
import { hasUsableSubscriptionAccess } from '@/lib/billing/subscriptions/utils'
import type { BillingStatus, SubscriptionData, UsageData } from './types'

const defaultUsage: UsageData = {
  current: 0,
  limit: DEFAULT_FREE_CREDITS,
  percentUsed: 0,
  isWarning: false,
  isExceeded: false,
  billingPeriodStart: null,
  billingPeriodEnd: null,
  lastPeriodCost: 0,
}

/**
 * Get subscription status flags from subscription data
 */
export function getSubscriptionStatus(
  subscriptionData: Partial<SubscriptionData> | null | undefined
) {
  return {
    isPaid: subscriptionData?.isPaid ?? false,
    isPro: subscriptionData?.isPro ?? false,
    isTeam: subscriptionData?.isTeam ?? false,
    isEnterprise: subscriptionData?.isEnterprise ?? false,
    isOrgScoped: subscriptionData?.isOrgScoped ?? false,
    organizationId: subscriptionData?.organizationId ?? null,
    isFree: !(subscriptionData?.isPaid ?? false),
    plan: subscriptionData?.plan ?? 'free',
    status: subscriptionData?.status ?? null,
    seats: subscriptionData?.seats ?? null,
    metadata: subscriptionData?.metadata ?? null,
  }
}

export function getSubscriptionAccessState(
  subscriptionData: Partial<SubscriptionData> | null | undefined
) {
  const status = getSubscriptionStatus(subscriptionData)
  const billingBlocked = Boolean(subscriptionData?.billingBlocked)
  const hasUsablePaidAccess =
    hasUsableSubscriptionAccess(status.status, billingBlocked) ||
    isArenaStarterProductAccess({
      plan: status.plan,
      status: status.status,
      periodEnd: subscriptionData?.periodEnd ?? null,
      billingBlocked,
    })
  const arenaAccessInput = {
    plan: status.plan,
    status: status.status,
    periodEnd: subscriptionData?.periodEnd ?? null,
    billingBlocked,
    isOrgScoped: status.isOrgScoped,
    hasPaidEntitlement: hasUsableSubscriptionAccess(status.status, billingBlocked),
  }
  const hasUsableTeamAccess = hasArenaTeamProductAccess(arenaAccessInput)
  const hasUsableMaxAccess = hasArenaMaxProductAccess(arenaAccessInput)
  const hasUsableEnterpriseAccess =
    hasUsablePaidAccess && (status.isEnterprise || (status.isTeam && hasUsableMaxAccess))

  return {
    ...status,
    billingBlocked,
    hasUsablePaidAccess,
    hasUsableTeamAccess,
    hasUsableEnterpriseAccess,
    hasUsableMaxAccess,
  }
}

/**
 * Get usage data from subscription data
 * Validates and sanitizes all numeric values to prevent crashes from malformed data
 */
export function getUsage(
  subscriptionData: Partial<SubscriptionData> | null | undefined
): UsageData {
  const usage = subscriptionData?.usage

  if (!usage) {
    return defaultUsage
  }

  return {
    current:
      typeof usage.current === 'number' && Number.isFinite(usage.current) ? usage.current : 0,
    limit:
      typeof usage.limit === 'number' && Number.isFinite(usage.limit)
        ? usage.limit
        : DEFAULT_FREE_CREDITS,
    percentUsed:
      typeof usage.percentUsed === 'number' && Number.isFinite(usage.percentUsed)
        ? usage.percentUsed
        : 0,
    isWarning: Boolean(usage.isWarning),
    isExceeded: Boolean(usage.isExceeded),
    billingPeriodStart: usage.billingPeriodStart ?? null,
    billingPeriodEnd: usage.billingPeriodEnd ?? null,
    lastPeriodCost:
      typeof usage.lastPeriodCost === 'number' && Number.isFinite(usage.lastPeriodCost)
        ? usage.lastPeriodCost
        : 0,
  }
}

/**
 * Get billing status based on usage and blocked state
 */
export function getBillingStatus(
  subscriptionData: Partial<SubscriptionData> | null | undefined
): BillingStatus {
  const usage = getUsage(subscriptionData)
  const blocked = subscriptionData?.billingBlocked
  if (blocked) return 'blocked'
  if (usage.isExceeded) return 'exceeded'
  if (usage.isWarning) return 'warning'
  return 'ok'
}

/**
 * Get remaining budget
 */
export function getRemainingBudget(
  subscriptionData: Partial<SubscriptionData> | null | undefined
): number {
  const usage = getUsage(subscriptionData)
  return Math.max(0, usage.limit - usage.current)
}

/**
 * Get days remaining in billing period
 */
export function getDaysRemainingInPeriod(
  subscriptionData: Partial<SubscriptionData> | null | undefined
): number | null {
  const usage = getUsage(subscriptionData)
  if (!usage.billingPeriodEnd) return null

  const now = new Date()
  const endDate =
    typeof usage.billingPeriodEnd === 'string'
      ? new Date(usage.billingPeriodEnd)
      : usage.billingPeriodEnd
  const diffTime = endDate.getTime() - now.getTime()
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

  return Math.max(0, diffDays)
}

/**
 * Check if subscription is at least Pro tier
 */
export function isAtLeastPro(
  subscriptionData: Partial<SubscriptionData> | null | undefined
): boolean {
  const status = getSubscriptionStatus(subscriptionData)
  return status.isPro || status.isTeam || status.isEnterprise
}

/**
 * Check if subscription is at least Team tier
 */
export function isAtLeastTeam(
  subscriptionData: Partial<SubscriptionData> | null | undefined
): boolean {
  const status = getSubscriptionStatus(subscriptionData)
  return status.isTeam || status.isEnterprise
}

export function canUpgrade(
  subscriptionData: Partial<SubscriptionData> | null | undefined
): boolean {
  const status = getSubscriptionStatus(subscriptionData)
  return isFree(status.plan) || isPro(status.plan)
}
