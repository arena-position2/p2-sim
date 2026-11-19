import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { createUnipileHostedAuthLink } from '@/lib/unipile/hosted-auth'
import { resolveUnipileReconnectExternalAccountId } from '@/lib/unipile/resolve-reconnect-account'

const logger = createLogger('UnipileHostedLinkAPI')

const RequestSchema = z.object({
  callbackURL: z.string().url(),
  workspaceId: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
})

/**
 * Creates a Unipile hosted LinkedIn authentication URL. The user is redirected to Unipile
 * and returns to `callbackURL` with `unipile_hosted=success|failure` and `account_id` query params.
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

  try {
    const reconnectExternalAccountId = await resolveUnipileReconnectExternalAccountId({
      userId: session.user.id,
      workspaceId: body.workspaceId,
      credentialId: body.credentialId,
    })

    const { url } = await createUnipileHostedAuthLink({
      userId: session.user.id,
      callbackURL: body.callbackURL,
      correlationName: session.user.id,
      workspaceId: body.workspaceId,
      reconnectExternalAccountId,
    })

    return NextResponse.json({
      success: true,
      url,
      reconnect: Boolean(reconnectExternalAccountId),
    })
  } catch (error) {
    logger.error('Failed to create Unipile hosted auth link', { error })
    return NextResponse.json(
      { success: false, error: 'Failed to start LinkedIn connection' },
      { status: 502 }
    )
  }
})
