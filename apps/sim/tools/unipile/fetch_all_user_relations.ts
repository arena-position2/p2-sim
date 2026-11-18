import { outboundFetch } from '@/lib/core/network/outbound-fetch.server'
/**
 * Unipile GET /api/v1/users/relations — page size and cursor extraction.
 * Docs: `limit` integer 1–1000 per page.
 * @see https://developer.unipile.com/reference/userscontroller_getrelations
 */
export const UNIPILE_RELATIONS_PAGE_LIMIT = 1000

const MAX_RELATION_PAGES = 500
const MAX_RELATION_ITEMS = 100_000
const MAX_PAGE_FETCH_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 300

type RelationsStopReason = 'completed' | 'max_pages' | 'max_items' | 'repeated_cursor'

function getRetryDelayMs(retry: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader)
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.ceil(retryAfterSeconds * 1000)
    }
  }
  const exp = INITIAL_RETRY_DELAY_MS * 2 ** retry
  const jitter = Math.floor(Math.random() * 150)
  return exp + jitter
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchRelationsPageWithRetry(
  url: string,
  apiKey: string
): Promise<Record<string, unknown>> {
  let attempt = 0
  while (true) {
    const res = await outboundFetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-KEY': apiKey,
      },
    })

    const responseText = await res.text()
    if (res.ok) {
      try {
        return JSON.parse(responseText) as Record<string, unknown>
      } catch {
        throw new Error('Invalid JSON from Unipile')
      }
    }

    const isRetryable = res.status === 429 || res.status >= 500
    if (!isRetryable || attempt >= MAX_PAGE_FETCH_RETRIES) {
      throw new Error(responseText || res.statusText || 'Unipile request failed')
    }

    const delayMs = getRetryDelayMs(attempt, res.headers.get('retry-after'))
    await wait(delayMs)
    attempt += 1
  }
}

export function extractUnipileRelationsNextCursor(
  body: Record<string, unknown>
): string | undefined {
  const top = body.cursor
  if (typeof top === 'string' && top.trim().length > 0) return top.trim()
  const paging = body.paging
  if (paging && typeof paging === 'object' && paging !== null) {
    const c = (paging as Record<string, unknown>).cursor
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  }
  return undefined
}

export interface FetchAllUnipileUserRelationsOptions {
  baseUrl: string
  apiKey: string
  accountId: string
  /** Unipile `filter` query — filter by user name */
  filter?: string | null
}

/**
 * Follows `cursor` until all relation pages are loaded (or safety cap).
 */
export async function fetchAllUnipileUserRelationItems(
  options: FetchAllUnipileUserRelationsOptions
): Promise<{
  items: unknown[]
  object: string | null
  pagesFetched: number
  truncated: boolean
  stopReason: RelationsStopReason
}> {
  const { baseUrl, apiKey, accountId } = options
  const filterTrim =
    typeof options.filter === 'string' && options.filter.trim() !== ''
      ? options.filter.trim()
      : undefined

  const allItems: unknown[] = []
  let object: string | null = null
  /** Cursor for the *next* upstream request (undefined on first page). */
  let pageCursor: string | undefined

  let pages = 0
  let stopReason: RelationsStopReason = 'completed'
  let brokeEarly = false
  while (pages < MAX_RELATION_PAGES) {
    const qs = new URLSearchParams()
    qs.set('account_id', accountId)
    qs.set('limit', String(UNIPILE_RELATIONS_PAGE_LIMIT))
    if (filterTrim) qs.set('filter', filterTrim)
    if (pageCursor) qs.set('cursor', pageCursor)

    const url = `${baseUrl}/api/v1/users/relations?${qs.toString()}`
    const parsed = await fetchRelationsPageWithRetry(url, apiKey)
    pages += 1

    if (typeof parsed.object === 'string') {
      object = parsed.object
    }

    const pageItems = Array.isArray(parsed.items) ? parsed.items : []
    allItems.push(...pageItems)
    if (allItems.length >= MAX_RELATION_ITEMS) {
      stopReason = 'max_items'
      brokeEarly = true
      break
    }

    const next = extractUnipileRelationsNextCursor(parsed)
    if (!next) {
      stopReason = 'completed'
      brokeEarly = true
      break
    }
    if (next === pageCursor) {
      stopReason = 'repeated_cursor'
      brokeEarly = true
      break
    }
    pageCursor = next
  }

  if (!brokeEarly && pages >= MAX_RELATION_PAGES) {
    stopReason = 'max_pages'
  }

  return {
    items: allItems,
    object,
    pagesFetched: pages,
    truncated: stopReason === 'max_pages' || stopReason === 'max_items',
    stopReason,
  }
}
