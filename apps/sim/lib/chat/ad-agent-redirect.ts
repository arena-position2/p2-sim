const AD_CREATIVE_AGENT_HOST = 'ad-creative-gen-app.vercel.app'

/** True only for the Ad Creative Generator app. Other deployed redirect URLs are false. */
export function isAdCreativeAgentUrl(redirectUrl: string | null | undefined): boolean {
  if (!redirectUrl?.trim()) return false
  try {
    return new URL(redirectUrl).hostname === AD_CREATIVE_AGENT_HOST
  } catch {
    return false
  }
}

/**
 * Puts the logged-in Arena email on the Ad Creative app URL only.
 * Every other redirect is returned unchanged.
 */
export function withLoggedInEmailOnAdAgentUrl(
  redirectUrl: string,
  viewerEmail: string | null | undefined
): string {
  const email = viewerEmail?.trim()
  if (!email) return redirectUrl

  let url: URL
  try {
    url = new URL(redirectUrl)
  } catch {
    return redirectUrl
  }

  if (url.hostname !== AD_CREATIVE_AGENT_HOST) return redirectUrl

  url.searchParams.set('emailId', email)
  return url.toString()
}
