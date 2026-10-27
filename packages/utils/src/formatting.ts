/**
 * Get a user-friendly timezone abbreviation
 * @param timezone - IANA timezone string
 * @param date - Date to check for DST
 * @returns A simplified timezone string (e.g., "PST" instead of "America/Los_Angeles")
 */
export function getTimezoneAbbreviation(timezone: string, date: Date = new Date()): string {
  if (timezone === 'UTC') return 'UTC'

  const timezoneMap: Record<string, { standard: string; daylight: string }> = {
    'America/Los_Angeles': { standard: 'PST', daylight: 'PDT' },
    'America/Denver': { standard: 'MST', daylight: 'MDT' },
    'America/Chicago': { standard: 'CST', daylight: 'CDT' },
    'America/New_York': { standard: 'EST', daylight: 'EDT' },
    'Europe/London': { standard: 'GMT', daylight: 'BST' },
    'Europe/Paris': { standard: 'CET', daylight: 'CEST' },
    'Asia/Tokyo': { standard: 'JST', daylight: 'JST' }, // Japan doesn't use DST
    'Australia/Sydney': { standard: 'AEST', daylight: 'AEDT' },
    'Asia/Singapore': { standard: 'SGT', daylight: 'SGT' }, // Singapore doesn't use DST
  }

  if (timezone in timezoneMap) {
    const januaryDate = new Date(date.getFullYear(), 0, 1)
    const julyDate = new Date(date.getFullYear(), 6, 1)

    const januaryFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    })

    const julyFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    })

    const isDSTObserved = januaryFormatter.format(januaryDate) !== julyFormatter.format(julyDate)

    if (isDSTObserved) {
      const currentFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short',
      })

      const isDST = currentFormatter.format(date) !== januaryFormatter.format(januaryDate)
      return isDST ? timezoneMap[timezone].daylight : timezoneMap[timezone].standard
    }

    return timezoneMap[timezone].standard
  }

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    }).formatToParts(date)
    return parts.find((p) => p.type === 'timeZoneName')?.value || timezone
  } catch {
    return timezone
  }
}

/**
 * Format a date into a human-readable format
 * @param date - The date to format
 * @param timezone - Optional IANA timezone string (e.g., 'America/Los_Angeles', 'UTC')
 * @returns A formatted date string in the format "MMM D, YYYY h:mm A"
 */
export function formatDateTime(date: Date, timezone?: string): string {
  const formattedDate = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone || undefined,
  })

  if (timezone) {
    const tzAbbr = getTimezoneAbbreviation(timezone, date)
    return `${formattedDate} ${tzAbbr}`
  }

  return formattedDate
}

/**
 * Parts for UI surfaces that need several date/time shapes from one instant.
 *
 * Stored API timestamps are UTC/ISO. These fields convert that instant into
 * wall-clock strings for the caller's IANA zone (`settings.timezone` via
 * `useTimezone()`). When `timezone` is omitted, the runtime local zone is used.
 *
 * Prefer {@link formatUserDateTime} over ad-hoc `toLocaleString` so logs and
 * other surfaces stay consistent when the account timezone changes.
 */
export interface UserDateTimeParts {
  /** `MMM D, YYYY, HH:mm:ss` (24h) */
  full: string
  /** `HH:mm:ss` (24h) */
  time: string
  /** Same as {@link UserDateTimeParts.time} */
  formatted: string
  /** `MMM D HH:mm:ss` */
  compact: string
  /** `MMM D` uppercased — used by the logs table date column */
  compactDate: string
  /** `h:mm AM/PM` — paired with {@link UserDateTimeParts.compactDate} in logs */
  compactTime: string
  /** Relative string such as `2h ago` (zone-independent; based on elapsed ms) */
  relative: string
}

/** Zero-pads a numeric clock field to two digits. */
function pad2(value: string | number): string {
  return String(value).padStart(2, '0')
}

/**
 * Reads calendar and clock fields for `date` in an optional IANA timezone.
 *
 * Uses `Intl.DateTimeFormat#formatToParts` so we can rebuild 12h and 24h
 * strings without depending on the host locale's combined format.
 */
function getZonedDateParts(
  date: Date,
  timezone?: string
): {
  year: string
  month: string
  day: string
  hour24: string
  hour12: string
  minute: string
  second: string
  dayPeriod: string
} {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone || undefined,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }

  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date)
  const byType = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  ) as Record<string, string>

  const hour12 = Number(byType.hour ?? '0')
  const dayPeriod = (byType.dayPeriod ?? 'AM').toUpperCase()
  const hour24 =
    dayPeriod === 'PM'
      ? String(hour12 === 12 ? 12 : hour12 + 12)
      : String(hour12 === 12 ? 0 : hour12)

  return {
    year: byType.year ?? '',
    month: byType.month ?? '',
    day: byType.day ?? '',
    hour24: pad2(hour24),
    hour12: String(hour12),
    minute: pad2(byType.minute ?? '0'),
    second: pad2(byType.second ?? '0'),
    dayPeriod,
  }
}

/**
 * Formats an instant for display in the user's timezone.
 *
 * Use this wherever UI shows a stored UTC/ISO timestamp as local wall time
 * (logs, activity, etc.). Pass the account preference IANA id from
 * `useTimezone()` / `settings.timezone`.
 *
 * @param input - ISO string, epoch ms, or `Date`
 * @param timezone - Optional IANA timezone (e.g. `America/New_York`). When
 *   omitted, uses the runtime local zone.
 */
export function formatUserDateTime(
  input: string | number | Date,
  timezone?: string
): UserDateTimeParts {
  const date = input instanceof Date ? input : new Date(input)

  if (Number.isNaN(date.getTime())) {
    const fallback = typeof input === 'string' ? input : String(input)
    return {
      full: fallback,
      time: fallback,
      formatted: fallback,
      compact: fallback,
      compactDate: fallback,
      compactTime: fallback,
      relative: 'just now',
    }
  }

  const iso = date.toISOString()
  const zoned = getZonedDateParts(date, timezone)
  const time = `${zoned.hour24}:${zoned.minute}:${zoned.second}`
  const compactDate = `${zoned.month} ${zoned.day}`.toUpperCase()
  const compactTime = `${zoned.hour12}:${zoned.minute} ${zoned.dayPeriod}`

  return {
    full: `${zoned.month} ${zoned.day}, ${zoned.year}, ${time}`,
    time,
    formatted: time,
    compact: `${zoned.month} ${zoned.day} ${time}`,
    compactDate,
    compactTime,
    relative: formatRelativeTime(iso),
  }
}

/**
 * Formats an instant as a single wall-clock string in `timezone`.
 *
 * Lighter alternative to {@link formatUserDateTime} when only one string is
 * needed (e.g. trace span start/end). Pass `useTimezone()` so the value tracks
 * the account preference instead of the browser device zone.
 *
 * @param input - ISO string, epoch ms, or `Date`
 * @param timezone - Optional IANA timezone from `useTimezone()` / settings
 * @param options.style - `datetime` (default), `date`, or `time`
 * @param options.hour12 - 12-hour clock when true (default); 24-hour when false
 */
export function formatInUserTimezone(
  input: string | number | Date,
  timezone?: string,
  options?: { style?: 'datetime' | 'date' | 'time'; hour12?: boolean }
): string {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) {
    return typeof input === 'string' ? input : String(input)
  }

  const style = options?.style ?? 'datetime'
  const hour12 = options?.hour12 ?? true

  if (style === 'date') {
    return date.toLocaleDateString('en-US', {
      timeZone: timezone || undefined,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  if (style === 'time') {
    return date.toLocaleTimeString('en-US', {
      timeZone: timezone || undefined,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12,
    })
  }

  return date.toLocaleString('en-US', {
    timeZone: timezone || undefined,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12,
  })
}

/**
 * Format a date into a short format
 * @param date - The date to format
 * @returns A formatted date string in the format "MMM D, YYYY"
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Format a duration to a human-readable format
 * @param duration - Duration in milliseconds (number) or as string (e.g., "500ms")
 * @param options - Optional formatting options
 * @param options.precision - Number of decimal places for seconds (default: 0), trailing zeros are stripped
 * @returns A formatted duration string, or null if input is null/undefined
 */
export function formatDuration(
  duration: number | string | undefined | null,
  options?: { precision?: number }
): string | null {
  if (duration === undefined || duration === null) {
    return null
  }

  // Parse string durations (e.g., "500ms", "0.44ms", "1234")
  let ms: number
  if (typeof duration === 'string') {
    ms = Number.parseFloat(duration.replace(/[^0-9.-]/g, ''))
    if (!Number.isFinite(ms)) {
      return duration
    }
  } else {
    ms = duration
    // Handle NaN/Infinity (e.g., cancelled blocks with no end time)
    if (!Number.isFinite(ms)) {
      return '\u2014'
    }
  }

  const precision = options?.precision ?? 0

  if (ms < 1) {
    // Zero or near-zero: show "0ms" instead of "0.00ms"
    if (ms === 0 || ms < 0.005) {
      return '0ms'
    }
    // Sub-millisecond: show with 2 decimal places
    return `${ms.toFixed(2)}ms`
  }

  if (ms < 1000) {
    // Milliseconds: round to integer
    return `${Math.round(ms)}ms`
  }

  const seconds = ms / 1000
  if (seconds < 60) {
    if (precision > 0) {
      // Strip trailing zeros (e.g., "5.00s" -> "5s", "5.10s" -> "5.1s")
      return `${seconds.toFixed(precision).replace(/\.?0+$/, '')}s`
    }
    return `${Math.floor(seconds)}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

/**
 * Formats a date string to relative time (e.g., "2h ago", "3d ago")
 * @param dateString - ISO date string to format
 * @returns A human-readable relative time string
 */
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (diffInSeconds < 60) {
    return 'just now'
  }
  if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60)
    return `${minutes}m ago`
  }
  if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600)
    return `${hours}h ago`
  }
  if (diffInSeconds < 604800) {
    const days = Math.floor(diffInSeconds / 86400)
    return `${days}d ago`
  }
  if (diffInSeconds < 2592000) {
    const weeks = Math.floor(diffInSeconds / 604800)
    return `${weeks}w ago`
  }
  if (diffInSeconds < 31536000) {
    const months = Math.floor(diffInSeconds / 2592000)
    return `${months}mo ago`
  }
  const years = Math.floor(diffInSeconds / 31536000)
  return `${years}y ago`
}
