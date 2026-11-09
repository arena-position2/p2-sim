import { getErrorMessage } from '@sim/utils/errors'
import { type NextRequest, NextResponse } from 'next/server'
import { facebookAdsQueryContract } from '@/lib/api/contracts/ads'
import { getValidationErrorMessage, parseRequest, validationErrorResponse } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'
import { executeFacebookAdsQuery } from './execute'

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const timestamp = new Date().toISOString()

  try {
    const parsed = await parseRequest(
      facebookAdsQueryContract,
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

    const result = await executeFacebookAdsQuery(
      {
        ...body,
        query: body.query ?? '',
        ...(workspaceId ? { workspaceId } : {}),
      },
      { requestId }
    )
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: getErrorMessage(error, 'Unknown error occurred'),
        requestId,
        timestamp,
      },
      { status: 500 }
    )
  }
}
