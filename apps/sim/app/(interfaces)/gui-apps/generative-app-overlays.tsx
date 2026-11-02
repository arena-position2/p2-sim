'use client'

import { type KeyboardEvent, useEffect, useRef } from 'react'
import { cn } from '@sim/emcn'
import { Loader2 } from 'lucide-react'
import {
  GUI_BUTTON_BASE_CLASS,
  GUI_BUTTON_FILLED_DANGER_CLASS,
  GUI_BUTTON_SIZE_CLASSES,
  GUI_OVERLAY_DIALOG_CLASS,
  GUI_OVERLAY_SCRIM_CLASS,
  GuiButton,
} from '@/app/(interfaces)/gui-apps/gui-chrome'
import { GENERATIVE_APP_SUCCESS_TOAST_MS } from '@/lib/arena-generative-ui/action-runtime'

interface ActionSuccessToastProps {
  message: string
  onDone: () => void
}

/**
 * Same-page save confirmation. Does not take focus; auto-dismisses.
 */
export function ActionSuccessToast({ message, onDone }: ActionSuccessToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, GENERATIVE_APP_SUCCESS_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [onDone])

  return (
    <div
      role='status'
      data-testid='action-success-toast'
      className='pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center px-4'
    >
      <p className='rounded-(--gui-radius,12px) border border-(--gui-success-border,#b1e9ce) bg-(--gui-success-surface,#f5fcf9) px-4 py-2 text-(--gui-success-text,#23784f) text-sm shadow-(--gui-shadow-card,0px_2px_8px_rgba(44,45,51,0.1))'>
        {message}
      </p>
    </div>
  )
}

interface DestructiveConfirmDialogProps {
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Host confirmation before a destructive CTA. Focus moves into the dialog and
 * restores to the trigger on close.
 */
export function DestructiveConfirmDialog({ onCancel, onConfirm }: DestructiveConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    const focusable = dialogRef.current?.querySelector<HTMLElement>('button')
    focusable?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancelRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const buttons = dialogRef.current?.querySelectorAll<HTMLElement>('button')
    if (!buttons || buttons.length === 0) return
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className={GUI_OVERLAY_SCRIM_CLASS} data-testid='destructive-confirm-backdrop'>
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='destructive-confirm-title'
        data-testid='destructive-confirm'
        className={cn(
          GUI_OVERLAY_DIALOG_CLASS,
          'w-full max-w-sm rounded-(--gui-radius,12px) p-4'
        )}
        onKeyDown={onKeyDown}
      >
        <h2
          id='destructive-confirm-title'
          className='font-medium text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33)'
        >
          This cannot be undone
        </h2>
        <p className='mt-1 text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
          Continue with this action?
        </p>
        <div className='mt-4 flex justify-end gap-2'>
          <GuiButton data-testid='destructive-confirm-cancel' onClick={onCancel}>
            Cancel
          </GuiButton>
          <button
            type='button'
            data-testid='destructive-confirm-accept'
            onClick={onConfirm}
            className={cn(
              GUI_BUTTON_BASE_CLASS,
              GUI_BUTTON_SIZE_CLASSES.md,
              GUI_BUTTON_FILLED_DANGER_CLASS
            )}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

interface ActionRefreshButtonProps {
  onRefresh: () => void
  pending?: boolean
}

/**
 * Host refresh for a page that has already attempted onLoad. Does not blank
 * bound regions; SpecRenderer keeps existing data while pending.
 */
export function ActionRefreshButton({ onRefresh, pending = false }: ActionRefreshButtonProps) {
  return (
    <div className='flex justify-end px-6 py-2'>
      <GuiButton
        variant='ghost'
        size='sm'
        className='gap-1.5'
        data-testid='action-refresh'
        aria-busy={pending || undefined}
        disabled={pending}
        onClick={onRefresh}
      >
        {pending ? (
          <Loader2 className='size-3 animate-spin text-(--gui-text-muted,#575a66)' aria-hidden />
        ) : null}
        Refresh
      </GuiButton>
    </div>
  )
}
