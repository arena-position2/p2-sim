import { usageLog } from '@sim/db/schema'
import { billingCoreMock, billingCoreMockFns } from '@sim/testing/mocks/billing-core.mock'
import { billingUsageMock, billingUsageMockFns } from '@sim/testing/mocks/billing-usage.mock'
import {
  dbChainMockFns,
  drizzleOrmMock,
  queueTableRows,
  resetDbChainMock,
} from '@sim/testing/mocks/database.mock'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ON_DEMAND_UNLIMITED, USAGE_LEDGER_STATEMENT_TIMEOUT_MS } from '@/lib/billing/constants'

const { schemaTables } = vi.hoisted(() => ({
  schemaTables: {
    organizationMemberUsageLimit: {
      id: 'oml.id',
      organizationId: 'oml.organizationId',
      userId: 'oml.userId',
      usageLimit: 'oml.usageLimit',
      setBy: 'oml.setBy',
      createdAt: 'oml.createdAt',
      updatedAt: 'oml.updatedAt',
    },
    usageLog: {
      billingEntityType: 'usageLog.billingEntityType',
      billingEntityId: 'usageLog.billingEntityId',
      billingPeriodStart: 'usageLog.billingPeriodStart',
      billingPeriodEnd: 'usageLog.billingPeriodEnd',
      createdAt: 'usageLog.createdAt',
      cost: 'usageLog.cost',
      userId: 'usageLog.userId',
      workspaceId: 'usageLog.workspaceId',
    },
    workspace: {
      id: 'workspace.id',
      organizationAssignedAt: 'workspace.organizationAssignedAt',
      organizationId: 'workspace.organizationId',
    },
  },
}))

vi.mock('@sim/db/schema', () => schemaTables)
vi.mock('@/lib/billing/core/billing', () => billingCoreMock)
vi.mock('@/lib/billing/core/usage', () => billingUsageMock)

import { defaultBillingPeriod } from '@/lib/billing/core/billing-period'
import { dollarsToCredits } from '@/lib/billing/credits/conversion'
import {
  getOrgMemberUsageForBillingPeriod,
  getOrgMemberUsageForCurrentPeriod,
  setOrgMemberUsageLimit,
  validateOrgMemberAllocationWithinPool,
} from '@/lib/billing/organizations/member-limits'

const mockGetOrganizationSubscription = billingCoreMockFns.mockGetOrganizationSubscription
const mockGetOrgUsageLimit = billingUsageMockFns.mockGetOrgUsageLimit
const { eq: mockEq, gte: mockGte, isNull: mockIsNull, lt: mockLt, or: mockOr } = drizzleOrmMock

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  resetDbChainMock()
  mockGetOrgUsageLimit.mockResolvedValue({ limit: 2000 })
  mockGetOrganizationSubscription.mockResolvedValue({ plan: 'enterprise', seats: 1 })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  resetDbChainMock()
})

describe('getOrgMemberUsageForBillingPeriod', () => {
  it('counts immutable new rows plus bounded legacy rows exactly once', async () => {
    const billingPeriod = {
      start: new Date('2026-06-01T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
    }
    vi.spyOn(Date, 'now').mockReturnValue(billingPeriod.start.getTime())
    queueTableRows(usageLog, [{ cost: '4.5' }])
    mockGetOrganizationSubscription.mockResolvedValue({
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
    })

    await expect(
      getOrgMemberUsageForBillingPeriod('snapshot-org', 'actor-2', billingPeriod)
    ).resolves.toBe(4.5)

    /** The member sum is a ledger aggregate: it runs inside the bounded ledger transaction. */
    expect(dbChainMockFns.transaction).toHaveBeenCalledTimes(1)
    expect(
      dbChainMockFns.execute.mock.calls.some(([statement]) =>
        String((statement as { toSQL?: () => { sql: string } }).toSQL?.().sql).includes(
          `SET LOCAL statement_timeout = '${USAGE_LEDGER_STATEMENT_TIMEOUT_MS}ms'`
        )
      )
    ).toBe(true)

    expect(mockEq).toHaveBeenCalledWith('usageLog.billingEntityType', 'organization')
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingEntityId', 'snapshot-org')
    expect(mockEq).toHaveBeenCalledWith('usageLog.userId', 'actor-2')
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingPeriodStart', billingPeriod.start)
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingPeriodEnd', billingPeriod.end)
    expect(mockEq).toHaveBeenCalledWith('workspace.organizationId', 'snapshot-org')
    expect(mockIsNull).toHaveBeenCalledWith('usageLog.billingEntityType')
    expect(mockIsNull).toHaveBeenCalledWith('usageLog.billingEntityId')
    expect(mockIsNull).toHaveBeenCalledWith('workspace.organizationAssignedAt')
    expect(mockGte).toHaveBeenCalledWith('usageLog.createdAt', 'workspace.organizationAssignedAt')
    expect(mockGte).toHaveBeenCalledWith('usageLog.createdAt', billingPeriod.start)
    expect(mockLt).toHaveBeenCalledWith('usageLog.createdAt', billingPeriod.end)
    expect(dbChainMockFns.leftJoin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'workspace.id' }),
      expect.anything()
    )

    const mixedHistoryCall = mockOr.mock.calls.find(
      (conditions) =>
        conditions.length === 2 &&
        conditions.every(
          (condition) =>
            typeof condition === 'object' &&
            condition !== null &&
            'type' in condition &&
            condition.type === 'and'
        )
    )
    expect(mixedHistoryCall).toBeDefined()
    expect(mockGetOrganizationSubscription).not.toHaveBeenCalled()
  })

  it('uses only immutable same-organization ledger rows for a custom reporting window', async () => {
    const billingPeriod = {
      start: new Date('2025-08-13T00:00:00.000Z'),
      end: new Date('2026-08-13T00:00:00.000Z'),
      source: 'reporting' as const,
    }
    queueTableRows(usageLog, [{ cost: '18.25' }])

    await expect(
      getOrgMemberUsageForBillingPeriod('contract-org', 'actor-2', billingPeriod)
    ).resolves.toBe(18.25)

    expect(mockEq).toHaveBeenCalledWith('usageLog.userId', 'actor-2')
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingEntityType', 'organization')
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingEntityId', 'contract-org')
    expect(mockGte).toHaveBeenCalledWith('usageLog.createdAt', billingPeriod.start)
    expect(mockLt).toHaveBeenCalledWith('usageLog.createdAt', billingPeriod.end)
    expect(mockEq).not.toHaveBeenCalledWith('workspace.organizationId', 'contract-org')
    expect(mockIsNull).not.toHaveBeenCalledWith('usageLog.billingEntityType')
  })
})

describe('setOrgMemberUsageLimit', () => {
  it('upserts when given a dollar amount', async () => {
    await setOrgMemberUsageLimit('org-1', 'user-2', 2, 'admin-1')
    expect(dbChainMockFns.insert).toHaveBeenCalledTimes(1)
    expect(dbChainMockFns.delete).not.toHaveBeenCalled()
    const values = dbChainMockFns.values.mock.calls[0][0]
    expect(values).toMatchObject({
      organizationId: 'org-1',
      userId: 'user-2',
      usageLimit: '2',
      setBy: 'admin-1',
    })
    expect(dbChainMockFns.onConflictDoUpdate).toHaveBeenCalledTimes(1)
  })

  it('deletes the row when limit is null', async () => {
    await setOrgMemberUsageLimit('org-1', 'user-2', null, 'admin-1')
    expect(dbChainMockFns.delete).toHaveBeenCalledTimes(1)
    expect(dbChainMockFns.where).toHaveBeenCalledTimes(1)
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })
})

describe('validateOrgMemberAllocationWithinPool', () => {
  it('passes when the new allocation total is within the org pool', async () => {
    queueTableRows(schemaTables.organizationMemberUsageLimit, [
      { userId: 'user-3', usageLimit: '500' },
      { userId: 'user-2', usageLimit: '300' },
    ])

    await expect(validateOrgMemberAllocationWithinPool('org-1', 'user-2', 500)).resolves.toEqual({
      ok: true,
    })
  })

  it('replaces the target member limit instead of double-counting it', async () => {
    queueTableRows(schemaTables.organizationMemberUsageLimit, [
      { userId: 'user-2', usageLimit: '1500' },
    ])

    await expect(validateOrgMemberAllocationWithinPool('org-1', 'user-2', 500)).resolves.toEqual({
      ok: true,
    })
  })

  it('fails when allocated credits would exceed the org pool', async () => {
    queueTableRows(schemaTables.organizationMemberUsageLimit, [
      { userId: 'user-3', usageLimit: '1500' },
    ])

    const result = await validateOrgMemberAllocationWithinPool('org-1', 'user-2', 600)

    expect(result).toEqual({
      ok: false,
      allocatedCredits: dollarsToCredits(2100),
      orgPoolCredits: dollarsToCredits(2000),
    })
  })

  it('skips validation for on-demand unlimited org pools', async () => {
    mockGetOrgUsageLimit.mockResolvedValue({ limit: ON_DEMAND_UNLIMITED })

    await expect(validateOrgMemberAllocationWithinPool('org-1', 'user-2', 600)).resolves.toEqual({
      ok: true,
    })
  })
})

describe('getOrgMemberUsageForCurrentPeriod', () => {
  it('reads the enforcement usage definition over the org subscription window', async () => {
    const periodStart = new Date('2026-06-01T00:00:00.000Z')
    const periodEnd = new Date('2026-07-01T00:00:00.000Z')
    mockGetOrganizationSubscription.mockResolvedValue({ periodStart, periodEnd })
    queueTableRows(usageLog, [{ cost: '5' }])

    const result = await getOrgMemberUsageForCurrentPeriod('org-1', 'user-2')

    expect(result).toBe(5)
    expect(mockGetOrganizationSubscription).toHaveBeenCalledWith('org-1')
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingEntityId', 'org-1')
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingPeriodStart', periodStart)
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingPeriodEnd', periodEnd)
  })

  it('falls back to the all-time window when the org has no subscription period', async () => {
    queueTableRows(usageLog, [{ cost: '7' }])

    const result = await getOrgMemberUsageForCurrentPeriod('org-1', 'user-2', null)

    expect(result).toBe(7)
    expect(mockGetOrganizationSubscription).not.toHaveBeenCalled()
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingPeriodStart', defaultBillingPeriod().start)
    expect(mockEq).toHaveBeenCalledWith('usageLog.billingPeriodEnd', defaultBillingPeriod().end)
  })
})
