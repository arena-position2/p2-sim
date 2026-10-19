import { db } from '@sim/db'
import { user } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { sql } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { recordUsage, stableEventKey } from '@/lib/billing/core/usage-log'
import { checkInternalApiKey, createUnauthorizedResponse } from '@/lib/copilot/request/http'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { getFalApiKey } from '@/lib/media/falai'
import {
  FALAI_HOSTED_KEY_MARKUP_MULTIPLIER,
  getFalAICostMetadata,
} from '@/lib/tools/falai-pricing'

const logger = createLogger('VideoAgentUsageAPI')

/**
 * POST /api/usage/video-agent
 *
 * Records one Fal call from the external video app into usage_log.
 * Auth is the existing internal key (`x-api-key: INTERNAL_API_SECRET`).
 * A repeated request id writes nothing again.
 */
export const POST = withRouteHandler(async (request: NextRequest) => {
  const auth = checkInternalApiKey(request)
  if (!auth.success) return createUnauthorizedResponse()

  const body: unknown = await request.json().catch(() => null)
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const email = readString(body.email).toLowerCase()
  const endpointId = readString(body.endpointId)
  const requestId = readString(body.requestId)
  const workspaceId = readString(body.workspaceId)
  if (!email.includes('@') || endpointId === '' || requestId === '') {
    return NextResponse.json(
      { error: 'email, endpointId, and requestId are required.' },
      { status: 400 }
    )
  }

  const [person] = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`)
    .limit(1)
  if (!person) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  }

  let apiKey: string
  try {
    apiKey = getFalApiKey()
  } catch (error) {
    logger.error('Fal API key is not configured for video-agent usage', { error })
    return NextResponse.json({ error: 'Fal pricing is not configured.' }, { status: 500 })
  }

  try {
    const pricing = await getFalAICostMetadata({ apiKey, endpointId, requestId })
    const rawCost = pricing.costDollars
    const cost = rawCost * FALAI_HOSTED_KEY_MARKUP_MULTIPLIER

    await recordUsage({
      userId: person.id,
      ...(workspaceId !== '' ? { workspaceId } : {}),
      entries: [
        {
          category: 'tool',
          source: 'api-tool',
          description: endpointId,
          cost,
          rawCost,
          toolId: endpointId,
          toolName: endpointId,
          provider: 'falai',
          vendor: 'Fal',
          eventKey: stableEventKey({ source: 'video-agent', requestId }),
          pricingSnapshot: {
            tool: endpointId,
            multiplier: FALAI_HOSTED_KEY_MARKUP_MULTIPLIER,
            pricingSource: 'hosted-key',
            capturedAt: new Date().toISOString(),
          },
          metadata: {
            requestId,
            endpointId,
            pricingSource: pricing.source,
            email,
          },
        },
      ],
    })

    return NextResponse.json({ ok: true, userId: person.id, rawCost, cost })
  } catch (error) {
    logger.error('Failed to record video-agent usage', { email, endpointId, requestId, error })
    return NextResponse.json(
      { error: getErrorMessage(error, 'Failed to record usage') },
      { status: 500 }
    )
  }
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
