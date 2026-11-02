'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@sim/emcn'
import { GUI_CHIP_TONE_CLASSES as CHIP_TONE_CLASSES } from '@/app/(interfaces)/gui-apps/gui-chrome'
import {
  SEARCH_LIVE_DEBOUNCE_MS,
  SEARCH_LIVE_MIN_CHARS,
} from '@/lib/arena-generative-ui/catalog-icon'
import { asFieldString } from '@/lib/arena-generative-ui/form-fields'

interface GuiHostSearchFieldProps {
  fieldId: string
  name: string
  label: string
  required: boolean
  error?: string
  placeholder: string
  value: unknown
  suggestions: readonly string[]
  submitLabel: string
  searchBusy: boolean
  live: boolean
  buttonClass: (options: { variant: 'primary'; shape: 'pill' }, tone: string) => string
  busyMark: ReactNode
  requiredMark: ReactNode
  onValueChange: (value: string) => void
  onLiveQuery: (query: string) => void
}

export function GuiHostSearchField({
  fieldId,
  name,
  label,
  required,
  error,
  placeholder,
  value,
  suggestions,
  submitLabel,
  searchBusy,
  live,
  buttonClass,
  busyMark,
  requiredMark,
  onValueChange,
  onLiveQuery,
}: GuiHostSearchFieldProps) {
  const query = asFieldString(value)
  const skipFirst = useRef(true)

  useEffect(() => {
    if (!live) return
    if (skipFirst.current) {
      skipFirst.current = false
      return
    }
    const trimmed = query.trim()
    if (trimmed.length < SEARCH_LIVE_MIN_CHARS) return
    const handle = window.setTimeout(() => onLiveQuery(trimmed), SEARCH_LIVE_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [live, query, onLiveQuery])

  return (
    <div className='flex flex-col gap-3'>
      {label ? (
        <label
          htmlFor={fieldId}
          className='font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'
        >
          {label}
          {requiredMark}
        </label>
      ) : (
        <label htmlFor={fieldId} className='sr-only'>
          {placeholder || 'Search'}
        </label>
      )}
      <div
        data-testid='search-field'
        className={cn(
          'flex h-12 items-center gap-2 rounded-full border bg-(--gui-surface,#ffffff) pr-1.5 pl-5',
          error ? 'border-(--gui-danger,#f31a1a)' : 'border-(--gui-border,#e2e3e5)'
        )}
      >
        <input
          id={fieldId}
          name={name}
          required={required}
          placeholder={placeholder || undefined}
          value={query}
          onChange={(event) => onValueChange(event.target.value)}
          className='h-full min-w-0 flex-1 bg-transparent text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33) outline-none placeholder:text-(--gui-text-tertiary,#8a8d99)'
        />
        <button
          type='submit'
          disabled={searchBusy}
          aria-busy={searchBusy || undefined}
          className={cn(buttonClass({ variant: 'primary', shape: 'pill' }, 'primary'), searchBusy && 'gap-2')}
        >
          {busyMark}
          {submitLabel}
        </button>
      </div>
      {error ? (
        <p
          data-testid={`field-error-${name}`}
          className='text-(length:--gui-label-size,12px) text-(--gui-danger,#f31a1a)'
        >
          {error}
        </p>
      ) : null}
      {suggestions.length > 0 ? (
        <div className='flex flex-wrap justify-center gap-2'>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type='button'
              className={cn(
                'inline-flex items-center rounded-(--gui-radius-pill) px-3 py-1.5 font-medium text-sm',
                CHIP_TONE_CLASSES.muted
              )}
              onClick={() => onValueChange(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
