import { db } from '@sim/db'
import { user, userArenaDetails } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { getHumanArenaAccessToken } from '@/lib/arena/tokens'
import { getSession } from '@/lib/auth'
import { verifyInternalToken } from '@/lib/auth/internal'

const logger = createLogger('ArenaGetTokenAPI')

const POSITION2_DOMAIN = '@position2.com'

/**
 * Validates that the email is allowed (must be @position2.com).
 */
function isAllowedEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(POSITION2_DOMAIN)
}

/**
 * Resolves the authorized user id: from session, or from query param when request uses internal token.
 * Caller must pass logged-in userId (and optionally email) as params; when using session, param userId must match session user.
 */
async function resolveAuthorizedUserId(
  req: NextRequest
): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; body: { found: false; reason: string } }
> {
  const { searchParams } = new URL(req.url)
  const paramUserId = searchParams.get('userId')?.trim()
  const paramEmail = searchParams.get('email')?.trim()

  const session = await getSession()
  if (session?.user?.id) {
    const sessionUserId = session.user.id
    if (paramUserId && paramUserId !== sessionUserId) {
      return {
        ok: false,
        status: 403,
        body: { found: false, reason: 'userId param must match logged-in user' },
      }
    }
    return { ok: true, userId: sessionUserId }
  }

  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1]
    const verification = await verifyInternalToken(token)
    if (verification.valid) {
      const userId = paramUserId ?? verification.userId
      if (!userId) {
        return {
          ok: false,
          status: 400,
          body: { found: false, reason: 'Missing required param: userId (logged-in user)' },
        }
      }
      return { ok: true, userId }
    }
  }

  return {
    ok: false,
    status: 401,
    body: { found: false, reason: 'Unauthorized - No session or valid internal token' },
  }
}

/**
 * Returns the Arena token for the resolved user (logged-in user or workflow owner).
 * Accepts userId (and optional email) as query params from the executor.
 * Only allowed for users with @position2.com email (logged-in user and workflow owner must both be @position2.com when used).
 */
export async function GET(req: NextRequest) {
  try {
    const resolved = await resolveAuthorizedUserId(req)
    if (!resolved.ok) {
      return NextResponse.json(resolved.body, { status: resolved.status })
    }
    const userId = resolved.userId

    const userRow = await db
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)

    if (userRow.length === 0) {
      return NextResponse.json({ found: false, reason: 'User not found' }, { status: 404 })
    }

    const email = userRow[0].email
    const name = userRow[0].name
    if (!email || !isAllowedEmail(email)) {
      logger.warn(`Get token rejected: user email domain not allowed (userId: ${userId})`)
      return NextResponse.json(
        { found: false, reason: 'Only @position2.com users are allowed' },
        { status: 403 }
      )
    }

    const details = await db
      .select({
        timezone: userArenaDetails.timezone,
        persona: userArenaDetails.persona,
      })
      .from(userArenaDetails)
      .where(eq(userArenaDetails.userIdRef, userId))
      .limit(1)

    const arenaToken = await getHumanArenaAccessToken(userId)
    if (!arenaToken) {
      return NextResponse.json(
        { found: false, reason: 'Arena token not found for user' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      found: true,
      userId,
      name,
      email,
      arenaToken,
      timezone: details[0]?.timezone ?? null,
      persona: details[0]?.persona ?? null,
    })
  } catch (err) {
    logger.error('Error fetching Arena token for user', err)
    return NextResponse.json({ found: false, reason: 'Internal server error' }, { status: 500 })
  }
}
