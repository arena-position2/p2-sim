/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetLocalCopilotUserAccess, mockGetLocalCopilotConfig } = vi.hoisted(() => ({
  mockGetLocalCopilotUserAccess: vi.fn(),
  mockGetLocalCopilotConfig: vi.fn(),
}))

vi.mock('@/local-copilot/lib/access', () => ({
  getLocalCopilotUserAccess: mockGetLocalCopilotUserAccess,
  isLocalCopilotEnabledForUser: vi.fn(async (userId: string | null | undefined) => {
    const access = await mockGetLocalCopilotUserAccess(userId)
    return Boolean(access.hasAccess || access.localOnly)
  }),
}))

vi.mock('@/local-copilot/lib/config', () => ({
  getLocalCopilotConfig: mockGetLocalCopilotConfig,
}))

import { shouldRouteToLocalCopilot } from '@/local-copilot/lib/routing'

describe('shouldRouteToLocalCopilot', () => {
  beforeEach(() => {
    mockGetLocalCopilotUserAccess.mockReset()
    mockGetLocalCopilotConfig.mockReset()
    mockGetLocalCopilotConfig.mockReturnValue({
      enabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test-key',
    })
  })

  it('routes allowlisted users with the Local preference to Arena Copilot', async () => {
    mockGetLocalCopilotUserAccess.mockResolvedValue({
      hasAccess: true,
      localOnly: false,
      defaultModel: 'anthropic/claude-sonnet-4-6',
    })

    await expect(
      shouldRouteToLocalCopilot({
        workspaceId: 'ws-1',
        userId: 'user-1',
        copilotBackend: 'local',
      })
    ).resolves.toBe(true)
  })

  it('lets full-access users opt into Cloud (external) and skip Local routing', async () => {
    mockGetLocalCopilotUserAccess.mockResolvedValue({
      hasAccess: true,
      localOnly: false,
      defaultModel: 'anthropic/claude-sonnet-4-6',
    })

    await expect(
      shouldRouteToLocalCopilot({
        workspaceId: 'ws-1',
        userId: 'user-1',
        copilotBackend: 'external',
      })
    ).resolves.toBe(false)
  })

  it('keeps local-only users on Local even when a stale external preference is present', async () => {
    mockGetLocalCopilotUserAccess.mockResolvedValue({
      hasAccess: false,
      localOnly: true,
      defaultModel: 'anthropic/claude-sonnet-4-6',
    })

    await expect(
      shouldRouteToLocalCopilot({
        workspaceId: 'ws-1',
        userId: 'user-1',
        copilotBackend: 'external',
      })
    ).resolves.toBe(true)
  })

  it('does not route users who are not on the allowlist', async () => {
    mockGetLocalCopilotUserAccess.mockResolvedValue({
      hasAccess: false,
      localOnly: false,
      defaultModel: 'anthropic/claude-sonnet-4-6',
    })

    await expect(
      shouldRouteToLocalCopilot({
        workspaceId: 'ws-1',
        userId: 'user-1',
        copilotBackend: 'local',
      })
    ).resolves.toBe(false)
  })

  it('does not route when workspace or user context is missing', async () => {
    mockGetLocalCopilotUserAccess.mockResolvedValue({
      hasAccess: true,
      localOnly: false,
      defaultModel: 'anthropic/claude-sonnet-4-6',
    })

    await expect(
      shouldRouteToLocalCopilot({
        userId: 'user-1',
        copilotBackend: 'local',
      })
    ).resolves.toBe(false)
  })
})
