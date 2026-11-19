import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import { env } from '@/lib/core/config/env'
import { fetchAllUnipilePostReactionItems } from '@/tools/unipile/fetch_all_post_reactions'
import { UNIPILE_BASE_URL } from '@/tools/unipile/types'

const logger = createLogger('UnipileListPostReactionsAPI')

const optionalString = z.string().nullish()

const RequestSchema = z.object({
  post_id: z.string().min(1, 'post_id is required'),
  account_id: z.string().min(1, 'account_id is required'),
  comment_id: optionalString,
  limit: z.coerce.number().int().min(1).max(100).optional().nullable(),
  max_items: z.coerce.number().int().min(1).max(50_000).optional().nullable(),
})

/**
 * Proxies GET `/api/v1/posts/{post_id}/reactions` to Unipile, following pagination until all reactions are loaded.
 * Optional `max_items` stops after that many reactions.
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

    const { items, object, paging } = await fetchAllUnipilePostReactionItems({
      baseUrl,
      apiKey,
      postId: data.post_id.trim(),
      accountId: data.account_id.trim(),
      commentId: data.comment_id,
      limit: data.limit ?? undefined,
      maxItems: data.max_items ?? undefined,
    })

    return NextResponse.json({
      object,
      items,
      item_count: items.length,
      cursor: null,
      paging,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn('Unipile list post reactions validation failed', { error })
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    const message = error instanceof Error ? error.message : 'Unipile request failed'
    logger.warn('Unipile list post reactions failed', { message })
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
