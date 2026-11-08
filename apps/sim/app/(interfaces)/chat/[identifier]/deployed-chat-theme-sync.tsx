'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import { requestJson } from '@/lib/api/client/request'
import { getUserSettingsContract } from '@/lib/api/contracts/user'
import { useSession } from '@/lib/auth/client'
import { syncThemeToNextThemes } from '@/lib/core/utils/theme'
import { ArenaThemeSync } from '@/app/workspace/[workspaceId]/providers/arena-theme-sync'
import {
  GENERAL_SETTINGS_STALE_TIME,
  generalSettingsKeys,
  mapGeneralSettingsResponse,
} from '@/hooks/queries/general-settings'

const ARENA_EMBED_THEMES = new Set(['light', 'dark', 'system'])

/**
 * Applies `?theme=` once on embed load. Later changes come from Arena theme SSE.
 */
function useArenaEmbedTheme() {
  const { setTheme } = useTheme()
  const appliedRef = useRef(false)
  const [queryThemeApplied, setQueryThemeApplied] = useState(false)

  useEffect(() => {
    if (appliedRef.current) return
    appliedRef.current = true

    const theme = new URLSearchParams(window.location.search).get('theme')
    if (theme && ARENA_EMBED_THEMES.has(theme)) {
      setTheme(theme)
      setQueryThemeApplied(true)
    }
  }, [setTheme])

  return queryThemeApplied
}

/**
 * When the chat is opened after Arena already stored light/dark in settings,
 * localStorage may still hold the previous theme. Hydrate from settings so the
 * page matches DB until the next SSE event.
 */
function useDeployedChatSettingsTheme(enabled: boolean) {
  useQuery({
    queryKey: generalSettingsKeys.settings(),
    queryFn: async ({ signal }) => {
      const { data } = await requestJson(getUserSettingsContract, { signal })
      const settings = mapGeneralSettingsResponse(data)
      syncThemeToNextThemes(settings.theme)
      return settings
    },
    enabled,
    staleTime: GENERAL_SETTINGS_STALE_TIME,
  })
}

/**
 * Deployed chat does not inherit the workspace layout theme listener. Without
 * this, Arena theme PATCH/SSE never updates the chat document, so a light
 * preference can leave an earlier dark `sim-theme` stuck on the page.
 */
export function DeployedChatThemeSync() {
  const queryThemeApplied = useArenaEmbedTheme()
  const { data: session } = useSession()
  const sessionEmail = session?.user?.email

  useDeployedChatSettingsTheme(Boolean(sessionEmail) && !queryThemeApplied)

  return <ArenaThemeSync />
}
