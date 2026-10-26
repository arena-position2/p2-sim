/**
 * @vitest-environment node
 */
import { authClientMock } from '@sim/testing/mocks/auth-client.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceHostContext } from '@/lib/api/contracts/workspaces'

const { mockIsArenaBilling } = vi.hoisted(() => ({
  mockIsArenaBilling: vi.fn(() => true),
}))

/**
 * `@/lib/auth/auth-client` builds a Better Auth client at module scope, which
 * throws when NEXT_PUBLIC_APP_URL is absent from the environment (and under
 * `isolate: false` an earlier file may have imported the graph in a polluted
 * env). This test exercises the pure `resolveSettingsHref` helper, so stub the
 * client module out entirely.
 */
vi.mock('@/lib/auth/auth-client', () => authClientMock)
vi.mock('@/lib/billing/arena/env', () => ({
  isArenaBilling: mockIsArenaBilling,
}))

import { resolveSettingsHref } from '@/hooks/use-settings-navigation'

const HOST_CONTEXT: WorkspaceHostContext = {
  workspace: {
    id: 'workspace-b',
    name: 'Workspace B',
    workspaceMode: 'organization',
    billedAccountUserId: 'owner-b',
  },
  hostOrganizationId: 'org-b',
  ownerBilling: {
    plan: 'team_25000',
    status: 'active',
    isPaid: true,
    isPro: false,
    isTeam: true,
    isEnterprise: false,
    isOrgScoped: true,
    organizationId: 'org-b',
    billingInterval: 'month',
    billingBlocked: false,
    billingBlockedReason: null,
  },
  viewer: {
    permission: 'admin',
    isHostOrganizationMember: false,
    isHostOrganizationAdmin: false,
  },
}

describe('resolveSettingsHref unified settings navigation', () => {
  beforeEach(() => {
    mockIsArenaBilling.mockReturnValue(true)
  })

  it('routes agent access requests through workspace settings', () => {
    expect(
      resolveSettingsHref({
        options: { section: 'agent-access-request' },
        workspaceId: 'workspace-b',
      })
    ).toBe('/workspace/workspace-b/settings/agent-access-request')
  })

  it('preserves MCP server query parameters for workspace settings', () => {
    expect(
      resolveSettingsHref({
        options: { section: 'mcp', mcpServerId: 'server/a' },
        workspaceId: 'workspace-b',
      })
    ).toBe('/workspace/workspace-b/settings/mcp?mcpServerId=server%2Fa')
  })

  it('sends viewers who cannot manage billing to the usage settings section', () => {
    expect(
      resolveSettingsHref({
        options: { section: 'billing' },
        workspaceId: 'workspace-b',
        hostContext: HOST_CONTEXT,
        viewerUserId: 'external-a',
      })
    ).toBe('/workspace/workspace-b/settings/arena-usage')
  })

  it('sends non-admin org members away from arena billing to usage', () => {
    expect(
      resolveSettingsHref({
        options: { section: 'arena-billing' },
        workspaceId: 'workspace-b',
        hostContext: HOST_CONTEXT,
        viewerUserId: 'external-a',
      })
    ).toBe('/workspace/workspace-b/settings/arena-usage')
  })

  it('maps billing to arena-billing for Arena admins who can manage the payer', () => {
    mockIsArenaBilling.mockReturnValue(true)

    expect(
      resolveSettingsHref({
        options: { section: 'billing' },
        workspaceId: 'workspace-b',
        hostContext: {
          ...HOST_CONTEXT,
          viewer: {
            ...HOST_CONTEXT.viewer,
            isHostOrganizationMember: true,
            isHostOrganizationAdmin: true,
          },
        },
        viewerUserId: 'admin-b',
      })
    ).toBe('/workspace/workspace-b/settings/arena-billing')
  })

  it('keeps the billed owner of a personal workspace on arena-billing under Arena', () => {
    mockIsArenaBilling.mockReturnValue(true)

    expect(
      resolveSettingsHref({
        options: { section: 'billing' },
        workspaceId: 'workspace-b',
        hostContext: {
          ...HOST_CONTEXT,
          workspace: {
            ...HOST_CONTEXT.workspace,
            workspaceMode: 'personal',
          },
          hostOrganizationId: null,
          ownerBilling: {
            ...HOST_CONTEXT.ownerBilling,
            isOrgScoped: false,
            organizationId: null,
          },
        },
        viewerUserId: 'owner-b',
      })
    ).toBe('/workspace/workspace-b/settings/arena-billing')
  })

  it('keeps upstream billing section when Arena billing is off', () => {
    mockIsArenaBilling.mockReturnValue(false)

    expect(
      resolveSettingsHref({
        options: { section: 'billing' },
        workspaceId: 'workspace-b',
        hostContext: {
          ...HOST_CONTEXT,
          viewer: {
            ...HOST_CONTEXT.viewer,
            isHostOrganizationMember: true,
            isHostOrganizationAdmin: true,
          },
        },
        viewerUserId: 'admin-b',
      })
    ).toBe('/workspace/workspace-b/settings/billing')
  })
})
