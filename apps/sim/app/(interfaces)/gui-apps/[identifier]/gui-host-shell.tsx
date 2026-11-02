'use client'

import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { cn } from '@sim/emcn'
import {
  GUI_BUTTON_BASE_CLASS,
  GUI_BUTTON_SIZE_CLASSES,
  GUI_BUTTON_VARIANT_CLASSES,
  GUI_FIELD_INPUT_CLASS,
  GUI_OVERLAY_DIALOG_CLASS,
  GUI_OVERLAY_SCRIM_CLASS,
  GUI_SURFACE_CARD,
} from '@/app/(interfaces)/gui-apps/gui-chrome'
import type { BreadcrumbEntry } from '@/lib/arena-generative-ui/gui-breadcrumb'
import {
  type CommandPaletteEntry,
  filterCommandPaletteEntries,
} from '@/lib/arena-generative-ui/gui-command-palette'
import type { PaginationMode } from '@/lib/arena-generative-ui/gui-pagination'
import {
  LOCAL_COLLECTION_PAGE_SIZE,
  type PaginatedCollection,
} from '@/lib/arena-generative-ui/local-discovery'

interface GuiHostPaginationProps {
  mode: PaginationMode
  paged?: PaginatedCollection<unknown>
  hasMore?: boolean
  pending?: boolean
  onPageChange?: (page: number) => void
  onLoadMore?: () => void
}

export function GuiHostPagination({
  mode,
  paged,
  hasMore = false,
  pending = false,
  onPageChange,
  onLoadMore,
}: GuiHostPaginationProps) {
  if (mode === 'more') {
    if (!hasMore) return null
    return (
      <div data-testid='gui-pagination' className='mt-3 flex w-full justify-center'>
        <button
          type='button'
          disabled={pending}
          className={cn(
            GUI_BUTTON_BASE_CLASS,
            GUI_BUTTON_VARIANT_CLASSES.secondary,
            GUI_BUTTON_SIZE_CLASSES.sm
          )}
          onClick={() => onLoadMore?.()}
        >
          Load more
        </button>
      </div>
    )
  }
  if (!paged || paged.total <= LOCAL_COLLECTION_PAGE_SIZE) return null
  return (
    <div
      data-testid='gui-pagination'
      className='col-span-full mt-3 flex w-full flex-wrap items-center justify-between gap-3'
    >
      <p className='text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
        Showing {paged.from}–{paged.to} of {paged.total}
      </p>
      <div className='flex gap-2'>
        <button
          type='button'
          aria-label='Previous page'
          disabled={paged.page <= 1}
          className={cn(
            GUI_BUTTON_BASE_CLASS,
            GUI_BUTTON_VARIANT_CLASSES.secondary,
            GUI_BUTTON_SIZE_CLASSES.sm
          )}
          onClick={() => onPageChange?.(paged.page - 1)}
        >
          Previous
        </button>
        <button
          type='button'
          aria-label='Next page'
          disabled={paged.page >= paged.pageCount}
          className={cn(
            GUI_BUTTON_BASE_CLASS,
            GUI_BUTTON_VARIANT_CLASSES.secondary,
            GUI_BUTTON_SIZE_CLASSES.sm
          )}
          onClick={() => onPageChange?.(paged.page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  )
}

interface GuiHostBreadcrumbProps {
  items: readonly BreadcrumbEntry[]
  currentPath?: string
  onNavigate: (target: string) => void
}

export function GuiHostBreadcrumb({ items, currentPath, onNavigate }: GuiHostBreadcrumbProps) {
  if (items.length === 0) return null
  return (
    <nav data-testid='gui-breadcrumb' aria-label='Breadcrumb'>
      <ol className='flex flex-wrap items-center gap-1 text-(length:--gui-label-size,12px)'>
        {items.map((item, index) => {
          const last = index === items.length - 1
          const current = last || !item.path || item.path === currentPath
          return (
            <li key={`${item.label}:${item.path ?? index}`} className='flex items-center gap-1'>
              {index > 0 ? (
                <span aria-hidden className='text-(--gui-text-muted,#575a66)'>
                  /
                </span>
              ) : null}
              {current ? (
                <span
                  aria-current='page'
                  className='font-medium text-(--gui-text,#2c2d33)'
                >
                  {item.label}
                </span>
              ) : (
                <button
                  type='button'
                  className='text-(--gui-brand,#1a73e8) hover:underline'
                  onClick={() => onNavigate(item.path as string)}
                >
                  {item.label}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

interface GuiHostTooltipProps {
  text: string
  label?: string
  children?: ReactNode
}

export function GuiHostTooltip({ text, label, children }: GuiHostTooltipProps) {
  const tooltipId = useId()
  const [open, setOpen] = useState(false)
  const trigger = children ?? (
    <span className='underline decoration-dotted underline-offset-2'>{label || 'Info'}</span>
  )
  return (
    <span
      data-testid='gui-tooltip'
      className='relative inline-flex'
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? tooltipId : undefined} className='inline-flex'>
        {trigger}
      </span>
      {open && text ? (
        <span
          id={tooltipId}
          role='tooltip'
          className='absolute bottom-full left-1/2 z-20 mb-1 w-max max-w-xs -translate-x-1/2 rounded-(--gui-radius-sm,8px) bg-(--gui-text,#2c2d33) px-2 py-1 text-(length:--gui-label-size,12px) text-(--gui-surface,#ffffff)'
        >
          {text}
        </span>
      ) : null}
    </span>
  )
}

interface GuiHostPopoverProps {
  title?: string
  label?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
}

export function GuiHostPopover({
  title,
  label,
  open,
  onOpenChange,
  children,
}: GuiHostPopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const controlled = open !== undefined
  const isOpen = controlled ? open : uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (!controlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    const onPointer = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [isOpen])

  return (
    <span data-testid='gui-popover' className='relative inline-flex'>
      <button
        type='button'
        aria-expanded={isOpen}
        className={cn(
          GUI_BUTTON_BASE_CLASS,
          GUI_BUTTON_VARIANT_CLASSES.secondary,
          GUI_BUTTON_SIZE_CLASSES.sm
        )}
        onClick={() => setOpen(!isOpen)}
      >
        {label || title || 'Details'}
      </button>
      {isOpen ? (
        <div
          ref={panelRef}
          role='dialog'
          className={cn(GUI_SURFACE_CARD, 'absolute top-full left-0 z-20 mt-1 min-w-56')}
        >
          {title ? (
            <p className='mb-2 font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
              {title}
            </p>
          ) : null}
          {children}
        </div>
      ) : null}
    </span>
  )
}

interface GuiHostCommandPaletteProps {
  placeholder?: string
  label?: string
  entries: readonly CommandPaletteEntry[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onNavigate: (target: string) => void
  onRunAction: (actionId: string) => void
}

export function GuiHostCommandPalette({
  placeholder,
  label,
  entries,
  open,
  onOpenChange,
  onNavigate,
  onRunAction,
}: GuiHostCommandPaletteProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const controlled = open !== undefined
  const isOpen = controlled ? open : uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (!controlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
    if (!next) setQuery('')
  }
  const visible = filterCommandPaletteEntries(entries, query)

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(!isOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen])

  useEffect(() => {
    if (isOpen) inputRef.current?.focus()
  }, [isOpen])

  const run = (entry: CommandPaletteEntry) => {
    setOpen(false)
    if (entry.kind === 'action') onRunAction(entry.target)
    else onNavigate(entry.target)
  }

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const first = visible[0]
      if (first) run(first)
    }
  }

  return (
    <div data-testid='gui-command-palette'>
      {label ? (
        <button
          type='button'
          className={cn(
            GUI_BUTTON_BASE_CLASS,
            GUI_BUTTON_VARIANT_CLASSES.secondary,
            GUI_BUTTON_SIZE_CLASSES.sm
          )}
          onClick={() => setOpen(true)}
        >
          {label}
        </button>
      ) : null}
      {isOpen ? (
        <div className={GUI_OVERLAY_SCRIM_CLASS}>
          <button
            type='button'
            aria-label='Close'
            className='absolute inset-0 cursor-default bg-transparent'
            onClick={() => setOpen(false)}
          />
          <div
            role='dialog'
            aria-modal='true'
            aria-label='Command palette'
            className={cn(GUI_OVERLAY_DIALOG_CLASS, 'relative z-10 w-full max-w-lg p-3')}
            onClick={(event) => event.stopPropagation()}
          >
            <input
              ref={inputRef}
              type='search'
              value={query}
              placeholder={placeholder || 'Search commands'}
              className={GUI_FIELD_INPUT_CLASS}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKey}
            />
            <ul className='mt-2 max-h-72 overflow-auto'>
              {visible.length === 0 ? (
                <li className='px-2 py-2 text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66)'>
                  No commands
                </li>
              ) : (
                visible.map((entry) => (
                  <li key={`${entry.kind}:${entry.target}:${entry.label}`}>
                    <button
                      type='button'
                      className='flex w-full items-center justify-between rounded-(--gui-radius-sm,8px) px-2 py-2 text-left hover:bg-(--gui-canvas,#f7f8f9)'
                      onClick={() => run(entry)}
                    >
                      <span className='text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33)'>
                        {entry.label}
                      </span>
                      <span className='text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                        {entry.kind === 'action' ? entry.target : entry.target}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  )
}
