/**
 * @vitest-environment node
 */

import { getTimezoneOptions } from '@sim/utils/timezone'
import { describe, expect, it } from 'vitest'
import { mapArenaTimezone } from '@/lib/users/arena-timezone'

function resolvedTimezone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
}

describe('mapArenaTimezone', () => {
  it('matches Asia/Kolkata to the repo timezone list entry', () => {
    const mapped = mapArenaTimezone({ timeZone: 'Asia/Kolkata', country: 'India' })
    const listValue = resolvedTimezone('Asia/Kolkata')
    const option = getTimezoneOptions().find((item) => item.value === listValue)

    expect(mapped).toEqual({ timezone: listValue, label: option?.label })
    expect(mapped?.label).toMatch(/^(Kolkata|Calcutta) \(GMT\+05:30\)$/)
    expect(mapped?.timezone).not.toBe(mapped?.label)
  })

  it('canonicalizes Arena US links so the settings picker can select them', () => {
    expect(mapArenaTimezone({ timeZone: 'US/Eastern', country: 'United States' })?.timezone).toBe(
      'America/New_York'
    )
    expect(mapArenaTimezone({ timeZone: 'us/central' })?.timezone).toBe('America/Chicago')
    expect(mapArenaTimezone({ timeZone: 'US/Mountain' })?.timezone).toBe('America/Denver')
    expect(mapArenaTimezone({ timeZone: 'US/Pacific' })?.timezone).toBe('America/Los_Angeles')
    expect(mapArenaTimezone({ timeZone: 'US/Alaska' })?.timezone).toBe('America/Anchorage')
    expect(mapArenaTimezone({ timeZone: 'US/Hawaii' })?.timezone).toBe('Pacific/Honolulu')
  })

  it('uses country only when timezone is missing, and never invents a US default', () => {
    expect(mapArenaTimezone({ country: 'India ' })?.timezone).toBe(resolvedTimezone('Asia/Kolkata'))
    expect(mapArenaTimezone({ country: 'United Arab Emirates' })?.timezone).toBe('Asia/Dubai')
    expect(mapArenaTimezone({ country: 'United Kingdom' })?.timezone).toBe('Europe/London')
    expect(mapArenaTimezone({ country: 'United States' })).toBeNull()
  })

  it('does not fall back to country when the timezone cannot be mapped', () => {
    expect(mapArenaTimezone({ timeZone: 'Not/AZone', country: 'India' })).toBeNull()
    expect(mapArenaTimezone({})).toBeNull()
  })
})
