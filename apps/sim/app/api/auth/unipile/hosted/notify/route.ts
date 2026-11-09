import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { unipileHostedNotifyContract } from '@/lib/api/contracts/arena-auth'
import { parseRequest } from '@/lib/api/server'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import {
  extractCorrelationUserIdFromNotifyPayload,
  extractUnipileAccountIdFromNotifyPayload,
  extractUnipileHostedAuthStatusFromNotifyPayload,
  finalizeUnipileLinkedInHostedAuth,
} from '@/lib/unipile/hosted-auth'

const logger = createLogger('UnipileHostedNotifyAPI')

/**
 * Webhook invoked by Unipile when hosted authentication completes.
 * Persists the linked account for the Sim user identified by the hosted link `name` field.
 */
export const POST = withRouteHandler(async (request: NextRequest) => {
  const parsed = await parseRequest(unipileHostedNotifyContract, request, undefined, {
    invalidJsonResponse: () => NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
  })
  if (!parsed.success) return parsed.response
  const body = parsed.data.body

  const unipileAccountId = extractUnipileAccountIdFromNotifyPayload(body)
  const userId = extractCorrelationUserIdFromNotifyPayload(body)
  const hostedStatus = extractUnipileHostedAuthStatusFromNotifyPayload(body)

  if (!unipileAccountId || !userId) {
    logger.warn('Unipile hosted notify missing account or user correlation', {
      hasAccountId: Boolean(unipileAccountId),
      hasUserId: Boolean(userId),
    })
    return NextResponse.json({ received: true, persisted: false }, { status: 200 })
  }

  try {
    const result = await finalizeUnipileLinkedInHostedAuth({
      userId,
      unipileAccountId,
    })
    logger.info('Persisted Unipile LinkedIn account from hosted notify', {
      userId,
      unipileAccountId,
      hostedStatus,
      credentialId: result.credentialId,
    })
    return NextResponse.json({ received: true, persisted: true })
  } catch (error) {
    logger.error('Failed to persist Unipile account from notify', { error, userId })
    return NextResponse.json({ received: true, persisted: false }, { status: 500 })
  }
})
