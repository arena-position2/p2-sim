import { createLogger } from '@sim/logger'
import { NextResponse } from 'next/server'
import { getHumanArenaAccessToken } from '@/lib/arena/tokens'
import { getSession } from '@/lib/auth'

const logger = createLogger('ArenaTokenRoute')

/**
 * Returns a short-lived Arena access token for the session user (interactive selectors).
 * Refreshes via encrypted refresh when stored access is missing.
 * Clients must not persist this in a long-lived cookie.
 */
export async function GET() {
  try {
    const session = await getSession()

    if (!session || !session.user?.id) {
      return NextResponse.json(
        { found: false, reason: 'Unauthorized - No session or userId' },
        { status: 401 }
      )
    }

    const userId = session.user.id
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
      arenaToken,
    })
  } catch (err) {
    logger.error('Error fetching Arena token', { error: err })
    return NextResponse.json({ found: false, reason: 'Internal server error' }, { status: 500 })
  }
}
