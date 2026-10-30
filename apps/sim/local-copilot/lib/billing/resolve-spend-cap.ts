import {
  checkOrganizationMemberUsageLimit,
  checkServerSideUsageLimits,
} from '@/lib/billing/calculations/usage-monitor'
import type { BillingAttributionSnapshot } from '@/lib/billing/core/attribution'
import { isBillingEnabled } from '@/lib/core/config/env-flags'
import type { SpendCapSnapshot } from '@/local-copilot/lib/billing/spend-cap'

const UNLIMITED_SPEND_CAP: SpendCapSnapshot = {
  isExceeded: false,
  currentUsage: 0,
  limit: Number.POSITIVE_INFINITY,
}

/**
 * Resolves the spend-cap snapshot for a Local Copilot turn.
 *
 * When mothership already passed billing attribution, check the billed account
 * via {@link checkServerSideUsageLimits} with no preloaded subscription so the
 * process-local UsageMonitor cache (warmed by mothership admission) can hit.
 * Member org caps are still enforced when an organization is present.
 */
export async function resolveLocalCopilotSpendCap(params: {
  userId: string
  billingAttribution?: BillingAttributionSnapshot
}): Promise<SpendCapSnapshot> {
  if (!isBillingEnabled) return UNLIMITED_SPEND_CAP

  try {
    if (params.billingAttribution) {
      const attribution = params.billingAttribution
      const payerPromise = checkServerSideUsageLimits(attribution.billedAccountUserId)
      const memberPromise = attribution.organizationId
        ? checkOrganizationMemberUsageLimit(attribution.actorUserId, attribution.organizationId, {
            start: new Date(attribution.billingPeriod.start),
            end: new Date(attribution.billingPeriod.end),
          })
        : null

      const payer = await payerPromise
      if (payer.isExceeded) {
        return {
          isExceeded: true,
          currentUsage: payer.currentUsage,
          limit: payer.limit,
          ...(payer.message ? { message: payer.message } : {}),
        }
      }

      if (memberPromise) {
        const memberUsage = await memberPromise
        if (memberUsage.isExceeded) {
          return {
            isExceeded: true,
            currentUsage: memberUsage.currentUsage,
            limit: memberUsage.limit ?? 0,
            ...(memberUsage.message ? { message: memberUsage.message } : {}),
          }
        }
      }

      return {
        isExceeded: false,
        currentUsage: payer.currentUsage,
        limit: payer.limit,
      }
    }

    return await checkServerSideUsageLimits(params.userId)
  } catch {
    return UNLIMITED_SPEND_CAP
  }
}
