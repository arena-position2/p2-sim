import { createLogger } from '@sim/logger'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { proxyImageContract } from '@/lib/api/contracts/proxy-image'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { getEnv } from '@/lib/core/config/env'

const logger = createLogger('FilesProxyImageAPI')

/**
 * Checks whether the target URL is allowed for proxying (same app host or Arena hosts).
 * Arena hosts are allowed for any path so that download/display can proxy when needed.
 */
function isLocalhostHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function isAllowedProxyUrl(targetUrl: URL, requestHost: string): boolean {
  if (isLocalhostHost(requestHost)) {
    return true
  }

  const appUrl = getEnv('NEXT_PUBLIC_APP_URL')
  if (!appUrl) return false
  try {
    const app = new URL(appUrl)
    if (targetUrl.host === app.host) return true
  } catch {
    return false
  }
  if (targetUrl.host.endsWith('.thearena.ai') || targetUrl.host === 'thearena.ai') {
    return true
  }
  return false
}

/**
 * GET /api/files/proxy-image?url=<encoded-full-url>
 * Proxies image requests to avoid cross-origin auth failures when the app runs
 * on one origin (e.g. localhost) but image URLs point to another (e.g. test-agent.thearena.ai).
 * Only allows URLs for the same app host or *.thearena.ai.
 */
export async function GET(request: NextRequest) {
  const parsed = await parseRequest(proxyImageContract, request, undefined, {
    validationErrorResponse: (error) =>
      NextResponse.json({ error: getValidationErrorMessage(error) }, { status: 400 }),
  })
  if (!parsed.success) return parsed.response
  const urlParam = parsed.data.query.url

  let targetUrl: URL
  try {
    targetUrl = new URL(urlParam)
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 })
  }

  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return NextResponse.json({ error: 'Invalid url protocol' }, { status: 400 })
  }

  if (!isAllowedProxyUrl(targetUrl, request.nextUrl.hostname)) {
    logger.warn('Proxy-image rejected: url not in allowed list', { host: targetUrl.host })
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const proxyToken = process.env.ARENA_IMAGE_PROXY_TOKEN
  const headers: Record<string, string> = {
    Accept: 'image/*',
    'User-Agent': request.headers.get('user-agent') ?? 'Sim-Proxy-Image',
  }
  if (proxyToken && (targetUrl.host.endsWith('.thearena.ai') || targetUrl.host === 'thearena.ai')) {
    headers.Authorization = `Bearer ${proxyToken}`
  } else {
    const cookie = request.headers.get('cookie')
    if (cookie) headers.Cookie = cookie
    const auth = request.headers.get('authorization')
    if (auth) headers.Authorization = auth
  }

  try {
    const res = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers,
      cache: 'default',
    })

    if (!res.ok) {
      logger.warn('Proxy-image upstream error', {
        status: res.status,
        url: targetUrl.toString(),
      })
      return NextResponse.json(
        { error: 'Upstream request failed' },
        { status: res.status === 401 ? 401 : 502 }
      )
    }

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    const body = res.body
    if (!body) {
      return NextResponse.json({ error: 'No body' }, { status: 502 })
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': res.headers.get('cache-control') ?? 'private, max-age=3600',
      },
    })
  } catch (err) {
    logger.error('Proxy-image fetch failed', { err, url: targetUrl.toString() })
    return NextResponse.json({ error: 'Proxy failed' }, { status: 502 })
  }
}
