'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DesktopSettingsSurface } from '@/components/settings/navigation'
import { ORGANIZATION_PLANE_UNIFIED_SECTIONS } from '@/components/settings/navigation'
import { useSession } from '@/lib/auth/auth-client'
import { getSubscriptionAccessState } from '@/lib/billing/client'
import { canManageWorkspaceBilling } from '@/lib/billing/workspace-permissions'
import { useDeploymentShape } from '@/lib/core/config/deployment-shape'
import { isBillingEnabled, isHosted } from '@/lib/core/config/env-flags'
import { hasBrowserAgent, hasDesktopSettings, hasTerminal } from '@/lib/desktop'
import { isPlatformAdminEmail } from '@/lib/permissions/platform-admin-emails'
import { useWorkspaceHostContext } from '@/app/workspace/[workspaceId]/providers/workspace-host-provider'
import { useUserPermissionsContext } from '@/app/workspace/[workspaceId]/providers/workspace-permissions-provider'
import {
  allNavigationItems,
  type NavigationItem,
  type SettingsSection,
  sectionConfig,
} from '@/app/workspace/[workspaceId]/settings/navigation'
import { useSSOProviders } from '@/ee/sso/hooks/sso'
import { useForkingAvailable } from '@/ee/workspace-forking/hooks/use-forking-available'
import { useGeneralSettings } from '@/hooks/queries/general-settings'
import { useWorkspacePermissionsQuery } from '@/hooks/queries/workspace'
import { usePermissionConfig } from '@/hooks/use-permission-config'

/**
 * First routable settings page the viewer can open, in the same order as the
 * settings sidebar. External links (Docs) are skipped.
 */
export function firstAccessibleSettingsSection(
  items: readonly NavigationItem[]
): SettingsSection | null {
  for (const { key } of sectionConfig) {
    const match = items
      .filter((item) => item.section === key && !item.externalUrl)
      .sort((left, right) => left.order - right.order)[0]
    if (match) return match.id
  }
  return null
}

/**
 * Settings sidebar entries the current viewer is allowed to open. Same gates as
 * the settings sidebar, so a More-menu shortcut never lands on a hidden page.
 */
export function useVisibleSettingsNavigation(workspaceId: string): NavigationItem[] {
  const [desktopSurfaces, setDesktopSurfaces] = useState<Record<DesktopSettingsSurface, boolean>>({
    settings: false,
    browser: false,
    terminal: false,
  })

  const { data: session } = useSession()
  const hostContext = useWorkspaceHostContext()
  const { data: generalSettings } = useGeneralSettings()
  const { data: workspacePermissions } = useWorkspacePermissionsQuery(workspaceId)
  const { data: ssoProvidersData, isLoading: isLoadingSSO } = useSSOProviders({
    enabled: !isHosted,
  })
  const { config: permissionConfig } = usePermissionConfig()
  const forkingAvailable = useForkingAvailable(workspaceId)
  const { canAdmin: canAdminWorkspace } = useUserPermissionsContext()
  const { hosted } = useDeploymentShape()

  const userId = session?.user?.id
  const isOrgAdminOrOwner = hostContext.viewer.isHostOrganizationAdmin
  const subscriptionAccess = getSubscriptionAccessState(hostContext.ownerBilling)
  const hasEnterprisePlan = subscriptionAccess.hasUsableEnterpriseAccess
  const isEnterprisePlan = subscriptionAccess.isEnterprise
  const isSuperUser = session?.user?.role === 'admin'
  const isListedPlatformAdminEmail = isPlatformAdminEmail(session?.user?.email)

  const isSSOProviderOwner = useMemo(() => {
    if (isHosted) return null
    if (!userId || isLoadingSSO) return null
    return ssoProvidersData?.providers?.some((provider) => provider.userId === userId) || false
  }, [userId, ssoProvidersData?.providers, isLoadingSSO])

  useEffect(() => {
    setDesktopSurfaces({
      settings: hasDesktopSettings(),
      browser: hasBrowserAgent(),
      terminal: hasTerminal(),
    })
  }, [])

  return useMemo(() => {
    return allNavigationItems.filter((item) => {
      if (item.requiresDesktopSurface && !desktopSurfaces[item.requiresDesktopSurface]) {
        return false
      }

      if (item.hideWhenBillingDisabled && !isBillingEnabled) {
        return false
      }

      // Arena billing is the workspace Subscription entry. Upstream `billing`
      // stays routable for account-plane links and is omitted from this sidebar
      // so managers see one Billing row, matching version-6-main.
      if (item.id === 'billing') {
        return false
      }

      if (item.requiresSelfHosted && (isHosted || hosted)) {
        return false
      }

      if (ORGANIZATION_PLANE_UNIFIED_SECTIONS.has(item.id) && !isOrgAdminOrOwner) {
        return false
      }

      if (item.id === 'arena-billing' && !canManageWorkspaceBilling(hostContext, userId)) {
        return false
      }

      if (item.hideForEnterprise && isEnterprisePlan) {
        return false
      }

      if (item.id === 'secrets' && permissionConfig.hideSecretsTab) {
        return false
      }
      if (item.id === 'apikeys' && permissionConfig.hideApiKeysTab) {
        return false
      }
      if (item.id === 'inbox' && permissionConfig.hideInboxTab) {
        return false
      }
      if (item.id === 'mcp' && permissionConfig.disableMcpTools) {
        return false
      }
      if (item.id === 'custom-tools' && permissionConfig.disableCustomTools) {
        return false
      }
      if (item.id === 'forks' && !(forkingAvailable && canAdminWorkspace)) {
        return false
      }
      if (
        item.id === 'connected-accounts' &&
        (!hostContext.features?.credentialGroups || !canAdminWorkspace)
      ) {
        return false
      }

      if (item.selfHostedOverride && !isHosted) {
        if (ORGANIZATION_PLANE_UNIFIED_SECTIONS.has(item.id) && !isOrgAdminOrOwner) {
          return false
        }
        if (item.id === 'sso') {
          const hasProviders = (ssoProvidersData?.providers?.length ?? 0) > 0
          return !hasProviders || isSSOProviderOwner === true
        }
        return true
      }

      const orgAdminSatisfied = isOrgAdminOrOwner || item.allowNonOrgAdmin

      if (
        item.requiresEnterprise &&
        (!hasEnterprisePlan || !orgAdminSatisfied) &&
        !item.showWhenLocked
      ) {
        return false
      }

      if (item.requiresMax && !subscriptionAccess.hasUsableMaxAccess && !item.showWhenLocked) {
        return false
      }

      if (item.requiresHosted && !isHosted) {
        return false
      }

      const superUserModeEnabled = generalSettings?.superUserModeEnabled ?? false
      const effectiveSuperUser = isSuperUser && superUserModeEnabled
      if (item.requiresSuperUser && !effectiveSuperUser) {
        return false
      }

      if (item.requiresAdminRole && !isSuperUser) {
        return false
      }

      if (item.requiresPlatformAdminEmail && !isListedPlatformAdminEmail) {
        return false
      }

      if (item.requiresWorkspaceAdmin && !workspacePermissions?.viewer?.isAdmin) {
        return false
      }

      return true
    })
  }, [
    hasEnterprisePlan,
    isEnterprisePlan,
    subscriptionAccess.hasUsableMaxAccess,
    hostContext,
    userId,
    isOrgAdminOrOwner,
    isSSOProviderOwner,
    ssoProvidersData?.providers?.length,
    permissionConfig,
    isSuperUser,
    isListedPlatformAdminEmail,
    generalSettings?.superUserModeEnabled,
    workspacePermissions?.viewer?.isAdmin,
    forkingAvailable,
    canAdminWorkspace,
    desktopSurfaces,
    hosted,
  ])
}
