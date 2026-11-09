import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { listUnipileUserRelationsContract } from '@/lib/api/contracts/unipile'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'
import { env } from '@/lib/core/config/env'
import { fetchAllUnipileUserRelationItems } from '@/tools/unipile/fetch_all_user_relations'
import { UNIPILE_BASE_URL } from '@/tools/unipile/types'

const logger = createLogger('UnipileUserRelationsUIAPI')

interface UnipileRelationOption {
  id: string
  label: string
}

/**
 * Lists user relations for attendee pickers (`GET /api/v1/users/relations` upstream).
 * Requires `account_id`; loads every paginated page before mapping to picker options.
 */
export async function GET(request: NextRequest) {
  const auth = await checkSessionOrInternalAuth(request, { requireWorkflowId: false })
  if (!auth.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = env.UNIPILE_API_KEY?.trim()
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'UNIPILE_API_KEY is not configured', items: [] },
      { status: 503 }
    )
  }

  const parsed = await parseRequest(
    listUnipileUserRelationsContract,
    request,
    {},
    {
      validationErrorResponse: (error) =>
        NextResponse.json(
          {
            success: false,
            error: getValidationErrorMessage(error),
            items: [] as UnipileRelationOption[],
          },
          { status: 400 }
        ),
    }
  )
  if (!parsed.success) return parsed.response
  const accountId = parsed.data.query.account_id.trim()
  const filter = parsed.data.query.filter?.trim()
  const baseUrl = UNIPILE_BASE_URL.replace(/\/$/, '')

  try {
    const { items } = await fetchAllUnipileUserRelationItems({
      baseUrl,
      apiKey,
      accountId,
      filter: filter || undefined,
    })

    const options: UnipileRelationOption[] = items
      .map((row) => {
        if (!row || typeof row !== 'object') return null
        const r = row as Record<string, unknown>
        const id =
          (typeof r.provider_id === 'string' && r.provider_id.trim()) ||
          (typeof r.member_id === 'string' && r.member_id.trim()) ||
          (typeof r.id === 'string' && r.id.trim()) ||
          (typeof r.public_identifier === 'string' && r.public_identifier.trim()) ||
          ''
        if (!id) return null
        const first = typeof r.first_name === 'string' ? r.first_name.trim() : ''
        const last = typeof r.last_name === 'string' ? r.last_name.trim() : ''
        const fullName = [first, last].filter(Boolean).join(' ').trim()
        const name = typeof r.name === 'string' && r.name.trim() !== '' ? r.name.trim() : fullName
        const headline = typeof r.headline === 'string' ? r.headline.trim().slice(0, 64) : ''
        const label = name ? (headline ? `${name} — ${headline}` : name) : headline || id
        return { id, label }
      })
      .filter((o): o is UnipileRelationOption => o !== null)

    return NextResponse.json({ success: true, items: options })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list relations'
    logger.error('Unipile user relations UI error', { error })
    return NextResponse.json(
      { success: false, error: message, items: [] as UnipileRelationOption[] },
      { status: 500 }
    )
  }
}
