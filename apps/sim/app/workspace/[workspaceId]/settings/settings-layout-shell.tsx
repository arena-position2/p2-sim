'use client'

import type { ReactNode } from 'react'
import { useCallback, useLayoutEffect, useState } from 'react'
import { cn } from '@sim/emcn'
import { useQueryClient } from '@tanstack/react-query'
import { usePathname, useSearchParams } from 'next/navigation'
import { useSettingsIntentHandler } from '@/components/settings/settings-navigation-provider'
import { SettingsPendingSection } from '@/components/settings/settings-pending-section'
import { useSettingsBrowserNavigation } from '@/components/settings/use-settings-browser-navigation'
import { useWorkspaceHostContext } from '@/app/workspace/[workspaceId]/providers/workspace-host-provider'
import {
  resolveSettingsSection,
  type SettingsSection,
} from '@/app/workspace/[workspaceId]/settings/navigation'
import { warmSettingsSection } from '@/app/workspace/[workspaceId]/settings/section-warmers'

function pendingSectionMeta(section: string) {
  return resolveSettingsSection(section)?.meta ?? null
}

interface SettingsLayoutShellProps {
  children: ReactNode
}

/**
 * Settings chrome that can adjust surface styling when embedded (Arena iframe)
 * or loaded in a generic iframe, without reading `window` in a Server Component.
 *
 * Also owns the settings-wide unload guard and the sidebar navigation-intent
 * warmer: the route layout is a Server Component, so this is the closest
 * client boundary that wraps every section.
 */
export function SettingsLayoutShell({ children }: SettingsLayoutShellProps) {
  useSettingsBrowserNavigation()
  const queryClient = useQueryClient()
  const hostContext = useWorkspaceHostContext()
  const workspaceId = hostContext.workspace.id
  const billingOrganizationId = hostContext.hostOrganizationId

  useSettingsIntentHandler(
    useCallback(
      (section: string) =>
        warmSettingsSection(
          queryClient,
          { workspaceId, billingOrganizationId },
          section as SettingsSection
        ),
      [queryClient, workspaceId, billingOrganizationId]
    )
  )

  const pathname = usePathname()
  const searchParams = useSearchParams()
  const fromArenaV3 = searchParams.get('from') === 'arena_v3'
  const [inGenericIframe, setInGenericIframe] = useState(false)

  useLayoutEffect(() => {
    setInGenericIframe(typeof window !== 'undefined' && window.self !== window.top)
  }, [])

  const isIntegrationsSection = Boolean(pathname?.includes('/settings/integrations'))
  const useEmbedSurface = isIntegrationsSection && (fromArenaV3 || inGenericIframe)

  return (
    <div
      className={cn(
        'h-full overflow-y-auto [scrollbar-gutter:stable]',
        useEmbedSurface && 'bg-[var(--surface-1)]'
      )}
    >
      <div className='mx-auto flex min-h-full max-w-[940px] flex-col px-[26px] pt-9 pb-[52px]'>
        <SettingsPendingSection resolveMeta={pendingSectionMeta}>{children}</SettingsPendingSection>
      </div>
    </div>
  )
}
