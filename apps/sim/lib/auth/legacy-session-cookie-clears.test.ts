import { describe, expect, it } from 'vitest'
import {
  buildComprehensiveSessionCookieClearHeaderValues,
  buildDomainSessionCookieClearHeaderValues,
  buildHostOnlySessionCookieClearHeaderValues,
  getParentDomainFromPublicHostname,
  isHttpsRequest,
} from '@/lib/auth/legacy-session-cookie-clears'

describe('legacy session cookie clears', () => {
  it('expires host-only better-auth session cookies', () => {
    const headers = buildHostOnlySessionCookieClearHeaderValues(true)
    expect(headers).toEqual([
      '__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      '__Secure-better-auth.session_data=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      '__Secure-better-auth.dont_remember=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    ])
  })

  it('also clears Domain= cookies for the public host and parent site', () => {
    const headers = buildComprehensiveSessionCookieClearHeaderValues('test-agent.thearena.ai', true)

    expect(headers).toEqual(
      expect.arrayContaining([
        ...buildHostOnlySessionCookieClearHeaderValues(true),
        ...buildDomainSessionCookieClearHeaderValues('test-agent.thearena.ai', true),
        ...buildDomainSessionCookieClearHeaderValues('thearena.ai', true),
        ...buildDomainSessionCookieClearHeaderValues('.thearena.ai', true),
      ])
    )
  })

  it('derives the parent domain for multi-label Arena hosts only', () => {
    expect(getParentDomainFromPublicHostname('test-agent.thearena.ai')).toBe('thearena.ai')
    expect(getParentDomainFromPublicHostname('thearena.ai')).toBeUndefined()
    expect(getParentDomainFromPublicHostname('localhost')).toBeUndefined()
  })

  it('treats X-Forwarded-Proto https as HTTPS so __Secure- cookies are cleared', () => {
    const request = new Request('http://agent.thearena.ai/logout', {
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(isHttpsRequest(request)).toBe(true)
  })
})
