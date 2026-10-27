import { getEnv } from '@/lib/core/config/env'

type PlatformAdminEmailsEnv = string | string[] | undefined

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Parses `NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS` (array, JSON string array, or comma-separated).
 */
export function parsePlatformAdminEmails(raw: PlatformAdminEmailsEnv): string[] {
  if (!raw) return []

  if (Array.isArray(raw)) {
    return raw.map(normalizeEmail).filter(Boolean)
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return []

    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry): entry is string => typeof entry === 'string')
          .map(normalizeEmail)
          .filter(Boolean)
      }
    } catch {
      // Fall through to comma-separated parsing
    }

    return trimmed.split(',').map(normalizeEmail).filter(Boolean)
  }

  return []
}

/** True when the email is listed in `NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS`. */
export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const normalized = normalizeEmail(email)
  if (!normalized) return false
  return parsePlatformAdminEmails(getEnv('NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS')).includes(normalized)
}
