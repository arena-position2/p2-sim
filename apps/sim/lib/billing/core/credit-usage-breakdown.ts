import { dbReplica } from '@sim/db'
import { member, usageLog, user, workspace } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { isOrgAdminRole } from '@sim/platform-authz/predicates'
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import { ON_DEMAND_UNLIMITED } from '@/lib/billing/constants'
import { getOrganizationSubscription } from '@/lib/billing/core/billing'
import { defaultBillingPeriod } from '@/lib/billing/core/billing-period'
import {
  getHighestPrioritySubscription,
  resolveBillingInterval,
} from '@/lib/billing/core/subscription'
import { getOrgUsageLimit, getUserUsageData } from '@/lib/billing/core/usage'
import {
  COPILOT_USAGE_SOURCES,
  getBillingPeriodUsageCost,
  type UsageLogSource,
} from '@/lib/billing/core/usage-log'
import { apportionCredits, dollarsToCredits } from '@/lib/billing/credits/conversion'
import { computeWeeklyRefreshConsumed } from '@/lib/billing/credits/weekly-refresh'
import { getPlanWeeklyRefreshDollars, isPaid } from '@/lib/billing/plan-helpers'
import { isOrgScopedSubscription } from '@/lib/billing/subscriptions/utils'
import type { DbClient } from '@/lib/db/types'
import { ledgerOccurredAt } from '@/lib/workspaces/usage/ledger-helpers'

const logger = createLogger('CreditUsageBreakdown')

export interface CreditUsageBreakdownCredits {
  totalCredits: number
  mothershipCredits: number
  workflowCredits: number
  otherCredits: number
}

export interface MemberCreditUsageRow {
  userId: string
  userName: string
  userEmail: string
  totalCredits: number
  mothershipCredits: number
  workflowCredits: number
  otherCredits: number
}

export interface CreditUsageSummaryResult {
  scope: 'personal' | 'organization'
  viewer: 'solo' | 'org_member'
  billingPeriodStart: string | null
  billingPeriodEnd: string | null
  billingInterval: 'month' | 'year'
  summary: CreditUsageBreakdownCredits
  orgPool?: {
    totalCredits: number
    usedCredits: number
    isUnlimited: boolean
  }
  members?: MemberCreditUsageRow[]
}

interface DollarBreakdown {
  totalDollars: number
  mothershipDollars: number
  workflowDollars: number
  otherDollars: number
}

/**
 * Wall-clock window bounds on the coalesced ledger clock.
 * Use ISO strings — raw `Date` against a `sql` coalesce expr fails with ERR_INVALID_ARG_TYPE.
 * End is exclusive (`[start, end)`), matching subscription billing periods.
 */
function ledgerWindowBounds(window: { start: Date; end: Date }): [SQL, SQL] {
  const occurredAt = ledgerOccurredAt()
  const startIso = window.start.toISOString()
  const endIso = window.end.toISOString()
  return [
    sql`${occurredAt} >= ${startIso}::timestamptz`,
    sql`${occurredAt} < ${endIso}::timestamptz`,
  ]
}

function appendSourceFilter(conditions: SQL[], sources?: UsageLogSource | UsageLogSource[]) {
  if (!sources) return
  conditions.push(
    Array.isArray(sources) ? inArray(usageLog.source, sources) : eq(usageLog.source, sources)
  )
}

/**
 * Sums billable `usage_log` cost for a user inside an organization's workspaces
 * within a wall-clock window (subscription period), optionally filtered by source.
 *
 * Uses occurred_at/created_at — not billing_period_* column equality — so runs that
 * appear in Activity detail also reduce Remaining credits even when period stamps drift.
 */
async function sumOrgWorkspaceUsageBySource(
  organizationId: string,
  userId: string,
  window: { start: Date; end: Date },
  sources?: UsageLogSource | UsageLogSource[],
  executor: DbClient = dbReplica
): Promise<number> {
  const conditions = [
    eq(usageLog.userId, userId),
    eq(workspace.organizationId, organizationId),
    eq(usageLog.billable, true),
    ...ledgerWindowBounds(window),
  ]
  appendSourceFilter(conditions, sources)

  const [row] = await executor
    .select({ cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)` })
    .from(usageLog)
    .innerJoin(workspace, eq(workspace.id, usageLog.workspaceId))
    .where(and(...conditions))

  return Number.parseFloat(row?.cost ?? '0')
}

/**
 * Org-wide billable ledger sum for remaining-credits / admin Usage (all members).
 */
async function sumOrganizationWorkspaceUsageBySource(
  organizationId: string,
  window: { start: Date; end: Date },
  sources?: UsageLogSource | UsageLogSource[],
  executor: DbClient = dbReplica
): Promise<number> {
  const conditions = [
    eq(workspace.organizationId, organizationId),
    eq(usageLog.billable, true),
    ...ledgerWindowBounds(window),
  ]
  appendSourceFilter(conditions, sources)

  const [row] = await executor
    .select({ cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)` })
    .from(usageLog)
    .innerJoin(workspace, eq(workspace.id, usageLog.workspaceId))
    .where(and(...conditions))

  return Number.parseFloat(row?.cost ?? '0')
}

/**
 * Per-user billable ledger sums inside an org's workspaces for a wall-clock window.
 */
async function sumOrganizationWorkspaceUsageByUser(
  organizationId: string,
  window: { start: Date; end: Date },
  sources?: UsageLogSource | UsageLogSource[],
  executor: DbClient = dbReplica
): Promise<Map<string, number>> {
  const conditions = [
    eq(workspace.organizationId, organizationId),
    eq(usageLog.billable, true),
    ...ledgerWindowBounds(window),
  ]
  appendSourceFilter(conditions, sources)

  const rows = await executor
    .select({
      userId: usageLog.userId,
      cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)`,
    })
    .from(usageLog)
    .innerJoin(workspace, eq(workspace.id, usageLog.workspaceId))
    .where(and(...conditions))
    .groupBy(usageLog.userId)

  return new Map(rows.map((row) => [row.userId, Number.parseFloat(row.cost ?? '0')]))
}

function buildDollarBreakdown(params: {
  totalBaseline: number
  copilotBaseline: number
  totalLedger: number
  mothershipLedger: number
  workflowLedger: number
}): DollarBreakdown {
  const workflowBaseline = Math.max(0, params.totalBaseline - params.copilotBaseline)
  const mothershipDollars = params.copilotBaseline + params.mothershipLedger
  const workflowDollars = workflowBaseline + params.workflowLedger
  const totalDollars = params.totalBaseline + params.totalLedger
  const otherDollars = Math.max(0, totalDollars - mothershipDollars - workflowDollars)

  return {
    totalDollars,
    mothershipDollars,
    workflowDollars,
    otherDollars,
  }
}

function applyRefreshAndConvertToCredits(
  breakdown: DollarBreakdown,
  refreshDeduction: number
): CreditUsageBreakdownCredits {
  const effectiveTotal = Math.max(0, breakdown.totalDollars - refreshDeduction)
  if (breakdown.totalDollars <= 0 || refreshDeduction <= 0) {
    return toCreditBreakdown(breakdown, effectiveTotal)
  }

  const scale = effectiveTotal / breakdown.totalDollars
  return toCreditBreakdown(
    {
      totalDollars: effectiveTotal,
      mothershipDollars: breakdown.mothershipDollars * scale,
      workflowDollars: breakdown.workflowDollars * scale,
      otherDollars: breakdown.otherDollars * scale,
    },
    effectiveTotal
  )
}

function toCreditBreakdown(
  breakdown: DollarBreakdown,
  totalDollarsForApportion: number
): CreditUsageBreakdownCredits {
  const apportioned = apportionCredits([
    { key: 'mothership', dollars: breakdown.mothershipDollars },
    { key: 'workflow', dollars: breakdown.workflowDollars },
    { key: 'other', dollars: breakdown.otherDollars },
  ])

  return {
    totalCredits: dollarsToCredits(totalDollarsForApportion),
    mothershipCredits: apportioned.mothership,
    workflowCredits: apportioned.workflow,
    otherCredits: apportioned.other,
  }
}

async function getRefreshDeductionForOrg(
  organizationId: string,
  subscription: NonNullable<Awaited<ReturnType<typeof getOrganizationSubscription>>>,
  executor: DbClient
): Promise<number> {
  if (!isPaid(subscription.plan) || !subscription.periodStart) {
    return 0
  }

  const weeklyRefreshDollars = getPlanWeeklyRefreshDollars(subscription.plan)
  if (weeklyRefreshDollars <= 0) return 0

  return computeWeeklyRefreshConsumed(
    {
      billingEntity: { type: 'organization', id: organizationId },
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd ?? null,
      weeklyRefreshDollars,
      seats: subscription.seats || 1,
    },
    executor
  )
}

async function getOrganizationPoolSnapshot(
  organizationId: string,
  executor: DbClient
): Promise<CreditUsageSummaryResult['orgPool']> {
  const subscription = await getOrganizationSubscription(organizationId, { executor })
  const plan = subscription?.plan ?? 'free'
  const { limit: orgLimitDollars } = await getOrgUsageLimit(
    organizationId,
    plan,
    subscription?.seats ?? null,
    executor
  )
  const isUnlimited = orgLimitDollars >= ON_DEMAND_UNLIMITED

  const orgSummary = await getOrganizationCreditUsageSummary(organizationId, executor)
  const usedCredits = orgSummary?.summary.totalCredits ?? 0

  return {
    totalCredits: isUnlimited ? 0 : dollarsToCredits(orgLimitDollars),
    usedCredits,
    isUnlimited,
  }
}

async function getPersonalCreditUsageSummary(
  userId: string,
  organizationId: string | null,
  executor: DbClient,
  options?: { viewer?: 'solo' | 'org_member' }
): Promise<CreditUsageSummaryResult> {
  if (organizationId) {
    const subscription = await getOrganizationSubscription(organizationId, { executor })
    const billingPeriod =
      subscription?.periodStart && subscription?.periodEnd
        ? { start: subscription.periodStart, end: subscription.periodEnd }
        : defaultBillingPeriod()

    const [totalLedger, mothershipLedger, workflowLedger] = await Promise.all([
      sumOrgWorkspaceUsageBySource(organizationId, userId, billingPeriod, undefined, executor),
      sumOrgWorkspaceUsageBySource(
        organizationId,
        userId,
        billingPeriod,
        COPILOT_USAGE_SOURCES,
        executor
      ),
      sumOrgWorkspaceUsageBySource(organizationId, userId, billingPeriod, 'workflow', executor),
    ])

    const dollarBreakdown = buildDollarBreakdown({
      totalBaseline: 0,
      copilotBaseline: 0,
      totalLedger,
      mothershipLedger,
      workflowLedger,
    })

    const orgPool = await getOrganizationPoolSnapshot(organizationId, executor)

    return {
      scope: 'personal',
      viewer: options?.viewer ?? 'org_member',
      billingPeriodStart: billingPeriod.start.toISOString(),
      billingPeriodEnd: billingPeriod.end.toISOString(),
      billingInterval: resolveBillingInterval(subscription),
      summary: toCreditBreakdown(dollarBreakdown, dollarBreakdown.totalDollars),
      orgPool,
    }
  }

  const subscription = await getHighestPrioritySubscription(userId, { executor })
  const orgScoped = isOrgScopedSubscription(subscription, userId)
  const usageData = await getUserUsageData(
    userId,
    executor,
    orgScoped ? { personalAccount: true } : undefined
  )
  const billingPeriod =
    usageData.billingPeriodStart && usageData.billingPeriodEnd
      ? { start: usageData.billingPeriodStart, end: usageData.billingPeriodEnd }
      : defaultBillingPeriod()

  // Current-period usage lives on the ledger after user_stats dropped
  // currentPeriodCost / currentPeriodCopilotCost.
  const [totalLedger, mothershipLedger, workflowLedger] = await Promise.all([
    getBillingPeriodUsageCost({ type: 'user', id: userId }, billingPeriod, undefined, executor),
    getBillingPeriodUsageCost(
      { type: 'user', id: userId },
      billingPeriod,
      COPILOT_USAGE_SOURCES,
      executor
    ),
    getBillingPeriodUsageCost({ type: 'user', id: userId }, billingPeriod, 'workflow', executor),
  ])

  const dollarBreakdown = buildDollarBreakdown({
    totalBaseline: 0,
    copilotBaseline: 0,
    totalLedger,
    mothershipLedger,
    workflowLedger,
  })

  let refreshDeduction = 0
  if (subscription && isPaid(subscription.plan) && usageData.billingPeriodStart) {
    const weeklyRefreshDollars = getPlanWeeklyRefreshDollars(subscription.plan)
    if (weeklyRefreshDollars > 0) {
      refreshDeduction = await computeWeeklyRefreshConsumed(
        {
          billingEntity: { type: 'user', id: userId },
          periodStart: usageData.billingPeriodStart,
          periodEnd: usageData.billingPeriodEnd,
          weeklyRefreshDollars,
        },
        executor
      )
    }
  }

  return {
    scope: 'personal',
    viewer: 'solo',
    billingPeriodStart: usageData.billingPeriodStart?.toISOString() ?? null,
    billingPeriodEnd: usageData.billingPeriodEnd?.toISOString() ?? null,
    billingInterval: resolveBillingInterval(subscription),
    summary: applyRefreshAndConvertToCredits(dollarBreakdown, refreshDeduction),
  }
}

async function getOrganizationCreditUsageSummary(
  organizationId: string,
  executor: DbClient
): Promise<CreditUsageSummaryResult | null> {
  const subscription = await getOrganizationSubscription(organizationId, { executor })
  if (!subscription?.periodStart || !subscription.periodEnd) {
    return null
  }

  const billingPeriod = { start: subscription.periodStart, end: subscription.periodEnd }

  const membersWithStats = await executor
    .select({
      userId: member.userId,
      userName: user.name,
      userEmail: user.email,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, organizationId))

  const [
    usageByUser,
    mothershipByUser,
    workflowByUser,
    orgTotalLedger,
    orgMothershipLedger,
    orgWorkflowLedger,
  ] = await Promise.all([
    sumOrganizationWorkspaceUsageByUser(organizationId, billingPeriod, undefined, executor),
    sumOrganizationWorkspaceUsageByUser(
      organizationId,
      billingPeriod,
      COPILOT_USAGE_SOURCES,
      executor
    ),
    sumOrganizationWorkspaceUsageByUser(organizationId, billingPeriod, 'workflow', executor),
    sumOrganizationWorkspaceUsageBySource(organizationId, billingPeriod, undefined, executor),
    sumOrganizationWorkspaceUsageBySource(
      organizationId,
      billingPeriod,
      COPILOT_USAGE_SOURCES,
      executor
    ),
    sumOrganizationWorkspaceUsageBySource(organizationId, billingPeriod, 'workflow', executor),
  ])

  const memberRows: MemberCreditUsageRow[] = membersWithStats.map((memberRecord) => {
    const memberTotalLedger = usageByUser.get(memberRecord.userId) ?? 0
    const memberMothershipLedger = mothershipByUser.get(memberRecord.userId) ?? 0
    const memberWorkflowLedger = workflowByUser.get(memberRecord.userId) ?? 0

    const memberBreakdown = buildDollarBreakdown({
      totalBaseline: 0,
      copilotBaseline: 0,
      totalLedger: memberTotalLedger,
      mothershipLedger: memberMothershipLedger,
      workflowLedger: memberWorkflowLedger,
    })

    const memberCredits = toCreditBreakdown(memberBreakdown, memberBreakdown.totalDollars)

    return {
      userId: memberRecord.userId,
      userName: memberRecord.userName,
      userEmail: memberRecord.userEmail,
      ...memberCredits,
    }
  })

  memberRows.sort((a, b) => b.totalCredits - a.totalCredits)

  const orgDollarBreakdown = buildDollarBreakdown({
    totalBaseline: 0,
    copilotBaseline: 0,
    totalLedger: orgTotalLedger,
    mothershipLedger: orgMothershipLedger,
    workflowLedger: orgWorkflowLedger,
  })

  const refreshDeduction = await getRefreshDeductionForOrg(organizationId, subscription, executor)

  const summary = applyRefreshAndConvertToCredits(orgDollarBreakdown, refreshDeduction)

  const { limit: orgLimitDollars } = await getOrgUsageLimit(
    organizationId,
    subscription.plan,
    subscription.seats ?? null,
    executor
  )
  const isUnlimited = orgLimitDollars >= ON_DEMAND_UNLIMITED

  return {
    scope: 'organization',
    viewer: 'solo',
    billingPeriodStart: billingPeriod.start.toISOString(),
    billingPeriodEnd: billingPeriod.end.toISOString(),
    billingInterval: resolveBillingInterval(subscription),
    summary,
    orgPool: {
      totalCredits: isUnlimited ? 0 : dollarsToCredits(orgLimitDollars),
      usedCredits: summary.totalCredits,
      isUnlimited,
    },
    members: memberRows,
  }
}

/**
 * Credit usage summary for the billing page: org admins see pooled org usage plus
 * per-member rows unless `personal` is set, in which case they receive their own
 * usage plus the org pool. Everyone else sees only their own usage. Totals include
 * Mothership (copilot-family) and workflow-run consumption for the active period.
 */
export async function getCreditUsageSummary(params: {
  userId: string
  workspaceId: string
  /**
   * When true, skip the org-admin pooled summary and return the caller's own
   * usage (plus org pool) even if they are an admin or owner.
   */
  personal?: boolean
  executor?: DbClient
}): Promise<CreditUsageSummaryResult | null> {
  const executor = params.executor ?? dbReplica

  try {
    const [workspaceRow] = await executor
      .select({ organizationId: workspace.organizationId })
      .from(workspace)
      .where(eq(workspace.id, params.workspaceId))
      .limit(1)

    const organizationId = workspaceRow?.organizationId ?? null

    if (organizationId) {
      const [membership] = await executor
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, params.userId)))
        .limit(1)

      if (!membership) {
        return getPersonalCreditUsageSummary(params.userId, null, executor)
      }

      if (isOrgAdminRole(membership.role) && !params.personal) {
        return getOrganizationCreditUsageSummary(organizationId, executor)
      }

      return getPersonalCreditUsageSummary(params.userId, organizationId, executor)
    }

    return getPersonalCreditUsageSummary(params.userId, null, executor)
  } catch (error) {
    logger.error('Failed to build credit usage summary', {
      userId: params.userId,
      workspaceId: params.workspaceId,
      error,
    })
    throw error
  }
}
