'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import { SettingsHeaderProvider, SettingsHeaderShell } from '@/components/settings/settings-header'
import { SettingsSectionProvider } from '@/components/settings/settings-panel'
import { useSettingsBrowserNavigation } from '@/components/settings/use-settings-browser-navigation'
import { useTheme } from 'next-themes'
import { ArenaThemeSync } from '@/app/workspace/[workspaceId]/providers/arena-theme-sync'

const ARENA_EMBED_THEMES = ['light', 'dark', 'system'] as const

function isArenaEmbedTheme(value: string): value is (typeof ARENA_EMBED_THEMES)[number] {
  return ARENA_EMBED_THEMES.some((theme) => theme === value)
}

/**
 * Applies `?theme=` once on embed load. Later changes come from the Arena
 * theme SSE listener, which must not be overwritten by a stale query param.
 */
function useArenaEmbedTheme() {
  const { setTheme } = useTheme()
  const appliedRef = useRef(false)

  useEffect(() => {
    if (appliedRef.current) return
    appliedRef.current = true

    const theme = new URLSearchParams(window.location.search).get('theme')
    if (theme && isArenaEmbedTheme(theme)) {
      setTheme(theme)
    }
  }, [setTheme])
}

interface ArenaGeneralSettingsMeta {
  label: string
  description: string
  docsLink?: string
}

interface ArenaGeneralSettingsShellProps {
  children: ReactNode
  meta: ArenaGeneralSettingsMeta
}

/**
 * Account-plane chrome for Arena General settings. Same header + panel shell as
 * workspace settings, without a workspace id in the route.
 *
 * This page is a sibling of `[workspaceId]`, so it does not inherit that
 * layout's theme listener. The iframe must subscribe itself or an Arena theme
 * PATCH never updates the embedded document.
 */
export function ArenaGeneralSettingsShell({ children, meta }: ArenaGeneralSettingsShellProps) {
  useSettingsBrowserNavigation()
  useArenaEmbedTheme()

  return (
    <div className='flex h-screen w-full flex-col overflow-hidden bg-[var(--bg)]'>
      <ArenaThemeSync />
      <div className='min-h-0 w-full flex-1'>
        <SettingsHeaderProvider>
          <SettingsHeaderShell
            meta={{ title: meta.label, description: meta.description, docsLink: meta.docsLink }}
          >
            <SettingsSectionProvider plane='account' section='general' meta={meta}>
              {children}
            </SettingsSectionProvider>
          </SettingsHeaderShell>
        </SettingsHeaderProvider>
      </div>
    </div>
  )
}
