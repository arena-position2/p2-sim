import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { semrushPositionTrackingOrganicContract } from '@/lib/api/contracts/tools/semrush'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'

const logger = createLogger('SemrushPositionTrackingOrganicAPI')

/**
 * Proxies Semrush Projects API – Organic Positions Report (Position Tracking).
 * GET https://api.semrush.com/reports/v1/projects/{campaignID}/tracking/
 * Params: key, action=report, type=tracking_position_organic, url, date_begin, date_end, etc.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await checkSessionOrInternalAuth(request, { requireWorkflowId: false })
    if (!auth.success) {
      logger.warn('Unauthorized Semrush position tracking attempt', { error: auth.error })
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 })
    }

    const parsed = await parseRequest(
      semrushPositionTrackingOrganicContract,
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
    const campaignId = query.campaignId
    const urlParam = query.url

    const semrushParams = new URLSearchParams()
    semrushParams.set('key', apiKey)
    semrushParams.set('action', 'report')
    semrushParams.set('type', 'tracking_position_organic')
    semrushParams.set('url', urlParam)

    const optionalParams = [
      'date_begin',
      'date_end',
      'linktype_filter',
      'display_tags',
      'display_tags_condition',
      'display_sort',
      'display_limit',
      'display_offset',
      'display_filter',
      'top_filter',
      'use_volume',
      'business_name',
      'serp_feature_filter',
    ] as const
    for (const name of optionalParams) {
      const value = query[name]
      if (value !== undefined && value !== '') semrushParams.set(name, value)
    }

    const baseUrl = 'https://api.semrush.com/reports/v1/projects'
    const semrushUrl = `${baseUrl}/${encodeURIComponent(campaignId)}/tracking/?${semrushParams.toString()}`

    logger.info('Semrush position tracking organic: fetching', { campaignId })

    const res = await fetch(semrushUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })

    const body = await res.text()
    if (!res.ok) {
      logger.error('Semrush position tracking API error', {
        status: res.status,
        body: body.slice(0, 500),
      })
      return NextResponse.json(
        { error: body || `Semrush API error: ${res.status}` },
        { status: res.status }
      )
    }

    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      logger.error('Semrush position tracking: invalid JSON', { body: body.slice(0, 200) })
      return NextResponse.json({ error: 'Invalid JSON response from Semrush API' }, { status: 502 })
    }

    return NextResponse.json(json)
  } catch (error) {
    logger.error('Semrush position tracking proxy error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Semrush proxy failed' },
      { status: 500 }
    )
  }
}
