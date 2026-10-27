/**
 * @vitest-environment node
 */
import { createEnvMock, envFlagsMock } from '@sim/testing'
import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/core/config/env-flags', () => ({
  ...envFlagsMock,
  isLocalLoginEnabled: false,
  isAuthDisabled: false,
}))

vi.mock('@/lib/core/config/env', () =>
  createEnvMock({
    NEXT_PUBLIC_APP_URL: 'https://agent.thearena.ai',
    NEXT_PUBLIC_ARENA_FRONTEND_APP_URL: 'https://app.thearena.ai',
  })
)

vi.unmock('@/lib/core/utils/urls')

import { proxy } from '@/proxy'

function locationOf(response: Response): URL {
  const location = response.headers.get('location')
  if (!location) throw new Error('expected a redirect')
  return new URL(location)
}

describe('unauthenticated /chat session gate', () => {
  it('redirects to Arena sim-resume with the full chat returnTo', async () => {
    const chatUrl =
      'https://agent.thearena.ai/chat/2a5e3fb4-69a2-4897-8f76-7c96ae802c36?workspaceId=a29a4193-4407-48ae-b8df-b0ebf0cd81b2&chatId=d7233682-ce75-4404-9848-df45884f0f14'
    const response = await proxy(new NextRequest(chatUrl))
    const location = locationOf(response)

    expect(response.status).toBe(307)
    expect(location.origin).toBe('https://app.thearena.ai')
    expect(location.pathname).toBe('/sso/sim-resume')
    expect(location.searchParams.get('returnTo')).toBe(chatUrl)
  })

  it('matches /workspace unauthenticated resume behavior', async () => {
    const response = await proxy(new NextRequest('https://agent.thearena.ai/workspace/abc?tab=1'))
    const location = locationOf(response)

    expect(location.origin).toBe('https://app.thearena.ai')
    expect(location.pathname).toBe('/sso/sim-resume')
    expect(location.searchParams.get('returnTo')).toBe(
      'https://agent.thearena.ai/workspace/abc?tab=1'
    )
  })
})
