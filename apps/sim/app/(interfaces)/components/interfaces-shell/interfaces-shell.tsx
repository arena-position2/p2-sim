'use client'

import type { ReactNode } from 'react'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { DesktopTitleBarLane } from '@/app/_shell/desktop-title-bar'
import { SupportFooter } from '@/app/(auth)/components'
import { LogoShell } from '@/app/(landing)/components/logo-shell'

/**
 * Chrome for the `(interfaces)` route group (chat + resume) — the lightweight,
 * logo-only frame their entry/gate screens wear (chat email / password auth, the
 * embedded SSO gate, the "chat unavailable" message, and the resume gate).
 *
 * Generated GUI apps (`/gui-apps`) skip LogoShell: AppHeader is the only top bar
 * and already paints the Arena mark. Chat/resume still use LogoShell because their
 * live UI covers this frame with a full-screen overlay.
 *
 * It is the shared {@link LogoShell} (light, logo-only header) plus a
 * {@link SupportFooter}, except on `/gui-apps`. Content is full-width — gate forms
 * center themselves; the live chat UI renders a `fixed inset-0` overlay that covers
 * this frame, and voice mode is full-screen — so the frame is only ever visible on
 * the gate/message states, giving chat and resume the same chrome as the auth pages.
 */
interface InterfacesShellProps {
  children: ReactNode
}

function isGuiAppsPath(pathname: string): boolean {
  return pathname === '/gui-apps' || pathname.startsWith('/gui-apps/')
}

export function InterfacesShell({ children }: InterfacesShellProps) {
  const pathname = usePathname() ?? ''
  if (isGuiAppsPath(pathname)) {
    return (
      <div className='light desktop-title-bar-page relative flex flex-col bg-(--bg) text-(--text-primary)'>
        <DesktopTitleBarLane />
        <main className='flex flex-1 flex-col'>{children}</main>
      </div>
    )
  }

  return (
    <LogoShell
      footer={<SupportFooter position='static' />}
      logo={<Image src={arenaLogo} alt='Arena' width={30} height={30} priority />}
      logoLabel='Arena home'
    >
      {children}
    </LogoShell>
  )
}
