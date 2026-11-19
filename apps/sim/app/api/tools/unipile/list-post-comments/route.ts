import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import { env } from '@/lib/core/config/env'
import { normalizeUnipilePostPathId } from '@/tools/unipile/normalize_post_path_id'
import { UNIPILE_BASE_URL } from '@/tools/unipile/types'

const logger = createLogger('UnipileListPostCommentsAPI')

const optionalQueryString = z.union([z.string(), z.null(), z.undefined()]).transform((v) => {
  if (v == null) return undefined
  const t = v.trim()
  return t === '' ? undefined : t
})

const RequestSchema = z.object({
  post_id: z.string().min(1),
  account_id: z.string().min(1),
  cursor: optionalQueryString,
  limit: z.coerce.number().int().min(1).max(100).optional().nullable(),
  max_items: z.coerce.number().int().min(1).max(50_000).optional().nullable(),
  sort_by: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.enum(['MOST_RECENT', 'MOST_RELEVANT']).optional()
  ),
  comment_id: optionalQueryString,
})

const MAX_COMMENT_PAGES = 500

function nextCommentCursor(body: Record<string, unknown>): string | undefined {
  if (typeof body.cursor === 'string' && body.cursor.trim() !== '') return body.cursor.trim()
  const paging = body.paging
  if (paging && typeof paging === 'object' && paging !== null) {
    const cursor = (paging as Record<string, unknown>).cursor
    if (typeof cursor === 'string' && cursor.trim() !== '') return cursor.trim()
  }
  return undefined
}

/**
 * Proxies GET `/api/v1/posts/{post_id}/comments` to Unipile.
 * Optional `max_items` follows cursors until that many comments are loaded.
 */
export async function POST(request: NextRequest) {
  const authResult = await checkInternalAuth(request, { requireWorkflowId: false })
  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = env.UNIPILE_API_KEY?.trim()
  if (!apiKey) {
    return NextResponse.json({ error: 'UNIPILE_API_KEY is not configured' }, { status: 503 })
  }

  const baseUrl = UNIPILE_BASE_URL.replace(/\/$/, '')

  try {
    const body = await request.json()
    const data = RequestSchema.parse(body)
    const postId = normalizeUnipilePostPathId(data.post_id)
    if (!postId) {
      return NextResponse.json({ error: 'post_id is empty after normalization' }, { status: 400 })
    }
    const encoded = encodeURIComponent(postId)
    const pageLimit =
      data.limit != null && Number.isFinite(data.limit) ? Math.trunc(data.limit) : undefined
    const maxItems =
      data.max_items != null && Number.isFinite(data.max_items)
        ? Math.min(Math.trunc(data.max_items), MAX_COMMENT_PAGES * 100)
        : undefined

    const loadPage = async (cursor: string | undefined, requestLimit: number | undefined) => {
      const params = new URLSearchParams()
      params.set('account_id', data.account_id.trim())
      if (cursor) params.set('cursor', cursor)
      if (requestLimit != null) params.set('limit', String(requestLimit))
      if (data.sort_by) params.set('sort_by', data.sort_by)
      if (data.comment_id) params.set('comment_id', data.comment_id)
      const qs = params.toString()
      const url = `${baseUrl}/api/v1/posts/${encoded}/comments${qs ? `?${qs}` : ''}`
      const upstream = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-API-KEY': apiKey,
        },
      })
      const responseText = await upstream.text()
      if (!upstream.ok) {
        logger.warn('Unipile list post comments failed', {
          status: upstream.status,
          snippet: responseText.slice(0, 500),
        })
        return NextResponse.json(
          { error: responseText || upstream.statusText || 'Unipile request failed' },
          { status: upstream.status }
        )
      }
      try {
        return JSON.parse(responseText) as Record<string, unknown>
      } catch {
        logger.error('Unipile returned non-JSON for list post comments')
        return NextResponse.json({ error: 'Invalid JSON from Unipile' }, { status: 502 })
      }
    }

    if (maxItems === undefined) {
      const page = await loadPage(data.cursor, pageLimit)
      return page instanceof NextResponse ? page : NextResponse.json(page)
    }

    const items: unknown[] = []
    let object: unknown
    let paging: unknown = null
    let cursor = data.cursor
    for (let page = 0; page < MAX_COMMENT_PAGES && items.length < maxItems; page += 1) {
      const requestLimit = Math.min(pageLimit ?? 100, maxItems - items.length)
      const parsed = await loadPage(cursor, requestLimit)
      if (parsed instanceof NextResponse) return parsed
      if (object === undefined) object = parsed.object
      paging = parsed.paging ?? null
      const pageItems = Array.isArray(parsed.items) ? parsed.items : []
      items.push(...pageItems)
      if (items.length >= maxItems) {
        items.length = maxItems
        paging = null
        break
      }
      const next = nextCommentCursor(parsed)
      if (!next || next === cursor) break
      cursor = next
    }

    return NextResponse.json({
      object: object ?? null,
      items,
      cursor: null,
      paging,
    })
  } catch (error) {
    const message = error instanceof z.ZodError ? error.message : 'Invalid request body'
    logger.warn('Unipile list post comments validation failed', { error })
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
