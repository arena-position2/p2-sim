import { db } from '@sim/db'
import { bannerMessages } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { appBannerContract } from '@/lib/api/contracts/banner'
import { parseRequest } from '@/lib/api/server'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'

const logger = createLogger('AppBannerAPI')

/**
 * Returns the app-level banner message shown at the top of the workspace shell.
 */
export const GET = withRouteHandler(async (request: NextRequest) => {
  const parsed = await parseRequest(appBannerContract, request, {})
  if (!parsed.success) return parsed.response

  try {
    const rawRows = await db
      .select()
      .from(bannerMessages)
      .where(and(eq(bannerMessages.type, 'sim'), eq(bannerMessages.isActive, true)))

    const message = rawRows
      .map((row) => row.message?.trim() ?? '')
      .filter((value) => value.length > 0)
      .join(', ')

    return NextResponse.json({ data: { message } }, { status: 200 })
  } catch (error) {
    logger.error('App banner fetch failed', error)
    return NextResponse.json({ data: { message: null } }, { status: 200 })
  }
})
