'use client'

import type { ReactNode } from 'react'
import {
  GUI_FIELD_ERROR_CLASS,
  GUI_FIELD_LABEL_CLASS,
} from '@/app/(interfaces)/gui-apps/gui-chrome/gui-tokens'

export function GuiRequiredMark({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span aria-hidden className='text-(--gui-danger,#f31a1a)'>
      {' *'}
    </span>
  )
}

interface GuiFieldShellProps {
  name: string
  label: string
  htmlFor?: string
  error?: string
  required?: boolean
  children: ReactNode
}

export function GuiFieldShell({
  name,
  label,
  htmlFor,
  error,
  required = false,
  children,
}: GuiFieldShellProps) {
  const title = label ? (
    <>
      {label}
      <GuiRequiredMark show={required} />
    </>
  ) : null
  return (
    <div className='flex w-full min-w-0 flex-col gap-1.5'>
      {title ? (
        htmlFor ? (
          <label htmlFor={htmlFor} className={GUI_FIELD_LABEL_CLASS}>
            {title}
          </label>
        ) : (
          <span className={GUI_FIELD_LABEL_CLASS}>{title}</span>
        )
      ) : null}
      {children}
      {error ? (
        <p data-testid={`field-error-${name}`} className={GUI_FIELD_ERROR_CLASS}>
          {error}
        </p>
      ) : null}
    </div>
  )
}
