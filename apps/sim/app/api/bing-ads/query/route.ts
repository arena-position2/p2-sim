import { getErrorMessage } from '@sim/utils/errors'
import { type NextRequest, NextResponse } from 'next/server'
import { bingAdsQueryContract } from '@/lib/api/contracts/ads'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { executeBingAdsQuery } from './execute'

export async function POST(request: NextRequest) {
  const parsed = await parseRequest(
    bingAdsQueryContract,
    request,
    {},
    {
      validationErrorResponse: (error) =>
        validationErrorResponse(error, getValidationErrorMessage(error)),
    }
  )
  if (!parsed.success) return parsed.response

  try {
    const body = parsed.data.body
    const workspaceId = body.workspaceId ?? parsed.data.query.workspaceId

    const result = await executeBingAdsQuery(
      {
        query: body.query ?? '',
        account: body.account ?? '',
        ...(workspaceId ? { workspaceId } : {}),
      },
      {}
    )
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: getErrorMessage(error, 'Unknown error occurred'),
        details: 'Failed to process Bing Ads query',
        suggestion: 'Please check your query and try again.',
      },
      { status: 500 }
    )
  }
}
