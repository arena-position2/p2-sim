import { describe, expect, it } from 'vitest'
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatInUserTimezone,
  formatUserDateTime,
  getTimezoneAbbreviation,
} from './formatting.js'

describe('getTimezoneAbbreviation', () => {
  it('resolves a valid IANA timezone outside the hardcoded map via Intl instead of the raw string', () => {
    const result = getTimezoneAbbreviation('Europe/Berlin', new Date('2023-01-15'))
    expect(result).not.toBe('Europe/Berlin')
  })

  it('returns PST or PDT for Los Angeles', () => {
    const result = getTimezoneAbbreviation('America/Los_Angeles', new Date('2023-01-15'))
    expect(['PST', 'PDT']).toContain(result)
  })
})

describe('formatDateTime', () => {
  it('formats a date with time', () => {
    const date = new Date('2023-05-15T14:30:00')
    const result = formatDateTime(date)
    expect(result).toMatch(/May 15, 2023/)
  })

  it('appends timezone abbreviation when timezone is provided', () => {
    const date = new Date('2023-05-15T14:30:00Z')
    const result = formatDateTime(date, 'UTC')
    expect(result).toContain('UTC')
  })
})

describe('formatUserDateTime', () => {
  it('renders wall clock fields in the given timezone', () => {
    const result = formatUserDateTime('2023-05-15T18:30:00Z', 'America/New_York')
    // 18:30 UTC → 14:30 EDT in May
    expect(result.compactTime).toBe('2:30 PM')
    expect(result.time).toBe('14:30:00')
    expect(result.compactDate).toBe('MAY 15')
    expect(result.compact).toBe('May 15 14:30:00')
  })

  it('renders UTC when timezone is UTC', () => {
    const result = formatUserDateTime('2023-05-15T18:30:45Z', 'UTC')
    expect(result.time).toBe('18:30:45')
    expect(result.compactTime).toBe('6:30 PM')
  })
})

describe('formatInUserTimezone', () => {
  it('formats datetime in the given timezone', () => {
    const result = formatInUserTimezone('2023-05-15T18:30:00Z', 'UTC')
    expect(result).toMatch(/May 15, 2023/)
    expect(result).toMatch(/6:30\s*PM/i)
  })

  it('formats time only when style is time', () => {
    const result = formatInUserTimezone('2023-05-15T18:30:00Z', 'UTC', { style: 'time' })
    expect(result).toMatch(/6:30:00\s*PM/i)
  })
})

describe('formatDate', () => {
  it('formats a date without time', () => {
    const date = new Date('2023-05-15T14:30:00')
    const result = formatDate(date)
    expect(result).toMatch(/May 15, 2023/)
    expect(result).not.toMatch(/14:30/)
  })
})

describe('formatDuration', () => {
  it('formats sub-millisecond durations', () => {
    expect(formatDuration(0.5)).toBe('0.50ms')
    expect(formatDuration(0.001)).toBe('0ms')
  })
})
