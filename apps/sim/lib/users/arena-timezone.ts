import type { TimezoneOption } from '@sim/utils/timezone'
import { getTimezoneOptions } from '@sim/utils/timezone'

/**
 * Maps Arena timezone and country selections onto the IANA timezone stored on
 * user settings. A timezone always wins. Country is used only when no timezone
 * is sent, and only for countries that have a single zone. The stored id is the
 * matching entry from this runtime's timezone list, so `Asia/Kolkata` persists
 * as `Asia/Calcutta` where that is the list value behind `Calcutta (GMT+05:30)`.
 */

/** Arena `US/*` links and catalog ids, keyed by a trimmed lowercase value. */
const ARENA_TIMEZONE_ALIASES: Record<string, string> = {
  'asia/kolkata': 'Asia/Kolkata',
  'asia/dubai': 'Asia/Dubai',
  'europe/paris': 'Europe/Paris',
  'europe/london': 'Europe/London',
  'pacific/auckland': 'Pacific/Auckland',
  'us/eastern': 'America/New_York',
  'us/central': 'America/Chicago',
  'us/mountain': 'America/Denver',
  'us/pacific': 'America/Los_Angeles',
  'us/alaska': 'America/Anchorage',
  'us/hawaii': 'Pacific/Honolulu',
}

/**
 * Single-zone countries from the Arena catalog. United States is omitted
 * because it spans several zones and must be sent as a timezone.
 */
const ARENA_COUNTRY_TIMEZONES: Record<string, string> = {
  india: 'Asia/Kolkata',
  'united arab emirates': 'Asia/Dubai',
  'united kingdom': 'Europe/London',
}

export interface ArenaTimezoneSelection {
  timeZone?: string | null
  country?: string | null
}

/** The settings timezone id, plus the label shown for that id in the repo picker. */
export interface MappedArenaTimezone {
  timezone: string
  label: string
}

function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Resolves a zone to the entry in this runtime's timezone list. `Asia/Kolkata`
 * becomes `Asia/Calcutta` when that is the id the picker uses.
 */
function toRepoTimezone(timeZone: string): MappedArenaTimezone | null {
  let resolved: string
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    return null
  }

  const option: TimezoneOption | undefined = getTimezoneOptions().find(
    (item) => item.value === resolved
  )
  if (!option) return null
  return { timezone: option.value, label: option.label }
}

/**
 * Resolves an Arena selection to a timezone from this repo's list, or `null`
 * when it cannot be mapped. A non-empty timezone is never replaced by country.
 * The display label is not stored; callers persist `timezone`.
 */
export function mapArenaTimezone({
  timeZone,
  country,
}: ArenaTimezoneSelection): MappedArenaTimezone | null {
  const zone = timeZone?.trim()
  if (zone) {
    return toRepoTimezone(ARENA_TIMEZONE_ALIASES[normalizeKey(zone)] ?? zone)
  }

  const countryName = country ? normalizeKey(country) : ''
  if (!countryName) return null
  const countryZone = ARENA_COUNTRY_TIMEZONES[countryName]
  return countryZone ? toRepoTimezone(countryZone) : null
}
