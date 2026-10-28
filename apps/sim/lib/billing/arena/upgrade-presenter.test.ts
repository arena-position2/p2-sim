import { describe, expect, it } from 'vitest'
import { STARTER_CREDITS } from '@/lib/billing/arena/constants'
import { ARENA_MAX_TIER, ARENA_PRO_TIER } from '@/lib/billing/arena/tier-config'
import {
  ARENA_MAX_PLAN_CREDITS,
  ARENA_PRO_PLAN_CREDITS,
  ARENA_STARTER_PLAN_CREDITS,
  getArenaPriceSubtext,
} from '@/lib/billing/arena/upgrade-presenter'

describe('Arena upgrade presenter', () => {
  it('surfaces Starter, Pro, and Max credit lines from the Arena tier catalog', () => {
    expect(ARENA_STARTER_PLAN_CREDITS.credits).toBe(
      `${STARTER_CREDITS.toLocaleString('en-US')} credits (1 month)`
    )
    expect(ARENA_PRO_PLAN_CREDITS.credits).toBe(
      `${ARENA_PRO_TIER.credits.toLocaleString('en-US')} credits/mo`
    )
    expect(ARENA_MAX_PLAN_CREDITS.credits).toBe(
      `${ARENA_MAX_TIER.credits.toLocaleString('en-US')} credits/mo`
    )
  })

  it('describes flat org pricing, never per-seat', () => {
    expect(getArenaPriceSubtext(false)).toBe('per org/month, billed monthly')
    expect(getArenaPriceSubtext(true)).toBe('per org/month, billed annually')
  })
})
