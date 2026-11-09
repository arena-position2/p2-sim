/**
 * Bing Ads Accounts API Endpoint
 * Returns Bing Ads accounts from database
 */

import { type NextRequest, NextResponse } from 'next/server'
import { bingAdsAccountsContract } from '@/lib/api/contracts/ads'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { getBingAdsAccounts } from '@/lib/channel-accounts'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseRequest(
    bingAdsAccountsContract,
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
    const accounts = await getBingAdsAccounts(workspaceId)

    return NextResponse.json({
      success: true,
      accounts: accounts,
      count: Object.keys(accounts).length,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        details: 'Failed to fetch Bing Ads accounts',
      },
      { status: 500 }
    )
  }
}
