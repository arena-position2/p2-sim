import { describe, expect, it } from 'vitest'
import { STARTER_CREDITS } from '@/lib/billing/arena/constants'
import { ARENA_MAX_TIER } from '@/lib/billing/arena/tier-config'
import {
  ARENA_COMPARISON_SECTIONS,
  ARENA_PLAN_COLUMNS,
} from '@/lib/billing/arena/upgrade-comparison'

describe('Arena upgrade comparison overlay', () => {
  it('shows Starter, Max, and Enterprise — Pro stays off the comparison table', () => {
    expect(ARENA_PLAN_COLUMNS.map((column) => column.name)).toEqual([
      'Starter',
      'Max',
      'Enterprise',
    ])
    expect(ARENA_PLAN_COLUMNS.some((column) => column.name === 'Pro')).toBe(false)
  })

  it('prices Max as flat org dollars and Starter as included for one month', () => {
    const pricing = ARENA_COMPARISON_SECTIONS.find(
      (section) => section.title === 'Credits & pricing'
    )
    expect(pricing).toBeDefined()

    const monthlyCredits = pricing?.rows.find((row) => row.label === 'Monthly credits')
    const priceRow = pricing?.rows.find((row) => row.label === 'Pricing')

    expect(monthlyCredits?.values).toEqual([
      STARTER_CREDITS.toLocaleString('en-US'),
      ARENA_MAX_TIER.credits.toLocaleString('en-US'),
      'Custom',
    ])
    expect(priceRow?.values).toEqual([
      'Included for 1 month',
      `$${ARENA_MAX_TIER.dollars}/org`,
      'Custom',
    ])
  })
})
