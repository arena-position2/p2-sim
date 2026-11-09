import { type NextRequest, NextResponse } from 'next/server'
import {
  clearDomainSessionCookiesGetContract,
  clearDomainSessionCookiesPostContract,
} from '@/lib/api/contracts/arena-auth'
import { parseRequest } from '@/lib/api/server'
import {
  buildComprehensiveSessionCookieClearHeaderValues,
  isHttpsForSecureSessionCookies,
} from '@/lib/auth/legacy-session-cookie-clears'
import { resolvePublicUrlHostnameForCookieClearing } from '@/lib/auth/session-cookie-domain'
import { getBaseUrl } from '@/lib/core/utils/urls'

/**
 * Clears session cookies for every scope Better Auth / browsers may have used: host-only,
 * `Domain=<NEXT_PUBLIC host>`, and parent `Domain` (e.g. `thearena.ai` / `.thearena.ai`) for
 * cross-subdomain session cookies. Host-only only on localhost.
 */
async function respond(
  request: NextRequest,
  contract:
    | typeof clearDomainSessionCookiesGetContract
    | typeof clearDomainSessionCookiesPostContract
) {
  const parsed = await parseRequest(contract, request, {})
  if (!parsed.success) return parsed.response
  const publicAppUrlIsHttps = getBaseUrl().startsWith('https://')
  const useHttps = isHttpsForSecureSessionCookies(request, publicAppUrlIsHttps)
  const hostname = resolvePublicUrlHostnameForCookieClearing()
  const res = NextResponse.json({
    ok: true,
    hostnamesCleared: hostname
      ? {
          fromNextPublicAppUrl: hostname,
          includeParentDomain: hostname.split('.').length >= 3,
        }
      : { mode: 'host-only' },
  })
  const lines = buildComprehensiveSessionCookieClearHeaderValues(hostname ?? 'localhost', useHttps)
  for (const value of lines) {
    res.headers.append('Set-Cookie', value)
  }
  return res
}

export function GET(request: NextRequest) {
  return respond(request, clearDomainSessionCookiesGetContract)
}

export function POST(request: NextRequest) {
  return respond(request, clearDomainSessionCookiesPostContract)
}
