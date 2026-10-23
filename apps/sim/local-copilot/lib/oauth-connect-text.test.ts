/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  formatOAuthConnectBatch,
  formatOAuthConnectCredentialTag,
} from '@/local-copilot/lib/oauth-connect-text'
import { formatTrustedControl } from '@/local-copilot/lib/security/trusted-controls'

const gmail = {
  type: 'credential_link' as const,
  provider: 'Gmail',
  url: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
}
const calendar = {
  type: 'credential_link' as const,
  provider: 'Google Calendar',
  url: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-calendar',
}

describe('formatOAuthConnectBatch', () => {
  it('keeps one link as a single credential object', () => {
    const text = formatOAuthConnectCredentialTag(gmail)
    expect(text).toContain('Connect Gmail, then continue.')
    expect(text).toContain(
      '<credential>{"type":"link","provider":"Gmail","value":"https://sim.test/api/auth/oauth2/authorize?providerId=google-email"}</credential>'
    )
  })

  it('puts every link from the round in one tag', () => {
    const text = formatTrustedControl({ type: 'credential_links', links: [gmail, calendar] })
    expect(text.startsWith('Connect Gmail and Google Calendar, then continue.')).toBe(true)
    expect(text.match(/<credential>/g)).toHaveLength(1)
    expect(text).toContain('"provider":"Google Calendar"')
  })

  it('names three providers in one sentence', () => {
    const text = formatOAuthConnectBatch([
      gmail,
      calendar,
      {
        type: 'credential_link',
        provider: 'Slack',
        url: 'https://sim.test/api/auth/oauth2/authorize?providerId=slack',
      },
    ])
    expect(text.startsWith('Connect Gmail, Google Calendar, and Slack, then continue.')).toBe(true)
  })
})
