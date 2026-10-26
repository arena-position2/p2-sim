const VIDEO_BUILDER_AGENT_HOST = 'video-builder-agent.vercel.app'

/** True only for the video builder app. Other deployed redirect URLs are false. */
export function isVideoBuilderAgentUrl(redirectUrl: string | null | undefined): boolean {
  if (!redirectUrl?.trim()) return false
  try {
    return new URL(redirectUrl).hostname === VIDEO_BUILDER_AGENT_HOST
  } catch {
    return false
  }
}

/**
 * Puts the logged-in Arena email on the video builder app URL only.
 * Every other redirect, including other deployed apps, is returned unchanged.
 */
export function withLoggedInEmailOnVideoAgentUrl(
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

  if (url.hostname !== VIDEO_BUILDER_AGENT_HOST) return redirectUrl

  url.searchParams.set('emailId', email)
  return url.toString()
}
