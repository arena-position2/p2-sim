import type { ReactNode } from 'react'
import { DesktopTitleBarLane } from '@/app/_shell/desktop-title-bar'

interface AgentAccessRequestLayoutProps {
  children: ReactNode
}

export default function AgentAccessRequestLayout({ children }: AgentAccessRequestLayoutProps) {
  return (
    <div className='desktop-title-bar-page flex h-dvh flex-col bg-[var(--bg)]'>
      <DesktopTitleBarLane />
      <div className='min-h-0 flex-1'>{children}</div>
    </div>
  )
}
