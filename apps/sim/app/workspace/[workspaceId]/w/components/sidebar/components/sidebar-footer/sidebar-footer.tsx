'use client'

import type { SVGProps } from 'react'
import { chipContentLabelClass, chipVariants, cn } from '@sim/emcn'
import type { SettingsSection } from '@/app/workspace/[workspaceId]/settings/navigation'
import { SidebarTooltip } from '@/app/workspace/[workspaceId]/w/components/sidebar/components/sidebar-tooltip'
import { SIDEBAR_RAIL_CHIP_CLASS } from '@/app/workspace/[workspaceId]/w/components/sidebar/constants'

/**
 * Circle with three horizontal dots — matches HelpCircle stroke geometry so it
 * sits flush with the other sidebar rail icons.
 */
function MoreCircle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width='24'
      height='24'
      viewBox='-1 -2 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.55'
      strokeLinecap='round'
      strokeLinejoin='round'
      xmlns='http://www.w3.org/2000/svg'
      aria-hidden='true'
      {...props}
    >
      <circle cx='10.25' cy='9.75' r='9' />
      <circle cx='6.25' cy='9.75' r='0.75' />
      <circle cx='10.25' cy='9.75' r='0.75' />
      <circle cx='14.25' cy='9.75' r='0.75' />
    </svg>
  )
}

interface SidebarFooterProps {
  workspaceId: string
  isCollapsed: boolean
  showCollapsedTooltips: boolean
  /** Routes to a settings section. Used by callers that already know the destination. */
  onOpenSettings: (section: SettingsSection) => void
  /** Opens the settings left nav without changing the current page. */
  onOpenSettingsMenu: () => void
  /** @deprecated Help moved to Settings → Help; kept for call-site compatibility. */
  onOpenDocs: () => void
  /** @deprecated Help moved to Settings → Help; kept for call-site compatibility. */
  onJoinSlack: () => void
  /** @deprecated Help moved to Settings → Help; kept for call-site compatibility. */
  onContactSupport: () => void
}

/**
 * Pinned bottom bar of the workspace sidebar. More opens the settings list in
 * place; a section is not routed until the user clicks it.
 */
export function SidebarFooter({
  isCollapsed,
  showCollapsedTooltips,
  onOpenSettingsMenu,
}: SidebarFooterProps) {
  return (
    <div className='flex flex-shrink-0 border-t px-2 pt-[9px] pb-2'>
      <div className={cn('flex min-w-0', !isCollapsed && 'w-full flex-1')}>
        <SidebarTooltip label='More' enabled={showCollapsedTooltips}>
          {/* Opens the settings left nav in place. Do not route from this click. */}
          <button
            type='button'
            data-item-id='profile'
            className={cn(
              chipVariants({ fullWidth: true }),
              isCollapsed ? 'min-w-0' : 'w-full',
              SIDEBAR_RAIL_CHIP_CLASS
            )}
            onClick={onOpenSettingsMenu}
          >
            <MoreCircle className='size-[14px] flex-shrink-0 text-[var(--text-icon)]' />
            <span className={cn('sidebar-collapse-hide', chipContentLabelClass)}>More</span>
          </button>
        </SidebarTooltip>
      </div>
    </div>
  )
}
