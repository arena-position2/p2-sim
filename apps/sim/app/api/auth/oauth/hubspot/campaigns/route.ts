import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { hubspotCampaignsContract } from '@/lib/api/contracts/arena-auth'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { getSession } from '@/lib/auth'
import { generateRequestId } from '@/lib/core/utils/request'
import { getCredential, refreshAccessTokenIfNeeded } from '@/lib/oauth/credential-service'
import { fetchHubSpotCampaigns } from '@/tools/hubspot/campaigns'

export const dynamic = 'force-dynamic'

const logger = createLogger('HubSpotCampaignsAPI')

/**
 * Get campaigns from HubSpot
 */
export async function GET(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    // Get the session
    const session = await getSession()

    // Check if the user is authenticated
    if (!session?.user?.id) {
      logger.warn(`[${requestId}] Unauthenticated request rejected`)
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
    }

    // Get parameters from query
    const parsed = await parseRequest(hubspotCampaignsContract, request, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json({ error: getValidationErrorMessage(error) }, { status: 400 }),
    })
    if (!parsed.success) return parsed.response
    const { credentialId } = parsed.data.query
    const limit = parsed.data.query.limit || '100'

    // Get the credential from the database using the utility (handles alias and multiple tables)
    const credential = await getCredential(requestId, credentialId, session.user.id)

    if (!credential) {
      logger.warn(`[${requestId}] Credential not found`, { credentialId })
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
    }

    // Check if the credential belongs to the user or is a shared HubSpot account
    const isSharedHubSpotAccount =
      credential.providerId === 'hubspot' && !!(credential as any).alias
    if (!isSharedHubSpotAccount && credential.userId !== session.user.id) {
      logger.warn(`[${requestId}] Unauthorized credential access attempt`, {
        credentialUserId: credential.userId,
        requestUserId: session.user.id,
      })
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    // Refresh access token if needed
    const accessToken = await refreshAccessTokenIfNeeded(credentialId, session.user.id, requestId)

    if (!accessToken) {
      logger.error(`[${requestId}] Failed to obtain valid access token`)
      return NextResponse.json({ error: 'Failed to obtain valid access token' }, { status: 401 })
    }

    logger.info(`[${requestId}] Fetching campaigns from HubSpot`, {
      credentialId,
      limit,
    })

    // Use the service function to fetch campaigns
    const campaigns = await fetchHubSpotCampaigns(accessToken, limit)

    logger.info(`[${requestId}] Successfully fetched ${campaigns.length} campaigns from HubSpot`, {
      totalCampaigns: campaigns.length,
    })

    return NextResponse.json({ campaigns }, { status: 200 })
  } catch (error) {
    logger.error(`[${requestId}] Error fetching HubSpot campaigns`, error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
