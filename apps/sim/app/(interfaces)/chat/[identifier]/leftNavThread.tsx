'use client'

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChipConfirmModal,
  ChipInput,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from '@sim/emcn'
import { formatRelativeTime } from '@sim/utils/formatting'
import { ArrowLeft, Download, MoreHorizontal, Pin, PinOff, Search, Trash2, X } from 'lucide-react'
import Image, { type StaticImageData } from 'next/image'
import {
  CollapseNavIcon,
  FeedbackNavIcon,
  GoldenQueriesNavIcon,
  NewChatNavIcon,
  RenameMenuIcon,
  ReRunNavIcon,
} from '@/app/(interfaces)/chat/[identifier]/sidebar-nav-icons'
import {
  DEPLOYED_CHAT_DIVIDER,
  DEPLOYED_CHAT_SIDEBAR_BORDER,
} from '@/app/(interfaces)/chat/constants'
import { groupThreadsByDate } from '@/app/(interfaces)/chat/utils/thread-date-groups'
import { deployedChatExitEvent } from '@/app/arenaMixpanelEvents/mixpanelEvents'

export interface ThreadRecord {
  chatId: string
  title: string
  workflowId: string
  createdAt: string
  updatedAt: string
  pinnedAt?: string | null
}

interface LeftNavThreadProps {
  threads: ThreadRecord[]
  isLoading: boolean
  error?: string | null
  currentChatId: string
  onSelectThread?: (chatId: string) => void
  onRefreshThread?: () => void
  onNewChat?: () => void
  onRenameThread?: (chatId: string, title: string) => void
  onDeleteThread?: (chatId: string) => void
  onTogglePinThread?: (chatId: string, pinned: boolean) => void
  isStreaming: boolean
  workflowId?: string
  showReRun?: boolean
  showFeedbackView?: boolean
  onReRun?: () => void
  onViewFeedback?: () => void
  onViewGoldenQueries?: () => void
  isGoldenQueriesOpen?: boolean
  isNewChatActive?: boolean
  isCollapsed?: boolean
  isMobileOpen?: boolean
  onCloseMobile?: () => void
  searchInputRef?: React.RefObject<HTMLInputElement | null>
  logoUrl?: string | StaticImageData
  onToggleSidebar?: () => void
  onExportChat?: () => void
}

type SidebarActionIcon = React.ComponentType<{ className?: string }>

function sidebarRowClass(isActive: boolean, disabled = false) {
  return cn(
    'group flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 transition-colors',
    isActive
      ? 'bg-[var(--surface-hover)] shadow-none'
      : 'bg-transparent hover:bg-[var(--surface-hover)]',
    disabled && 'cursor-not-allowed opacity-50'
  )
}

function sidebarRowStyle(_isActive: boolean): CSSProperties | undefined {
  return undefined
}

function sidebarRowIconClass(_isActive: boolean) {
  return cn(
    // Pulls the icon left so it lines up with the logo (row padding otherwise over-indents it).
    '-ml-1.5 size-6 shrink-0',
    'text-[var(--text-primary)]'
  )
}

function sidebarRowLabelClass(isActive: boolean) {
  return cn(
    'truncate text-sm',
    isActive ? 'font-medium text-[var(--text-primary)]' : 'font-normal text-[var(--text-primary)]'
  )
}

/**
 * Resting text uses primary (not secondary + light-mode `#575A66` fallback).
 * Menu content portals outside `.deployed-chat`, so invalid secondary vars used
 * to fall back to dark grey on a dark surface until hover.
 */
const THREAD_MENU_ITEM_CLASS =
  'h-9 gap-2.5 px-3 text-sm font-normal text-[var(--text-primary)] focus:bg-[var(--surface-hover)] data-[highlighted]:bg-[var(--surface-hover)] data-[highlighted]:text-[var(--text-primary)] [&_svg]:size-[14px] [&_svg]:text-[var(--text-icon)]'

function sidebarPanelClass(collapsed: boolean) {
  return cn(
    'flex h-full flex-col rounded-lg border',
    // Collapsed: 8px inset from panel borders, 24px icons, no horizontal chrome beyond that.
    collapsed ? 'w-[42px] items-center px-2 py-3' : 'w-[280px] px-3 py-3'
  )
}

interface SidebarShellProps {
  collapsed?: boolean
  children: React.ReactNode
}

function SidebarShell({ collapsed = false, children }: SidebarShellProps) {
  return (
    <div className='deployed-chat-surface flex h-full shrink-0 p-2'>
      <div
        className={cn(sidebarPanelClass(collapsed), 'deployed-chat-surface')}
        style={{
          borderColor: DEPLOYED_CHAT_SIDEBAR_BORDER,
        }}
      >
        {children}
      </div>
    </div>
  )
}

interface SidebarToggleButtonProps {
  onClick: () => void
}

/**
 * Soft brand-surface shell by default; white background and brand hover glyph.
 */
function sidebarSoftIconClass() {
  return cn(
    'inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-[var(--text-primary)] transition-colors',
    'group-hover:bg-[var(--surface-hover)]'
  )
}

function SidebarCollapseButton({ onClick }: SidebarToggleButtonProps) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='group flex size-6 shrink-0 items-center justify-center p-0'
      aria-label='Collapse sidebar'
    >
      <CollapseNavIcon />
    </button>
  )
}

interface SidebarHeaderProps {
  logoUrl?: string | StaticImageData
  collapsed: boolean
  onToggleSidebar?: () => void
}

/**
 * Fills the 24px icon plate; cover crops transparent padding so the mark
 * matches nav-icon visual weight (object-contain letterboxes and looks small).
 */
function SidebarLogoImage({
  logoUrl,
  className,
}: {
  logoUrl: string | StaticImageData
  className?: string
}) {
  return (
    <Image
      src={logoUrl}
      alt='Logo'
      width={24}
      height={24}
      className={cn('size-6 shrink-0 rounded-[var(--radius-ds-sm,4px)] object-cover', className)}
    />
  )
}

function SidebarHeader({ logoUrl, collapsed, onToggleSidebar }: SidebarHeaderProps) {
  if (collapsed && onToggleSidebar) {
    return (
      <div className='mb-6 flex items-center justify-center'>
        <button
          type='button'
          onClick={onToggleSidebar}
          className='group relative flex size-6 items-center justify-center overflow-hidden rounded-[var(--radius-ds-sm,4px)] p-0'
          aria-label='Expand sidebar'
        >
          {logoUrl ? (
            <>
              <SidebarLogoImage
                logoUrl={logoUrl}
                className='opacity-100 transition-opacity group-hover:opacity-0'
              />
              <CollapseNavIcon className='absolute inset-0 rotate-180 opacity-0 group-hover:opacity-100' />
            </>
          ) : (
            <CollapseNavIcon className='rotate-180' />
          )}
        </button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'mb-6 flex items-center px-0.5',
        collapsed ? 'justify-center' : 'justify-between'
      )}
    >
      {logoUrl ? <SidebarLogoImage logoUrl={logoUrl} /> : <div className='size-6 shrink-0' />}
      {!collapsed && onToggleSidebar ? <SidebarCollapseButton onClick={onToggleSidebar} /> : null}
    </div>
  )
}

interface SidebarActionButtonProps {
  icon?: SidebarActionIcon
  NavIcon?: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  disabled?: boolean
  collapsed?: boolean
  isActive?: boolean
}

function SidebarActionButton({
  icon: Icon,
  NavIcon,
  label,
  onClick,
  disabled = false,
  collapsed = false,
  isActive = false,
}: SidebarActionButtonProps) {
  const button = (
    <button
      type='button'
      className={cn(
        sidebarRowClass(isActive, disabled),
        collapsed ? 'size-6 min-h-0 justify-center gap-0 p-0' : 'w-full'
      )}
      style={sidebarRowStyle(isActive)}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={isActive ? 'true' : undefined}
    >
      {NavIcon ? (
        <NavIcon className={cn(sidebarRowIconClass(isActive), collapsed && 'ml-0')} />
      ) : Icon ? (
        <Icon className={cn(sidebarRowIconClass(isActive), collapsed && 'ml-0')} />
      ) : null}
      {!collapsed && <span className={sidebarRowLabelClass(isActive)}>{label}</span>}
    </button>
  )

  if (!collapsed) return button

  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
        <Tooltip.Content>{label}</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

function ThreadSkeleton() {
  return (
    <div className='flex min-h-8 animate-pulse items-center gap-2 rounded-lg px-2 py-1'>
      <div className='h-3 flex-1 rounded bg-[var(--color-ds-grey-200)]' />
    </div>
  )
}

interface ThreadRowProps {
  thread: ThreadRecord
  isActive: boolean
  isRenaming: boolean
  renameValue: string
  isStreaming: boolean
  onSelect: () => void
  onRefresh: () => void
  onStartRename: () => void
  onRenameChange: (value: string) => void
  onRenameSave: () => void
  onRenameCancel: () => void
  onDelete: () => void
  onTogglePin: () => void
  onExportChat?: () => void
}

function ThreadRow({
  thread,
  isActive,
  isRenaming,
  renameValue,
  isStreaming,
  onSelect,
  onStartRename,
  onRenameChange,
  onRenameSave,
  onRenameCancel,
  onDelete,
  onTogglePin,
  onExportChat,
}: ThreadRowProps) {
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameBlurReadyRef = useRef(false)
  const isPinned = Boolean(thread.pinnedAt)

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
      renameBlurReadyRef.current = false
      const timer = window.setTimeout(() => {
        renameBlurReadyRef.current = true
      }, 150)
      return () => window.clearTimeout(timer)
    }
    renameBlurReadyRef.current = false
    return undefined
  }, [isRenaming])

  const handleRenameBlur = useCallback(() => {
    if (!renameBlurReadyRef.current) return
    onRenameSave()
  }, [onRenameSave])

  if (isRenaming) {
    return (
      <div className='flex min-h-8 items-center gap-1 rounded-lg bg-[var(--color-ds-surface-raised)] px-2 py-1'>
        <ChipInput
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onRenameSave()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onRenameCancel()
            }
          }}
          onBlur={handleRenameBlur}
          autoFocus
          className='h-7 min-w-0 flex-1 border-[var(--color-ds-blue-200,#D1E3FA)] bg-[var(--color-ds-surface-raised)]'
        />
      </div>
    )
  }

  return (
    <div
      className={sidebarRowClass(isActive)}
      style={sidebarRowStyle(isActive)}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      role='button'
      tabIndex={0}
      aria-label={`Open chat: ${thread.title || 'Untitled chat'}`}
      aria-current={isActive ? 'true' : undefined}
    >
      <div className='min-w-0 flex-1'>
        <Tooltip.Provider>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <div className={sidebarRowLabelClass(isActive)}>
                {thread.title || 'Untitled chat'}
              </div>
            </Tooltip.Trigger>
            {thread.title?.length > 23 && (
              <Tooltip.Content>
                {thread.title}
                <br />
                {formatRelativeTime(thread.updatedAt)}
              </Tooltip.Content>
            )}
          </Tooltip.Root>
        </Tooltip.Provider>
      </div>

      {isPinned && (
        <Pin className='size-3 shrink-0 text-[var(--color-ds-icon-default)]' aria-label='Pinned' />
      )}

      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100',
          isActive && 'opacity-100'
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type='button'
              className='flex size-6 items-center justify-center rounded text-[var(--color-ds-icon-default)] hover:bg-[var(--color-ds-surface-raised)]'
              aria-label='Thread options'
              disabled={isStreaming}
            >
              <MoreHorizontal className='size-3.5' />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align='start'
            side='right'
            className='deployed-chat min-w-[132px] rounded-lg border-[var(--color-ds-border-default)] bg-[var(--color-ds-surface-raised)] p-1.5 text-[var(--color-ds-text-primary)] shadow-md'
          >
            <DropdownMenuItem onClick={onStartRename} className={THREAD_MENU_ITEM_CLASS}>
              <RenameMenuIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onTogglePin} className={THREAD_MENU_ITEM_CLASS}>
              {isPinned ? (
                <>
                  <PinOff />
                  Unpin
                </>
              ) : (
                <>
                  <Pin />
                  Pin
                </>
              )}
            </DropdownMenuItem>
            {onExportChat && (
              <DropdownMenuItem
                onClick={onExportChat}
                disabled={!isActive}
                className={THREAD_MENU_ITEM_CLASS}
              >
                <Download />
                Export chat
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onDelete} className={THREAD_MENU_ITEM_CLASS}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

const LeftNavThread = ({
  threads,
  isLoading,
  error,
  currentChatId,
  onSelectThread,
  onRefreshThread,
  onNewChat,
  onRenameThread,
  onDeleteThread,
  onTogglePinThread,
  isStreaming,
  workflowId,
  showReRun = false,
  showFeedbackView = false,
  onReRun,
  onViewFeedback,
  onViewGoldenQueries,
  isGoldenQueriesOpen = false,
  isNewChatActive = false,
  isCollapsed = false,
  isMobileOpen = false,
  onCloseMobile,
  searchInputRef,
  logoUrl,
  onToggleSidebar,
  onExportChat,
}: LeftNavThreadProps) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ThreadRecord | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const internalSearchRef = useRef<HTMLInputElement>(null)
  const resolvedSearchRef = searchInputRef ?? internalSearchRef

  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const workspaceId = params.get('workspaceId')
  const isFromControlBar = params.get('fromControlBar') === 'true'

  const getExitUrl = () => {
    if (isFromControlBar && workspaceId && workflowId) {
      return `/workspace/${workspaceId}/w/${workflowId}`
    }
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname
      if (hostname.includes('localhost')) return 'http://localhost:3001/agents'
      if (hostname.includes('dev-agent')) return 'https://dev.thearena.ai/agents'
      if (hostname.includes('test-agent')) return 'https://test.thearena.ai/agents'
      return 'https://app.thearena.ai/agents'
    }
    return '/'
  }

  const filteredThreads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return threads
    return threads.filter((t) => t.title?.toLowerCase().includes(query))
  }, [threads, searchQuery])

  const groupedThreads = useMemo(() => groupThreadsByDate(filteredThreads), [filteredThreads])

  const handleStartRename = useCallback((thread: ThreadRecord) => {
    setRenamingChatId(thread.chatId)
    setRenameValue(thread.title)
  }, [])

  const handleRenameSave = useCallback(() => {
    if (!renamingChatId) return
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== threads.find((t) => t.chatId === renamingChatId)?.title) {
      onRenameThread?.(renamingChatId, trimmed)
    }
    setRenamingChatId(null)
    setRenameValue('')
  }, [renamingChatId, renameValue, threads, onRenameThread])

  const handleRenameCancel = useCallback(() => {
    setRenamingChatId(null)
    setRenameValue('')
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      await onDeleteThread?.(deleteTarget.chatId)
    } finally {
      setIsDeleting(false)
      setDeleteTarget(null)
    }
  }, [deleteTarget, onDeleteThread])

  const handleSelectThread = useCallback(
    (chatId: string) => {
      onSelectThread?.(chatId)
      onCloseMobile?.()
    },
    [onSelectThread, onCloseMobile]
  )

  const actionButtonsDisabled = isLoading || isStreaming

  const primaryActionButtons = (collapsed: boolean) => (
    <div className={cn('flex flex-col gap-2', collapsed && 'items-center')}>
      {showReRun && onReRun && (
        <SidebarActionButton
          collapsed={collapsed}
          NavIcon={ReRunNavIcon}
          label='Re-Run'
          onClick={onReRun}
          disabled={actionButtonsDisabled}
        />
      )}
      <SidebarActionButton
        collapsed={collapsed}
        NavIcon={NewChatNavIcon}
        label='New Chat'
        onClick={() => onNewChat?.()}
        disabled={actionButtonsDisabled}
        isActive={isNewChatActive}
      />
      <SidebarActionButton
        collapsed={collapsed}
        NavIcon={GoldenQueriesNavIcon}
        label='Golden Queries'
        onClick={() => onViewGoldenQueries?.()}
        disabled={actionButtonsDisabled}
        isActive={isGoldenQueriesOpen}
      />
      <SidebarActionButton
        collapsed={collapsed}
        NavIcon={FeedbackNavIcon}
        label='View Feedback'
        onClick={() => onViewFeedback?.()}
        disabled={actionButtonsDisabled}
        isActive={showFeedbackView}
      />
    </div>
  )

  const handleExitAgent = () => {
    deployedChatExitEvent({})
    window.location.replace(getExitUrl())
  }

  const exitActionButton = (collapsed: boolean) => {
    const button = (
      <button
        type='button'
        className={cn(
          'group flex cursor-pointer items-center gap-1.5 rounded-lg transition-colors hover:bg-[var(--color-ds-surface-raised)]',
          collapsed ? 'size-6 justify-center p-0' : 'w-full px-2 py-1'
        )}
        onClick={handleExitAgent}
        aria-label='Exit Agent'
      >
        <span className={cn(sidebarSoftIconClass(), !collapsed && '-ml-1.5')}>
          <ArrowLeft className='size-4' />
        </span>
        {!collapsed && <span className={sidebarRowLabelClass(false)}>Exit Agent</span>}
      </button>
    )

    if (!collapsed) return button

    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
          <Tooltip.Content>Exit Agent</Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    )
  }

  if (isCollapsed && !isMobileOpen) {
    return (
      <SidebarShell collapsed>
        <SidebarHeader logoUrl={logoUrl} collapsed onToggleSidebar={onToggleSidebar} />
        {primaryActionButtons(true)}
        <div className='mt-auto w-full pt-3'>{exitActionButton(true)}</div>
      </SidebarShell>
    )
  }

  const sidebarContent = (
    <SidebarShell collapsed={false}>
      <SidebarHeader logoUrl={logoUrl} collapsed={false} onToggleSidebar={onToggleSidebar} />

      {primaryActionButtons(false)}

      <hr className='my-3' style={{ borderColor: DEPLOYED_CHAT_DIVIDER }} />

      <div className='flex min-h-0 flex-1 flex-col'>
        <p className='mb-[var(--spacing-ds-component-md,12px)] px-1 font-medium text-[var(--text-secondary)] text-xs'>
          Chats
        </p>

        <div className='mb-3'>
          <ChipInput
            ref={resolvedSearchRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder='Search chats...'
            icon={Search}
            className='h-8 rounded-lg border-none bg-[var(--color-ds-surface-raised)] shadow-sm'
            aria-label='Search chats'
          />
        </div>

        <div className='flex-1 overflow-y-auto'>
          {isLoading ? (
            <div className='flex flex-col gap-1'>
              {Array.from({ length: 5 }).map((_, i) => (
                <ThreadSkeleton key={i} />
              ))}
            </div>
          ) : error ? (
            <div className='flex items-center justify-center py-8'>
              <div className='text-red-500 text-sm'>Failed to load threads</div>
            </div>
          ) : groupedThreads.length > 0 ? (
            <div className='flex flex-col gap-3'>
              {groupedThreads.map((group) => (
                <div key={group.label} className='flex flex-col'>
                  <p className='mb-1 px-1 text-[var(--text-secondary)] text-xs'>{group.label}</p>
                  <div className='flex flex-col gap-1'>
                    {group.threads.map((thread) => (
                      <ThreadRow
                        key={thread.chatId}
                        thread={thread}
                        isActive={
                          currentChatId === thread.chatId &&
                          !showFeedbackView &&
                          !isGoldenQueriesOpen &&
                          !isNewChatActive
                        }
                        isRenaming={renamingChatId === thread.chatId}
                        renameValue={renameValue}
                        isStreaming={isStreaming}
                        onSelect={() => handleSelectThread(thread.chatId)}
                        onRefresh={() => onRefreshThread?.()}
                        onStartRename={() => handleStartRename(thread)}
                        onRenameChange={setRenameValue}
                        onRenameSave={handleRenameSave}
                        onRenameCancel={handleRenameCancel}
                        onDelete={() => setDeleteTarget(thread)}
                        onTogglePin={() => onTogglePinThread?.(thread.chatId, !thread.pinnedAt)}
                        onExportChat={onExportChat}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className='flex flex-col items-center justify-center gap-2 py-8 text-center'>
              <p className='text-[var(--color-ds-text-secondary)] text-sm'>
                {searchQuery ? 'No matching conversations' : 'No conversations yet'}
              </p>
              {!searchQuery && (
                <button
                  type='button'
                  className='text-[var(--color-ds-text-link,#1A73E8)] text-sm hover:underline'
                  onClick={() => onNewChat?.()}
                  disabled={isStreaming}
                >
                  Start a new chat
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <hr className='my-3' style={{ borderColor: DEPLOYED_CHAT_DIVIDER }} />

      {exitActionButton(false)}

      <ChipConfirmModal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title='Delete chat'
        text={[
          'Delete ',
          { text: deleteTarget?.title ?? 'this chat', bold: true },
          '? This cannot be undone.',
        ]}
        confirm={{
          label: 'Delete',
          onClick: handleConfirmDelete,
          pending: isDeleting,
          pendingLabel: 'Deleting...',
        }}
      />
    </SidebarShell>
  )

  if (isMobileOpen) {
    return (
      <>
        <button
          type='button'
          className='fixed inset-0 z-40 bg-black/40 md:hidden'
          onClick={onCloseMobile}
          aria-label='Close sidebar'
        />
        <div className='fixed inset-y-0 left-0 z-50 md:hidden'>
          <div className='flex h-full items-start justify-between'>
            <div className={cn(isMobileOpen && 'shadow-xl')}>{sidebarContent}</div>
            <button
              type='button'
              className='m-2 flex size-8 items-center justify-center rounded-full bg-[var(--color-ds-surface-raised)] shadow'
              onClick={onCloseMobile}
              aria-label='Close sidebar'
            >
              <X className='size-4' />
            </button>
          </div>
        </div>
      </>
    )
  }

  return sidebarContent
}

export default LeftNavThread
