import { db } from '@sim/db'
import { account } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkHybridAuth } from '@/lib/auth/hybrid'
import { generateRequestId } from '@/lib/core/utils/request'

export const dynamic = 'force-dynamic'

const logger = createLogger('SlackSearchAllAPI')

const SlackSearchAllSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  highlight: z.boolean().optional().nullable(),
  page: z.coerce.number().int().min(1).optional().nullable(),
  sort: z.enum(['score', 'timestamp']).optional().nullable(),
  sort_dir: z.enum(['asc', 'desc']).optional().nullable(),
})

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const authResult = await checkHybridAuth(request, { requireWorkflowId: false })

    if (!authResult.success || !authResult.userId) {
      logger.warn(`[${requestId}] Unauthorized Slack search.all attempt: ${authResult.error}`)
      return NextResponse.json(
        {
          success: false,
          error: authResult.error || 'Authentication required',
        },
        { status: 401 }
      )
    }

    logger.info(
      `[${requestId}] Authenticated Slack search.all request via ${authResult.authType}`,
      {
        userId: authResult.userId,
      }
    )

    const body = await request.json()
    const validatedData = SlackSearchAllSchema.parse(body)

    // Get user's Slack account directly from database and use idToken field
    const slackAccount = await db.query.account.findFirst({
      where: eq(account.userId, authResult.userId),
      orderBy: (accounts, { desc }) => [desc(accounts.updatedAt)],
    })

    if (!slackAccount) {
      logger.warn(`[${requestId}] No Slack account found for user: ${authResult.userId}`)
      return NextResponse.json(
        {
          success: false,
          error: 'No Slack account connected. Please connect your Slack account first.',
        },
        { status: 400 }
      )
    }

    logger.info(`[${requestId}] Found Slack account for user:`, {
      accountId: slackAccount.id,
      hasIdToken: !!slackAccount.idToken,
      idTokenPrefix: slackAccount.idToken?.substring(0, 10) || 'none',
      idTokenType: slackAccount.idToken?.startsWith('xoxp-')
        ? 'user'
        : slackAccount.idToken?.startsWith('xoxb-')
          ? 'bot'
          : 'unknown',
      hasAccessToken: !!slackAccount.accessToken,
      accessTokenPrefix: slackAccount.accessToken?.substring(0, 10) || 'none',
      accessTokenType: slackAccount.accessToken?.startsWith('xoxp-')
        ? 'user'
        : slackAccount.accessToken?.startsWith('xoxb-')
          ? 'bot'
          : 'unknown',
    })

    // Use idToken field directly (this contains the user token for search operations)
    let accessToken: string
    if (slackAccount.idToken) {
      accessToken = slackAccount.idToken
      logger.info(`[${requestId}] Using token from idToken field for Slack search.all:`, {
        tokenType: accessToken.startsWith('xoxp-')
          ? 'user'
          : accessToken.startsWith('xoxb-')
            ? 'bot'
            : 'unknown',
        tokenPrefix: accessToken.substring(0, 10),
      })
    } else {
      logger.warn(`[${requestId}] No idToken found in Slack account`)
      return NextResponse.json(
        {
          success: false,
          error:
            'No user token found in idToken field. Please reconnect your Slack account with search permissions.',
        },
        { status: 400 }
      )
    }

    // Build form-encoded body for Slack API
    const formData = new URLSearchParams()
    formData.append('query', validatedData.query)

    if (typeof validatedData.highlight === 'boolean') {
      formData.append('highlight', String(validatedData.highlight))
    }

    if (validatedData.page != null) {
      formData.append('page', String(validatedData.page))
    }

    if (validatedData.sort) {
      formData.append('sort', validatedData.sort)
    }

    if (validatedData.sort_dir) {
      formData.append('sort_dir', validatedData.sort_dir)
    }

    logger.info(`[${requestId}] Executing Slack search.all`, {
      query: validatedData.query,
      queryLength: validatedData.query.length,
      hasHighlight: typeof validatedData.highlight === 'boolean',
      page: validatedData.page,
      sort: validatedData.sort,
      sort_dir: validatedData.sort_dir,
      hasChannelInQuery: validatedData.query.includes('in:'),
      channelInQuery: validatedData.query.match(/in:(\S+)/)?.[1] || null,
    })

    const slackResponse = await fetch('https://slack.com/api/search.all', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${accessToken}`,
      },
      body: formData.toString(),
    })

    const data = await slackResponse.json()

    if (!slackResponse.ok || !data.ok) {
      logger.error(`[${requestId}] Slack search.all API error`, {
        status: slackResponse.status,
        statusText: slackResponse.statusText,
        error: data.error,
        needed: data.error === 'missing_scope' ? data.needed : undefined,
        provided: data.error === 'missing_scope' ? data.provided : undefined,
      })

      return NextResponse.json(
        {
          success: false,
          error:
            data.error === 'missing_scope'
              ? `Missing required Slack scope: ${data.needed}. Please reconnect your Slack account to grant the necessary permissions.`
              : data.error ||
                `Slack API error: ${slackResponse.status} ${slackResponse.statusText}`,
        },
        { status: 400 }
      )
    }

    return NextResponse.json(
      {
        success: true,
        output: {
          query: validatedData.query,
          files: data.files,
          messages: data.messages,
          posts: data.posts,
          raw: data,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn(`[${requestId}] Invalid request data`, { errors: error.issues })
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid request data',
          details: error.issues,
        },
        { status: 400 }
      )
    }

    logger.error(`[${requestId}] Unexpected error in Slack search.all`, {
      error,
    })

    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error while searching Slack',
      },
      { status: 500 }
    )
  }
}
