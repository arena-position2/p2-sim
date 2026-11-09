import { getErrorMessage } from '@sim/utils/errors'
import { type NextRequest, NextResponse } from 'next/server'
import { googleAdsV1QueryContract } from '@/lib/api/contracts/ads'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'
import { executeGoogleAdsV1Query } from './execute'

/**
 * POST /api/google-ads-v1/query
 *
 * Thin adapter over {@link executeGoogleAdsV1Query}.
 */
export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const parsed = await parseRequest(
      googleAdsV1QueryContract,
      request,
      {},
      {
        validationErrorResponse: (error) =>
          validationErrorResponse(error, getValidationErrorMessage(error)),
      }
    )
    if (!parsed.success) return parsed.response
    const body = parsed.data.body
    const workspaceId = body.workspaceId ?? parsed.data.query.workspaceId
    const userId = parsed.data.query.userId

    const result = await executeGoogleAdsV1Query(
      {
        ...body,
        query: body.query ?? '',
        ...(workspaceId ? { workspaceId } : {}),
        ...(userId ? { userId } : {}),
      },
      { requestId }
    )
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: getErrorMessage(error, 'Unknown error occurred'),
        details: 'Failed to process Google Ads V1 query',
        suggestion: 'Please check your query and try again.',
      },
      { status: 500 }
    )
  }
}
