import { db } from '@sim/db'
import { chat, user } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import {
  videoAgentUsageBodyContract,
  videoAgentUsageQueryContract,
} from '@/lib/api/contracts/video-agent-usage'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { recordUsage, stableEventKey } from '@/lib/billing/core/usage-log'
import { hasAgentEmailAccess } from '@/lib/chat/agent-email-access'
import { isVideoBuilderAgentUrl } from '@/lib/chat/video-agent-redirect'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { getFalApiKey } from '@/lib/media/falai'
import { checkInternalApiKey, createUnauthorizedResponse } from '@/lib/mothership/request/http'
import { FALAI_HOSTED_KEY_MARKUP_MULTIPLIER, getFalAICostMetadata } from '@/lib/tools/falai-pricing'

const logger = createLogger('VideoAgentUsageAPI')

/**
 * POST /api/usage/video-agent
 *
 * Records one Fal call from the external video app into usage_log.
 * Auth is the existing internal key (`x-api-key: INTERNAL_API_SECRET`).
 * A repeated request id writes nothing again.
 */
/**
 * GET /api/usage/video-agent?email=
 *
 * Same allow-list ABM uses (`chat.allowed_emails`). The video app asks this
 * before showing Open agent. Auth is the same internal key as POST.
 */
export const GET = withRouteHandler(async (request: NextRequest) => {
  const auth = checkInternalApiKey(request)
  if (!auth.success) return createUnauthorizedResponse()

  const parsed = await parseRequest(videoAgentUsageQueryContract, request, undefined, {
    validationErrorResponse: (error) =>
      NextResponse.json({ error: getValidationErrorMessage(error) }, { status: 400 }),
  })
  if (!parsed.success) return parsed.response
  const { email } = parsed.data.query

  const rows = await db
    .select({ allowedEmails: chat.allowedEmails, redirectUrl: chat.redirectUrl })
    .from(chat)
    .where(and(eq(chat.isActive, true), isNull(chat.archivedAt), eq(chat.deploymentType, 'app')))

  const agent = rows.find((row) => isVideoBuilderAgentUrl(row.redirectUrl))
  if (!agent) return NextResponse.json({ allowed: false, found: false })

  return NextResponse.json({
    allowed: hasAgentEmailAccess(agent.allowedEmails, email),
    found: true,
  })
})

export const POST = withRouteHandler(async (request: NextRequest) => {
  const auth = checkInternalApiKey(request)
  if (!auth.success) return createUnauthorizedResponse()

  const parsed = await parseRequest(videoAgentUsageBodyContract, request, undefined, {
    invalidJsonResponse: () =>
      NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }),
    validationErrorResponse: (error) =>
      NextResponse.json({ error: getValidationErrorMessage(error) }, { status: 400 }),
  })
  if (!parsed.success) return parsed.response
  const email = parsed.data.body.email.toLowerCase()
  const { endpointId, requestId } = parsed.data.body
  const workspaceId = parsed.data.body.workspaceId ?? ''

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
    apiKey = getFalApiKey().apiKey
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
