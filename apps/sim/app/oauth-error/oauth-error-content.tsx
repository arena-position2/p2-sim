'use client'

import { Chip } from '@sim/emcn'
import { consumeOAuthReturnContext, readOAuthReturnContext } from '@/lib/credentials/client-state'
import { DesktopHandoffShell } from '@/app/desktop/components/desktop-handoff-shell'
import { resolveOAuthErrorReturnPath } from '@/app/oauth-error/return-path'

interface OAuthErrorContentProps {
  errorCode?: string
  /** Precomputed body copy from the server page's error map (non-access_denied). */
  description: string
}

/**
 * Microsoft's admin-consent *request* flow redirects "Back to app" with
 * `error=access_denied` / `AADSTS65004` even when the user submitted a request
 * (no tokens were issued yet). Treat that the same as a soft deny so we do not
 * tell people they "declined" when they asked their admin to approve.
 */
function isProviderAccessDenied(errorCode: string | undefined): boolean {
  return errorCode === 'access_denied'
}

function titleForError(errorCode: string | undefined): string {
  if (isProviderAccessDenied(errorCode)) return 'Waiting for admin approval'
  return 'Sign-in couldn’t be completed'
}

function descriptionForError(errorCode: string | undefined, fallbackDescription: string): string {
  // Microsoft admin-consent *request* "Back to app" and a true Cancel both
  // commonly return `access_denied` / AADSTS65004 — one soft message covers both.
  if (isProviderAccessDenied(errorCode)) {
    return 'If you just sent an admin approval request, you’re done for now — connect again after your admin approves. If you cancelled, you can try connecting again anytime.'
  }
  return fallbackDescription
}

/**
 * Interactive half of `/oauth-error`: explain the outcome and send the person
 * back to where Connect started via `sim.oauth-return-context`. Clearing that
 * context avoids `useOAuthReturnRouter` treating the unfinished link as a
 * failed credential connect when they land.
 */
export function OAuthErrorContent({ errorCode, description }: OAuthErrorContentProps) {
  const title = titleForError(errorCode)
  const body = descriptionForError(errorCode, description)

  const returnToApp = () => {
    const ctx = readOAuthReturnContext()
    const href = resolveOAuthErrorReturnPath(ctx)
    consumeOAuthReturnContext()
    window.location.assign(href)
  }

  return (
    <DesktopHandoffShell title={title} description={body}>
      <Chip variant='primary' onClick={returnToApp}>
        Return to Arena AI
      </Chip>
    </DesktopHandoffShell>
  )
}
