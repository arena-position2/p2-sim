'use client'

import { useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import type { WorkspaceHostContext } from '@/lib/api/contracts/workspaces'
import { useSession } from '@/lib/auth/auth-client'
import { isArenaBilling } from '@/lib/billing/arena/env'
import { canManageWorkspaceBilling } from '@/lib/billing/workspace-permissions'
import { APP_ENTRY_PATH } from '@/lib/navigation/paths'
import {
  popSettingsReturnUrl as consumeSettingsReturnUrl,
  SETTINGS_RETURN_URL_KEY,
  rememberSettingsReturnUrl as storeSettingsReturnUrl,
} from '@/lib/navigation/settings-return'
import { openSettingsPageEvent } from '@/app/arenaMixpanelEvents/mixpanelEvents'
import { useOptionalWorkspaceHostContext } from '@/app/workspace/[workspaceId]/providers/workspace-host-provider'
import type { SettingsSection } from '@/app/workspace/[workspaceId]/settings/navigation'

interface SettingsNavigationOptions {
  section?: SettingsSection
  mcpServerId?: string
  browserView?: 'passwords'
  browserImport?: boolean
  browserClear?: boolean
}

interface UseSettingsNavigationReturn {
  navigateToSettings: (options?: SettingsNavigationOptions) => void
  getSettingsHref: (options?: SettingsNavigationOptions) => string
  popSettingsReturnUrl: (fallback: string) => string
  /** Stores the current page so a later settings Back can return to it. */
  rememberSettingsReturnUrl: () => void
  /** Drops a stored return page when settings was opened but never routed to. */
  clearSettingsReturnUrl: () => void
}

interface ResolveSettingsHrefParams {
  options?: SettingsNavigationOptions
  workspaceId?: string
  hostContext?: WorkspaceHostContext
  viewerUserId?: string
}

export function resolveSettingsHref({
  options,
  workspaceId,
  hostContext,
  viewerUserId,
}: ResolveSettingsHrefParams): string {
  if (!workspaceId) return APP_ENTRY_PATH
  let section = options?.section || 'general'
  if (section === 'billing' && isArenaBilling()) {
    section = 'arena-billing'
  }
  if (
    (section === 'billing' || section === 'arena-billing') &&
    hostContext &&
    !canManageWorkspaceBilling(hostContext, viewerUserId)
  ) {
    return `/workspace/${workspaceId}/settings/arena-usage`
  }

  const searchParams = new URLSearchParams()
  if (options?.mcpServerId) searchParams.set('mcpServerId', options.mcpServerId)
  if (options?.browserView) searchParams.set('browserView', options.browserView)
  if (options?.browserImport) searchParams.set('browserImport', '1')
  if (options?.browserClear) searchParams.set('browserClear', '1')
  const query = searchParams.toString()
  const pathname = `/workspace/${workspaceId}/settings/${section}`
  return query ? `${pathname}?${query}` : pathname
}

export function useSettingsNavigation(): UseSettingsNavigationReturn {
  const router = useRouter()
  const params = useParams<{ workspaceId?: string }>()
  const workspaceId = params.workspaceId
  const hostContext = useOptionalWorkspaceHostContext()
  const { data: session } = useSession()

  const settingsPrefix = `/workspace/${workspaceId}/settings/`

  const getSettingsHref = useCallback(
    (options?: SettingsNavigationOptions): string =>
      resolveSettingsHref({
        options,
        workspaceId,
        hostContext: hostContext ?? undefined,
        viewerUserId: session?.user?.id,
      }),
    [hostContext, session?.user?.id, workspaceId]
  )

  const popSettingsReturnUrl = useCallback(
    (fallback: string): string => consumeSettingsReturnUrl(fallback),
    []
  )

  const rememberSettingsReturnUrl = useCallback(() => {
    storeSettingsReturnUrl(getSettingsHref())
  }, [getSettingsHref])

  const clearSettingsReturnUrl = useCallback(() => {
    try {
      sessionStorage.removeItem(SETTINGS_RETURN_URL_KEY)
    } catch {}
  }, [])

  const navigateToSettings = useCallback(
    (options?: SettingsNavigationOptions) => {
      const currentPath = window.location.pathname
      if (currentPath.startsWith(settingsPrefix)) {
        router.replace(getSettingsHref(options), { scroll: false })
      } else {
        void openSettingsPageEvent({
          Section: options?.section || 'general',
        })
        storeSettingsReturnUrl(getSettingsHref(options))
        router.push(getSettingsHref(options))
      }
    },
    [router, settingsPrefix, getSettingsHref]
  )

  return {
    navigateToSettings,
    getSettingsHref,
    popSettingsReturnUrl,
    rememberSettingsReturnUrl,
    clearSettingsReturnUrl,
  }
}
