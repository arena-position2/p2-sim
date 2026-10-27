import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getSession } from '@/lib/auth'
import { AGENT_ACCESS_REQUEST_PATH } from '@/lib/navigation/paths'
import { isPlatformAdminEmail } from '@/lib/permissions/platform-admin-emails'
import { buildAuthCrossLink } from '@/app/(auth)/auth-redirect'
import { AgentAccessRequestPage } from '@/app/agent-access-request/agent-access-request-page'

export const metadata: Metadata = {
  title: 'Agent access requests',
  robots: { index: false, follow: false },
}

/**
 * Top-level platform-admin inbox for agent access requests.
 * Restricted to emails in `NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS`.
 */
export default async function AgentAccessRequestRoutePage() {
  const session = await getSession()
  if (!session?.user) {
    redirect(
      buildAuthCrossLink('/login', {
        callbackUrl: AGENT_ACCESS_REQUEST_PATH,
        isInviteFlow: false,
      })
    )
  }

  if (!isPlatformAdminEmail(session.user.email)) {
    notFound()
  }

  return <AgentAccessRequestPage />
}
