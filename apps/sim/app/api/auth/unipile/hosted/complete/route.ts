import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { finalizeUnipileLinkedInHostedAuth } from '@/lib/unipile/hosted-auth'
import { checkWorkspaceAccess } from '@/lib/workspaces/permissions/utils'

const logger = createLogger('UnipileHostedCompleteAPI')

const RequestSchema = z.object({
  accountId: z.string().min(1),
  workspaceId: z.string().uuid().optional(),
  displayName: z.string().min(1).optional(),
  description: z.string().trim().max(500).optional(),
})

/**
 * Persists a Unipile LinkedIn account after hosted auth when Unipile redirects back with
 * `account_id` in the query string (fallback when `notify_url` is unreachable, e.g. localhost).
 */
export const POST = withRouteHandler(async (request: NextRequest) => {
  const session = await getSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: z.infer<typeof RequestSchema>
  try {
    body = RequestSchema.parse(await request.json())
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const userId = session.user.id

  if (body.workspaceId) {
    const workspaceAccess = await checkWorkspaceAccess(body.workspaceId, userId)
    if (!workspaceAccess.canWrite) {
      return NextResponse.json({ error: 'Write permission required' }, { status: 403 })
    }
  }

  try {
    const result = await finalizeUnipileLinkedInHostedAuth({
      userId,
      unipileAccountId: body.accountId,
      workspaceId: body.workspaceId,
      displayName: body.displayName,
      description: body.description,
    })
    logger.info('Completed Unipile hosted auth from redirect', {
      userId,
      unipileAccountId: body.accountId.trim(),
      accountRowId: result.accountRowId,
      credentialId: result.credentialId,
    })
    return NextResponse.json({
      success: true,
      accountRowId: result.accountRowId,
      credentialId: result.credentialId,
    })
  } catch (error) {
    logger.error('Failed to complete Unipile hosted auth from redirect', {
      error,
      userId,
    })
    return NextResponse.json(
      { success: false, error: 'Failed to save LinkedIn connection' },
      { status: 500 }
    )
  }
})
