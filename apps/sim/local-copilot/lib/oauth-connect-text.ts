export interface OAuthConnectControl {
  type: 'credential_link'
  provider: string
  url: string
}

export interface OAuthConnectBatchControl {
  type: 'credential_links'
  links: OAuthConnectControl[]
}

/**
 * Builds validated structured control data after oauth_get_auth_link succeeds.
 */
export function buildOAuthConnectControl(result: unknown): OAuthConnectControl | null {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
  if (!record) return null

  const url =
    (typeof record.oauth_url === 'string' && record.oauth_url.trim()) ||
    (typeof record.url === 'string' && record.url.trim()) ||
    (typeof record.authorizationUrl === 'string' && record.authorizationUrl.trim()) ||
    ''
  if (!url) return null

  try {
    if (new URL(url).protocol !== 'https:') return null
  } catch {
    return null
  }

  const provider =
    (typeof record.provider === 'string' && record.provider.trim()) ||
    (typeof record.providerName === 'string' && record.providerName.trim()) ||
    (typeof record.serviceName === 'string' && record.serviceName.trim()) ||
    'account'

  return {
    type: 'credential_link',
    provider,
    url,
  }
}

function joinProviderNames(providers: readonly string[]): string {
  if (providers.length <= 1) return providers[0] ?? 'the account'
  if (providers.length === 2) return `${providers[0]} and ${providers[1]}`
  return `${providers.slice(0, -1).join(', ')}, and ${providers[providers.length - 1]}`
}

/**
 * One credential tag for every authorize link gathered in the turn.
 * A single link stays an object; several links are one array so the card has one continue control.
 */
export function formatOAuthConnectBatch(controls: readonly OAuthConnectControl[]): string {
  const links = controls.map((control) => ({
    type: 'link' as const,
    provider: control.provider,
    value: control.url,
  }))
  const names = joinProviderNames(links.map((link) => link.provider))
  const body = links.length === 1 ? links[0] : links
  return `Connect ${names}, then continue.\n\n<credential>${JSON.stringify(body)}</credential>`
}

/**
 * Converts trusted OAuth control data into the legacy chat tag representation.
 */
export function formatOAuthConnectCredentialTag(control: OAuthConnectControl): string {
  return formatOAuthConnectBatch([control])
}
