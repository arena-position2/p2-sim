import type { Metadata } from 'next'
import {
  DISPOSABLE_EMAIL_ERROR_CODE,
  DISPOSABLE_EMAIL_MESSAGE,
  SSO_REQUIRED_ERROR_CODE,
  SSO_REQUIRED_MESSAGE,
} from '@/lib/auth/constants'
import { OAuthErrorContent } from '@/app/oauth-error/oauth-error-content'

export const metadata: Metadata = {
  title: 'Sign-in couldn’t be completed',
  robots: { index: false },
}

export const dynamic = 'force-dynamic'

interface OAuthErrorPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Landing page for OAuth flows that end in an error before the flow state can
 * be parsed — most commonly the user clicking "Cancel"/"Deny" at the
 * provider's consent screen (`?error=access_denied`), or Microsoft's
 * admin-consent *request* "Back to app" which also returns `access_denied`
 * because no tokens were issued yet. Better Auth redirects such errors to
 * `onAPIError.errorURL` (this page) BEFORE it can honor a per-flow
 * `errorCallbackURL`, so the connect modal's `callbackURL` never runs.
 *
 * The page explains the outcome and offers a CTA back to the place Connect
 * started (`sim.oauth-return-context`). It never restarts OAuth.
 */
const FRIENDLY: Record<string, string> = {
  access_denied: 'You declined the request at the provider, so nothing was connected.',
  oAuth_code_missing: 'The provider didn’t return a valid response. Please try again.',
  /**
   * A closed `REGISTRATION_MODE` rejecting a first-time social sign-in. Better Auth
   * reports this as `signup disabled`, which it slugs into the `error` param.
   * Without a message here the visitor is told to "try again", which can never
   * succeed.
   */
  signup_disabled:
    'Account creation is disabled on this instance. Ask your admin to create an account for you.',
  /**
   * Better Auth refuses to link an untrusted provider onto an existing account
   * (`accountLinking.trustedProviders`). Retrying reproduces it exactly, so the
   * generic "try again" strands the user — name the recovery path instead.
   */
  account_not_linked:
    'An account already exists for this email address. Sign in using the method you originally signed up with.',
  /**
   * The person's organization requires single sign-on, so a social sign-in is
   * refused. Retrying the same provider can never succeed — name the way in.
   */
  [SSO_REQUIRED_ERROR_CODE]: SSO_REQUIRED_MESSAGE,
  /**
   * Account creation refused for a disposable email domain. Better Auth 1.7 redirects with the
   * error's code; 1.6 redirects with its message, spaces joined by underscores.
   */
  [DISPOSABLE_EMAIL_ERROR_CODE]: DISPOSABLE_EMAIL_MESSAGE,
  [DISPOSABLE_EMAIL_MESSAGE.split(' ').join('_')]: DISPOSABLE_EMAIL_MESSAGE,
  /** The provider returned no email claim, so there is nothing to sign in as. */
  email_not_found:
    'Your identity provider didn’t share an email address with us, so we couldn’t complete sign-in. Please contact your administrator.',
}

function messageForError(code: string | undefined): string {
  if (code && FRIENDLY[code]) return FRIENDLY[code]
  return 'The sign-in couldn’t be completed. Please try again.'
}

function firstSearchParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export default async function OAuthErrorPage({ searchParams }: OAuthErrorPageProps) {
  const params = await searchParams
  const errorCode = firstSearchParam(params.error)

  return <OAuthErrorContent errorCode={errorCode} description={messageForError(errorCode)} />
}
