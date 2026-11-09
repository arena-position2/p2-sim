import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { listUnipileChatsContract } from '@/lib/api/contracts/unipile'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'
import { env } from '@/lib/core/config/env'
import { UNIPILE_BASE_URL } from '@/tools/unipile/types'

const logger = createLogger('UnipileChatsAPI')

interface UnipileChatOption {
  id: string
  label: string
}

/**
 * Lists chats for the block editor (`GET /api/v1/chats` upstream with `account_id` query).
 */
export async function GET(request: NextRequest) {
  const auth = await checkSessionOrInternalAuth(request, { requireWorkflowId: false })
  if (!auth.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = await parseRequest(
    listUnipileChatsContract,
    request,
    {},
    {
      validationErrorResponse: (error) =>
        NextResponse.json(
          {
            success: false,
            error: getValidationErrorMessage(error),
            items: [],
          },
          { status: 400 }
        ),
    }
  )
  if (!parsed.success) return parsed.response
  const accountId = parsed.data.query.account_id.trim()

  const apiKey = env.UNIPILE_API_KEY?.trim()
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'UNIPILE_API_KEY is not configured', items: [] },
      { status: 503 }
    )
  }

  const baseUrl = UNIPILE_BASE_URL.replace(/\/$/, '')
  const query = new URLSearchParams()
  query.set('account_id', accountId)
  const url = `${baseUrl}/api/v1/chats?${query.toString()}`

  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'X-API-KEY': apiKey,
      },
    })

    const responseText = await upstream.text()
    if (!upstream.ok) {
      logger.warn('Unipile list chats failed', {
        status: upstream.status,
        snippet: responseText.slice(0, 500),
      })
      return NextResponse.json(
        {
          success: false,
          error: responseText || upstream.statusText || 'Unipile request failed',
          items: [] as UnipileChatOption[],
        },
        { status: upstream.status }
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(responseText) as unknown
    } catch {
      logger.error('Unipile returned non-JSON for list chats')
      return NextResponse.json(
        { success: false, error: 'Invalid JSON from Unipile', items: [] as UnipileChatOption[] },
        { status: 502 }
      )
    }

    const body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const rawItems = body.items
    const items = Array.isArray(rawItems) ? rawItems : []

    const options: UnipileChatOption[] = items
      .map((row) => {
        if (!row || typeof row !== 'object') return null
        const c = row as Record<string, unknown>
        const id = typeof c.id === 'string' ? c.id.trim() : ''
        if (!id) return null
        const name = typeof c.name === 'string' && c.name.trim() !== '' ? c.name.trim() : 'Chat'
        const accountType =
          typeof c.account_type === 'string' && c.account_type.trim() !== ''
            ? c.account_type.trim()
            : ''
        const preview =
          typeof c.last_message_text === 'string' && c.last_message_text.trim() !== ''
            ? c.last_message_text.trim().slice(0, 72)
            : ''
        const parts = [name]
        if (accountType) parts.push(`(${accountType})`)
        if (preview) parts.push(`— ${preview}`)
        return { id, label: parts.join(' ') }
      })
      .filter((o): o is UnipileChatOption => o !== null)

    return NextResponse.json({ success: true, items: options })
  } catch (error) {
    logger.error('Unipile list chats error', { error })
    return NextResponse.json(
      { success: false, error: 'Failed to list chats', items: [] as UnipileChatOption[] },
      { status: 500 }
    )
  }
}
