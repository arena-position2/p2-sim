import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { semrushQueryContract } from '@/lib/api/contracts/tools/semrush'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'

const logger = createLogger('SemrushQueryAPI')

const INVALID_SEMRUSH_TYPES = new Set(['', 'semrush_query', 'semrush_organic_positions', 'semrush'])

function sanitizeDomainQueryParam(raw: string): string {
  const t = raw.trim()
  if (!t) return t
  const m = t.match(/^([a-zA-Z0-9](?:[a-zA-Z0-9-]*\.)+[a-zA-Z]{2,})/)
  if (m && m[1].length < t.length) {
    logger.warn('Semrush proxy: sanitized domain query param', { raw: t, domain: m[1] })
    return m[1]
  }
  return t
}

function coerceSemrushTypeParam(
  typeParam: string | null,
  domain: string | null,
  url: string | null
): string {
  const raw = (typeParam ?? 'domain_organic').trim().toLowerCase()
  if (!INVALID_SEMRUSH_TYPES.has(raw) && /^[a-z][a-z0-9_]*$/.test(raw)) {
    return raw
  }
  const d = (domain ?? '').trim()
  const u = (url ?? '').trim()
  if (d && !u) return 'domain_organic'
  if (u && !d) return 'url_organic'
  if (d && u) return 'domain_organic'
  return 'domain_organic'
}

/**
 * Proxies Semrush API requests so the tool hits our server (avoiding external URL
 * validation) and we add the API key server-side. Accepts internal JWT (executor)
 * or session auth so both server-to-server and same-origin requests work.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await checkSessionOrInternalAuth(request, { requireWorkflowId: false })
    if (!auth.success) {
      logger.warn('Unauthorized Semrush query attempt', { error: auth.error })
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 })
    }

    const parsed = await parseRequest(
      semrushQueryContract,
      request,
      {},
      {
        validationErrorResponse: (error) =>
          validationErrorResponse(error, getValidationErrorMessage(error)),
      }
    )
    if (!parsed.success) return parsed.response
    const query = parsed.data.query
    const apiKey = query.apiKey.trim()

    const rawDomain = query.domain ?? null
    const rawUrl = query.url ?? null
    const type = coerceSemrushTypeParam(query.type ?? null, rawDomain, rawUrl)
    const database = query.database ?? 'us'

    const semrushParams = new URLSearchParams()
    semrushParams.set('type', type)
    semrushParams.set('key', apiKey)
    semrushParams.set('database', database)

    if (type.startsWith('url_')) {
      const url = rawUrl
      if (!url) {
        return NextResponse.json(
          { error: 'Parameter "url" is required for URL-based report types.' },
          { status: 400 }
        )
      }
      semrushParams.set('url', url)
    } else {
      const domain = rawDomain ? sanitizeDomainQueryParam(rawDomain) : null
      if (!domain) {
        return NextResponse.json(
          { error: 'Parameter "domain" is required for domain-based report types.' },
          { status: 400 }
        )
      }
      semrushParams.set('domain', domain)
    }

    const displayLimit = query.display_limit
    if (displayLimit) semrushParams.set('display_limit', displayLimit)
    const exportColumns = query.export_columns
    if (exportColumns) semrushParams.set('export_columns', exportColumns)

    const additionalParams = query.additionalParams
    if (additionalParams) {
      try {
        const extra = new URLSearchParams(additionalParams)
        extra.forEach((value, key) => semrushParams.set(key, value))
      } catch {
        logger.warn('Failed to parse additionalParams', { additionalParams })
      }
    }

    const semrushUrl = `https://api.semrush.com/?${semrushParams.toString()}`
    logger.info('Semrush proxy: fetching', {
      type,
      param: type.startsWith('url_') ? 'url' : 'domain',
    })

    const res = await fetch(semrushUrl, {
      method: 'GET',
      headers: {
        Accept: 'text/plain, text/csv, */*',
      },
    })

    const body = await res.text()
    const contentType = res.headers.get('content-type') ?? 'text/plain; charset=utf-8'

    return new NextResponse(body, {
      status: res.status,
      statusText: res.statusText,
      headers: {
        'Content-Type': contentType,
      },
    })
  } catch (error) {
    logger.error('Semrush proxy error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Semrush proxy failed' },
      { status: 500 }
    )
  }
}
