import { db } from '@sim/db'
import { apiKey as apiKeyTable, user, userArenaDetails } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { eq, isNull, ne, or } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { createCodedErrorResponse } from '@/app/api/workflows/utils'

const logger = createLogger('RateLimitAPI')

export async function GET(request: NextRequest) {
  try {
    // Try session auth first (for web UI)
    const session = await getSession()
    let authenticatedUserId: string | null = session?.user?.id || null

    // If no session, check for API key auth
    if (!authenticatedUserId) {
      const apiKeyHeader = request.headers.get('x-api-key')
      if (apiKeyHeader) {
        // Verify API key
        const [apiKeyRecord] = await db
          .select({ userId: apiKeyTable.userId })
          .from(apiKeyTable)
          .where(eq(apiKeyTable.key, apiKeyHeader))
          .limit(1)

        if (apiKeyRecord) {
          authenticatedUserId = apiKeyRecord.userId
        }
      }
    }

    if (!authenticatedUserId) {
      return createCodedErrorResponse('Authentication required', 401)
    }

    // Get users joined with user_arena_details and filter out client_stakeholder
    const rows = await db
      .select({ user, userType: userArenaDetails.userType })
      .from(user)
      .leftJoin(userArenaDetails, eq(userArenaDetails.userIdRef, user.id))
      .where(
        or(isNull(userArenaDetails.userType), ne(userArenaDetails.userType, 'client_stakeholder'))
      )

    const users = rows.map((r) => ({ ...r.user, userType: r.userType ?? null }))

    return NextResponse.json({
      success: true,
      users: users,
    })
  } catch (error: any) {
    logger.error('Error checking rate limit:', error)
    return createCodedErrorResponse(error.message || 'Failed to check rate limit', 500)
  }
}
