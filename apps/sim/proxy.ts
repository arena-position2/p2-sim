import { createLogger } from '@sim/logger'
import { getSessionCookie } from 'better-auth/cookies'
import { type NextRequest, NextResponse } from 'next/server'
import { resolveSimMcpHostPath } from '@/lib/api/mcp/host-routing'
import { SIM_MCP_ROUTE_PATH } from '@/lib/api/mcp/urls'
import { APP_ENTRY_PATH, isNoindexPath } from '@/lib/navigation/paths'
import { isOAuthAuthorizationCallback, resolveAuthRedirect } from '@/app/(auth)/auth-redirect'
import { sendToProfound } from './lib/analytics/profound'
import {
  ARENA_SSO_SESSION_REQUIRED_PATH,
  buildArenaSimResumeUrl,
} from './lib/auth/arena-sim-resume'
import { getEnv } from './lib/core/config/env'
import { isAuthDisabled, isDev, isHosted, isLocalLoginEnabled } from './lib/core/config/env-flags'
import { apiCorsPatch } from './lib/core/security/api-cors'
import { generateRuntimeCSP } from './lib/core/security/csp'
import { getClientIp } from './lib/core/utils/request'
import { getLoginRedirectUrl, isSearchIndexableHost } from './lib/core/utils/urls'

const logger = createLogger('Proxy')

/**
 * No Better Auth session: send the browser to Arena hub to mint an SSO code.
 * Local login (dev, or NEXT_PUBLIC_LOCAL_LOGIN_ENABLED) falls back to `/login`.
 * Otherwise falls back to `/session-required` when the hub URL cannot be resolved.
 *
 * `returnTo` uses `NEXT_PUBLIC_APP_URL` + path — not `request.nextUrl.href`, which
 * becomes `https://0.0.0.0:3000/...` when the container sets `HOSTNAME=0.0.0.0`.
 */
function redirectUnauthenticated(request: NextRequest): NextResponse {
  if (isLocalLoginEnabled) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  const appBase = getEnv('NEXT_PUBLIC_APP_URL')?.trim()?.replace(/\/$/, '')
  const pathWithSearch = `${request.nextUrl.pathname}${request.nextUrl.search}`
  const returnTo = appBase ? new URL(pathWithSearch, `${appBase}/`).href : null
  const resume = returnTo ? buildArenaSimResumeUrl(returnTo, request.nextUrl.hostname) : null
  if (resume) {
    return NextResponse.redirect(resume)
  }
  return NextResponse.redirect(new URL(ARENA_SSO_SESSION_REQUIRED_PATH, request.url))
}

export interface CorsPolicy {
  origin: string
  credentials: boolean
  methods: string
  headers: string
  /** Response headers a browser client may read; omitted leaves the CORS default. */
  exposeHeaders?: string
}

/**
 * Every method the `/api` surface actually answers, for the default CORS policy.
 *
 * Hand-written rather than derived from the contract registry because this
 * module is edge middleware: importing `lib/api/contracts` would pull Zod and
 * the whole contract tree into the middleware bundle. Nothing enforces the
 * correspondence — the per-route `CORS_RULES` entries below are unenforced the
 * same way — so a contract that introduces a new method must add it here in the
 * same change. This list previously omitted `PATCH` while 17 v2 operations used
 * it, so a browser preflight for any of them failed.
 *
 * `HEAD` is included because Next answers it from each route's `GET` handler,
 * which the route builders permit via `methodMatchesContract`.
 */
const DEFAULT_API_ALLOWED_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS'

/**
 * Response headers the `/api` surface sets that a browser client must be able to read.
 *
 * Without `Access-Control-Expose-Headers` a browser can read only the six
 * CORS-safelisted response headers, so everything here is on the wire but
 * invisible to `fetch()` — the rate-limit budget, the retry delay a 429 or 503
 * asks the caller to observe, and the ids needed to correlate a run or a support
 * report. Server-to-server callers are unaffected, which is why the gap is easy
 * to miss.
 */
const DEFAULT_API_EXPOSED_HEADERS =
  'Retry-After, WWW-Authenticate, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Request-Id, X-Run-Id'

/**
 * Every API policy allows these. `X-Sim-Client-Info` is here rather than on one
 * policy because every official client sends it on every request.
 */
const BASE_API_ALLOWED_HEADERS = [
  'X-CSRF-Token',
  'X-Requested-With',
  'Accept',
  'Accept-Version',
  'Content-Length',
  'Content-MD5',
  'Content-Type',
  'Date',
  'X-Api-Version',
  'X-API-Key',
  'Authorization',
  'X-Sim-Client-Info',
] as const

function allowedHeaders(...extra: string[]): string {
  return [...BASE_API_ALLOWED_HEADERS, ...extra].join(', ')
}

const DEFAULT_API_ALLOWED_HEADERS = allowedHeaders()

const WORKFLOW_EXECUTE_HEADERS = allowedHeaders(
  'X-Execution-Id',
  'X-Execution-Mode',
  'X-Execution-Timeout-Seconds'
)

/** v2 execute: run identity and modes use the v2 wire names while streaming negotiates its protocol. */
const WORKFLOW_EXECUTE_V2_HEADERS = allowedHeaders('X-Run-Id', 'X-Sim-Stream-Protocol')

/** Subpaths under /api/chat/* that serve the workspace UI, not embeds. */
const EMBED_RESERVED_SEGMENTS = new Set(['manage', 'validate'])

/** True for /api/chat/[identifier] and any deeper subroute. */
function isEmbedPath(pathname: string): boolean {
  const segments = pathname.split('/')
  if (segments.length < 4) return false
  if (segments[1] !== 'api') return false
  if (segments[2] !== 'chat') return false
  const identifier = segments[3]
  if (!identifier || EMBED_RESERVED_SEGMENTS.has(identifier)) return false
  return true
}

interface CorsRule {
  match: (pathname: string) => boolean
  policy: (request: NextRequest) => CorsPolicy
}

const CORS_RULES: readonly CorsRule[] = [
  {
    match: (p) => p.startsWith('/api/auth/oauth2/'),
    policy: () => ({
      origin: '*',
      credentials: false,
      methods: 'GET, POST, OPTIONS',
      headers: 'Content-Type, Authorization, Accept',
    }),
  },
  {
    match: (p) => p.startsWith('/api/auth/.well-known/'),
    policy: () => ({
      origin: '*',
      credentials: false,
      methods: 'GET, OPTIONS',
      headers: 'Content-Type, Accept',
    }),
  },
  {
    match: (p) => p === '/api/mcp/copilot',
    policy: () => ({
      origin: '*',
      credentials: false,
      methods: 'GET, POST, OPTIONS, DELETE',
      headers: 'Content-Type, Authorization, X-API-Key, X-Requested-With, Accept',
    }),
  },
  {
    match: (p) => isEmbedPath(p),
    policy: (request) => {
      const requestOrigin = request.headers.get('origin')
      return {
        origin: requestOrigin || '*',
        credentials: !!requestOrigin,
        methods: 'GET, POST, PUT, OPTIONS',
        headers: 'Content-Type, X-Requested-With',
      }
    },
  },
  {
    match: (p) => /^\/api\/workflows\/[^/]+\/execute$/.test(p),
    policy: () => ({
      origin: '*',
      credentials: false,
      methods: 'GET,POST,OPTIONS,PUT',
      headers: WORKFLOW_EXECUTE_HEADERS,
    }),
  },
  {
    // Mirrors the v1 rule: public execute endpoints are wildcard-origin and
    // credential-free — the default credentialed policy would both block
    // browser API-key calls and open a cookie-bearing CSRF surface.
    match: (p) => /^\/api\/v2\/workflows\/[^/]+\/execute$/.test(p),
    policy: () => ({
      origin: '*',
      credentials: false,
      methods: 'POST,OPTIONS',
      headers: WORKFLOW_EXECUTE_V2_HEADERS,
    }),
  },
]

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value.trim()).origin
  } catch {
    const trimmed = value.trim().replace(/\/$/, '')
    return trimmed || null
  }
}

/** Arena hub (e.g. app.thearena.ai) may call agent APIs with credentials. */
function isAllowedArenaHubOrigin(requestOrigin: string, agentAppUrl: string): boolean {
  const normalized = normalizeOrigin(requestOrigin)
  if (!normalized) return false

  const allowed = new Set<string>()
  const add = (value: string | undefined | null) => {
    const origin = value ? normalizeOrigin(value) : null
    if (origin) allowed.add(origin)
  }

  add(agentAppUrl)
  add(getEnv('NEXT_PUBLIC_ARENA_FRONTEND_APP_URL'))
  add(getEnv('ARENA_FRONTEND_APP_URL'))
  getEnv('ALLOWED_ORIGINS')
    ?.split(',')
    .forEach((part) => add(part))

  try {
    add(getLoginRedirectUrl(new URL(agentAppUrl).hostname))
  } catch {
    // ignore invalid agent URL
  }

  return allowed.has(normalized)
}

function resolveDefaultApiCorsOrigin(request: NextRequest): string {
  const agentAppUrl = getEnv('NEXT_PUBLIC_APP_URL') || 'http://localhost:3001'
  const defaultOrigin = normalizeOrigin(agentAppUrl) ?? agentAppUrl.replace(/\/$/, '')
  const requestOrigin = request.headers.get('origin')
  if (requestOrigin && isAllowedArenaHubOrigin(requestOrigin, agentAppUrl)) {
    return normalizeOrigin(requestOrigin) ?? defaultOrigin
  }
  return defaultOrigin
}

/**
 * Single source of truth for /api/* CORS — resolved at request time, not baked at build.
 *
 * The exposed-header list is applied to every policy, matched rule or fallback,
 * because the headers it names are set by the same shared route machinery on
 * every route. A rule opts out by spelling `exposeHeaders: undefined`; carrying
 * the list per rule instead is how `/api/v2/workflows/{workflowId}/execute` — the only
 * route that emits `X-Run-Id`, and wildcard-origin precisely so browsers can
 * call it — ended up unable to hand a browser the run id or a 429's
 * `Retry-After`.
 */
export function resolveApiCorsPolicy(request: NextRequest): CorsPolicy {
  const { pathname } = request.nextUrl
  for (const rule of CORS_RULES) {
    if (rule.match(pathname)) {
      return { exposeHeaders: DEFAULT_API_EXPOSED_HEADERS, ...rule.policy(request) }
    }
  }
  return {
    origin: resolveDefaultApiCorsOrigin(request),
    credentials: true,
    methods: DEFAULT_API_ALLOWED_METHODS,
    headers: DEFAULT_API_ALLOWED_HEADERS,
    exposeHeaders: DEFAULT_API_EXPOSED_HEADERS,
  }
}

const CORS_PREFLIGHT_MAX_AGE = '86400'

function applyCorsHeaders(response: NextResponse, policy: CorsPolicy): void {
  response.headers.set('Access-Control-Allow-Origin', policy.origin)
  response.headers.set('Access-Control-Allow-Credentials', String(policy.credentials))
  response.headers.set('Access-Control-Allow-Methods', policy.methods)
  response.headers.set('Access-Control-Allow-Headers', policy.headers)
  if (policy.exposeHeaders) {
    response.headers.set('Access-Control-Expose-Headers', policy.exposeHeaders)
  }
  if (policy.origin !== '*') {
    response.headers.set('Vary', 'Origin')
  }
}

/** Next's auto-OPTIONS doesn't carry middleware headers, so we answer preflight here. */
function buildPreflightResponse(policy: CorsPolicy): NextResponse {
  const response = new NextResponse(null, { status: 204 })
  applyCorsHeaders(response, policy)
  response.headers.set('Access-Control-Max-Age', CORS_PREFLIGHT_MAX_AGE)
  return response
}

const SUSPICIOUS_UA_PATTERNS = [
  /^\s*$/, // Empty user agents
  /\.\./, // Path traversal attempt
  /<\s*script/i, // Potential XSS payloads
  /^\(\)\s*{/, // Command execution attempt
  /\b(sqlmap|nikto|gobuster|dirb|nmap)\b/i, // Known scanning tools
] as const

/**
 * Handles authentication-based redirects for root paths
 */
function handleRootPathRedirects(
  request: NextRequest,
  hasActiveSession: boolean
): NextResponse | null {
  const url = request.nextUrl

  if (url.pathname !== '/' || url.searchParams.has('home')) {
    return null
  }

  // `?home` is checked above — authenticated users reach APP_ENTRY; others follow
  // upstream self-hosted login redirect, then Arena SSO via redirectUnauthenticated.
  if (hasActiveSession) {
    return NextResponse.redirect(new URL(APP_ENTRY_PATH, request.url))
  }

  if (!isHosted && !isDev) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return redirectUnauthenticated(request)
}

/**
 * Handles invitation link redirects for unauthenticated users
 */
function handleInvitationRedirects(
  request: NextRequest,
  hasActiveSession: boolean
): NextResponse | null {
  if (!request.nextUrl.pathname.startsWith('/invite/')) {
    return null
  }

  if (
    !hasActiveSession &&
    !request.nextUrl.pathname.endsWith('/login') &&
    !request.nextUrl.pathname.endsWith('/signup') &&
    !request.nextUrl.search.includes('callbackUrl')
  ) {
    const token = request.nextUrl.searchParams.get('token')
    const inviteId = request.nextUrl.pathname.split('/').pop()
    const callbackPath = `/invite/${inviteId}${token ? `?token=${token}` : ''}`
    if (isLocalLoginEnabled) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('callbackUrl', callbackPath)
      loginUrl.searchParams.set('invite_flow', 'true')
      return NextResponse.redirect(loginUrl)
    }
    const hostname = request.nextUrl.hostname
    const externalLoginUrl = getLoginRedirectUrl(hostname)
    const loginUrl = new URL(externalLoginUrl)
    loginUrl.searchParams.set('callbackUrl', encodeURIComponent(callbackPath))
    loginUrl.searchParams.set('invite_flow', 'true')
    return NextResponse.redirect(loginUrl.toString())
  }
  const response = NextResponse.next()
  response.headers.set('Content-Security-Policy', generateRuntimeCSP())
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'SAMEORIGIN')
  return response
}

/**
 * Handles security filtering for suspicious user agents
 */
function handleSecurityFiltering(request: NextRequest): NextResponse | null {
  const userAgent = request.headers.get('user-agent') || ''
  const { pathname } = request.nextUrl
  const isWebhookEndpoint =
    pathname.startsWith('/api/webhooks/trigger/') ||
    pathname.startsWith('/api/webhooks/tiktok') ||
    pathname.startsWith('/api/webhooks/agentmail')
  const isMcpEndpoint = pathname.startsWith('/api/mcp/')
  const isMcpDiscoveryEndpoint =
    pathname.startsWith('/.well-known/oauth-authorization-server') ||
    pathname.startsWith('/.well-known/oauth-protected-resource') ||
    pathname === '/.well-known/openai-apps-challenge'
  const isSuspicious = SUSPICIOUS_UA_PATTERNS.some((pattern) => pattern.test(userAgent))

  // Block suspicious requests, but exempt machine-to-machine endpoints that may
  // legitimately omit User-Agent headers (webhooks and MCP protocol discovery/calls).
  if (isSuspicious && !isWebhookEndpoint && !isMcpEndpoint && !isMcpDiscoveryEndpoint) {
    // Scanner traffic (empty or tool user agents probing /admin.php etc.); the 403 is the response.
    logger.debug('Blocked suspicious request', {
      userAgent,
      ip: getClientIp(request),
      url: request.url,
      method: request.method,
      pattern: SUSPICIOUS_UA_PATTERNS.find((pattern) => pattern.test(userAgent))?.toString(),
    })

    return new NextResponse(null, {
      status: 403,
      statusText: 'Forbidden',
      headers: {
        'Content-Type': 'text/plain',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'",
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    })
  }

  return null
}

export function proxy(request: NextRequest) {
  const url = request.nextUrl

  const mcpPath = resolveSimMcpHostPath(request.headers.get('host'), url.pathname)
  if (mcpPath === 'not_found') return new NextResponse(null, { status: 404 })
  if (mcpPath && mcpPath !== url.pathname) {
    const rewrite = NextResponse.rewrite(new URL(`${mcpPath}${url.search}`, request.url))
    if (mcpPath !== SIM_MCP_ROUTE_PATH) return rewrite
    /** The endpoint keeps the `/api` CORS policy it has on the app host; its metadata sets its own. */
    const policy = resolveApiCorsPolicy(request)
    if (request.method === 'OPTIONS') return buildPreflightResponse(policy)
    applyCorsHeaders(rewrite, policy)
    return rewrite
  }

  if (url.pathname.startsWith('/api/')) {
    const policy = resolveApiCorsPolicy(request)
    if (request.method === 'OPTIONS') {
      return buildPreflightResponse(policy)
    }
    const response = NextResponse.next()
    applyCorsHeaders(response, policy)
    return response
  }

  const sessionCookie = getSessionCookie(request)
  const hasActiveSession = isAuthDisabled || !!sessionCookie

  if (url.pathname === '/session-required') {
    if (hasActiveSession) {
      return track(request, NextResponse.redirect(new URL('/workspace', request.url)))
    }
    return track(request, NextResponse.next())
  }

  const redirect = handleRootPathRedirects(request, hasActiveSession)
  if (redirect) return applyIndexingPolicy(request, redirect)

  if (url.pathname === '/login' || url.pathname === '/signup') {
    const { rawCallbackUrl } = resolveAuthRedirect({
      redirect: url.searchParams.get('redirect'),
      callbackUrl: url.searchParams.get('callbackUrl'),
      inviteFlow: url.searchParams.get('invite_flow'),
    })
    const isOAuthSignIn =
      isOAuthAuthorizationCallback(rawCallbackUrl, url.origin) && !isAuthDisabled
    if (hasActiveSession && !isOAuthSignIn) {
      return applyIndexingPolicy(
        request,
        NextResponse.redirect(new URL(APP_ENTRY_PATH, request.url))
      )
    }
    // Arena SSO resume unless this deployment serves the in-app login page
    if (!isLocalLoginEnabled) {
      return track(request, redirectUnauthenticated(request))
    }
    const response = NextResponse.next()
    response.headers.set('Content-Security-Policy', generateRuntimeCSP())
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('X-Frame-Options', 'SAMEORIGIN')
    return applyIndexingPolicy(request, response)
  }

  // `/chat/*` requires a Better Auth session, same as `/workspace` — Arena SSO
  // resume when missing (configured hub, e.g. app.thearena.ai /sso/sim-resume).
  if (url.pathname.startsWith('/chat/')) {
    if (!hasActiveSession) {
      return track(request, redirectUnauthenticated(request))
    }
    const response = NextResponse.next()
    response.headers.set('Content-Security-Policy', generateRuntimeCSP())
    response.headers.set('X-Content-Type-Options', 'nosniff')
    return track(request, response)
  }

  // Arena redirect SSO callback / error — no Better Auth session yet
  if (url.pathname === '/auth/arena-sso-callback' || url.pathname === '/auth/arena-sso-error') {
    return track(request, NextResponse.next())
  }

  if (url.pathname.startsWith('/workspace')) {
    if (!hasActiveSession) {
      return track(request, redirectUnauthenticated(request))
    }
    const response = NextResponse.next()
    response.headers.set('Content-Security-Policy', generateRuntimeCSP())
    response.headers.set('X-Content-Type-Options', 'nosniff')
    return track(request, response)
  }

  const invitationRedirect = handleInvitationRedirects(request, hasActiveSession)
  if (invitationRedirect) return applyIndexingPolicy(request, invitationRedirect)

  const securityBlock = handleSecurityFiltering(request)
  if (securityBlock) return applyIndexingPolicy(request, securityBlock)

  const response = NextResponse.next()
  response.headers.set('Vary', 'User-Agent')

  response.headers.set('Content-Security-Policy', generateRuntimeCSP())
  response.headers.set('X-Content-Type-Options', 'nosniff')

  return applyIndexingPolicy(request, response)
}

/**
 * Keeps non-production Arena agent hosts out of search results. Only
 * `agent.thearena.ai` is indexable. App and utility paths are noindex on every
 * host, including redirects, so a signed-out crawler bounced from
 * `/workspace/*` still sees the directive.
 *
 * `noindex` rather than a robots.txt `Disallow` is deliberate: a disallowed URL
 * can still be indexed when linked externally, and blocking the crawl stops
 * search engines from ever seeing the directive that removes pages already in
 * the index. robots.txt is excluded from this proxy's matcher so it keeps
 * serving the crawlable rules this header depends on.
 */
function applyIndexingPolicy(request: NextRequest, response: NextResponse): NextResponse {
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host') ||
    request.nextUrl.host

  if (!isSearchIndexableHost(host) || isNoindexPath(request.nextUrl.pathname)) {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  }

  return response
}

/**
 * Sends request data to Profound analytics (fire-and-forget) and returns the response.
 */
function track(request: NextRequest, response: NextResponse): NextResponse {
  applyIndexingPolicy(request, response)
  sendToProfound(request, response.status)
  return apiCorsPatch(request, response)
}

export const config = {
  matcher: [
    '/', // Root path for self-hosted redirect logic
    '/terms', // Whitelabel terms redirect
    '/privacy', // Whitelabel privacy redirect
    '/w', // Legacy /w redirect
    '/w/:path*', // Legacy /w/* redirects
    '/workspace/:path*', // New workspace routes
    '/home', // App entry
    '/o', // Organization surface
    '/o/:path*',
    '/login',
    '/signup',
    '/invite/:path*', // Match invitation routes
    '/session-required',
    '/auth/arena-sso-callback',
    '/auth/arena-sso-error',
    // Runtime CORS. The desktop's raw upload routes are left out: running the proxy makes Next
    // buffer the body, cutting it off at its 10 MB proxy limit, and those bodies are whole files.
    '/api/((?!desktop/tool/(?:import|file)$).*)',
    // Next's image optimizer fetches public editorial images without a User-Agent.
    '/((?!api/|api$|_next/static|_next/image|(?:blog|changelog)/.*\\.(?:avif|gif|jpe?g|png|svg|webp)$|ingest|favicon.ico|logo/|landing/|static/|footer/|social/|enterprise/|favicon/|twitter/|robots.txt|sitemap.xml).*)',
  ],
}
