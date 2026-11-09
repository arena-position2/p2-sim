import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { facebookAdsAccountsContract } from '@/lib/api/contracts/ads'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { getFacebookAdsAccounts } from '@/lib/channel-accounts'

const logger = createLogger('FacebookAdsAccounts')

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseRequest(
    facebookAdsAccountsContract,
    request,
    {},
    {
      validationErrorResponse: (error) =>
        validationErrorResponse(error, getValidationErrorMessage(error)),
    }
  )
  if (!parsed.success) return parsed.response

  try {
    const { workspaceId } = parsed.data.query
    const accounts = await getFacebookAdsAccounts(workspaceId)

    return NextResponse.json({
      success: true,
      accounts,
      count: Object.keys(accounts).length,
    })
  } catch (error) {
    logger.error('Failed to fetch Facebook Ads accounts', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        details: 'Failed to fetch Facebook Ads accounts',
      },
      { status: 500 }
    )
  }
}
