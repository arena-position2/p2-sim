import { describe, expect, it } from 'vitest'
import { deriveEnterpriseCreditLimits } from '@/lib/billing/enterprise-credit-limits'

describe('deriveEnterpriseCreditLimits', () => {
  it('adds prepaid credits above a higher configured usage base', () => {
    expect(
      deriveEnterpriseCreditLimits({
        metadata: {
          invoiceAmountCents: '99900',
          usageLimitCredits: '20000',
        },
        invoiceAmountUsd: 999,
        prepaidBalanceDollars: 10,
      })
    ).toEqual({
      configuredUsageLimitCredits: 20000,
      prepaidCredits: 650,
      effectiveUsageLimitCredits: 20650,
      effectiveUsageLimitDollars: '317.69230769230769231',
    })
  })

  it('uses the configured usage limit without an invoice-derived floor', () => {
    expect(
      deriveEnterpriseCreditLimits({
        metadata: {
          usageLimitCredits: '8000',
        },
        invoiceAmountUsd: 999,
        prepaidBalanceDollars: 10,
      }).effectiveUsageLimitCredits
    ).toBe(8650)
  })

  it('defaults the usage limit to the invoice amount when metadata is absent', () => {
    expect(
      deriveEnterpriseCreditLimits({
        metadata: {},
        invoiceAmountUsd: 50,
        prepaidBalanceDollars: 0,
      })
    ).toEqual({
      configuredUsageLimitCredits: 3250,
      prepaidCredits: 0,
      effectiveUsageLimitCredits: 3250,
      effectiveUsageLimitDollars: '50',
    })
  })

  it('preserves sub-credit prepaid residuals in the stored effective limit', () => {
    expect(
      deriveEnterpriseCreditLimits({
        metadata: {
          usageLimitCredits: '20000',
        },
        invoiceAmountUsd: 100,
        prepaidBalanceDollars: '0.001',
      })
    ).toMatchObject({
      prepaidCredits: 0,
      effectiveUsageLimitCredits: 20000,
      effectiveUsageLimitDollars: '307.69330769230769231',
    })
  })
})
