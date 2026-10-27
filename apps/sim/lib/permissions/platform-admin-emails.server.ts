import { cache } from 'react'
import { dbReplica } from '@sim/db'
import { user } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { isPlatformAdminEmail } from '@/lib/permissions/platform-admin-emails'

/**
 * True when the user's email is listed in `NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS`.
 * Request-memoized for settings layout + page double-checks. Server-only.
 */
export const isUserListedPlatformAdminEmail = cache(async (userId: string): Promise<boolean> => {
  const [row] = await dbReplica
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  return isPlatformAdminEmail(row?.email)
})
