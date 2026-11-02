'use client'

import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@sim/emcn'
import { ChevronDown } from 'lucide-react'
import {
  GUI_FIELD_INPUT_CLASS,
  GUI_FIELD_NATIVE_CONTROL_CLASS,
  guiFieldErrorClass,
} from '@/app/(interfaces)/gui-apps/gui-chrome/gui-tokens'

interface GuiSelectOption {
  label: string
  value: string
}

interface GuiSelectProps {
  id: string
  name: string
  value: string
  options: readonly GuiSelectOption[]
  required?: boolean
  error?: string
  placeholder?: string
  searchable?: boolean
  disabled?: boolean
  onChange: (value: string) => void
}

export function GuiSelect({
  id,
  name,
  value,
  options,
  required,
  error,
  placeholder = 'Choose an option',
  searchable = false,
  disabled,
  onChange,
}: GuiSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!searchable || !needle) return options
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle)
    )
  }, [options, query, searchable])

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    return () => window.removeEventListener('pointerdown', onPointer)
  }, [open])

  useEffect(() => {
    const selected = filtered.findIndex(
      (option) => option.value === value || option.label === value
    )
    setActiveIndex(selected >= 0 ? selected : 0)
  }, [filtered, value, open])

  const selectOption = (option: GuiSelectOption) => {
    onChange(option.value)
    setOpen(false)
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
    }
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(Math.max(filtered.length - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = filtered[activeIndex]
      if (option) selectOption(option)
    }
  }

  const selectedOption = options.find((option) => option.value === value || option.label === value)
  const label = selectedOption?.label || value || placeholder

  return (
    <div ref={rootRef} className='relative w-full'>
      <input type='hidden' name={name} value={value} required={required} />
      <button
        id={id}
        type='button'
        disabled={disabled}
        aria-haspopup='listbox'
        aria-expanded={open}
        aria-controls={listId}
        aria-required={required || undefined}
        className={cn(
          GUI_FIELD_INPUT_CLASS,
          'flex items-center justify-between gap-2 text-left',
          !value && 'text-(--gui-text-placeholder,#a7aab2)',
          guiFieldErrorClass(error)
        )}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className='min-w-0 truncate'>{label}</span>
        <ChevronDown
          className='size-[14px] shrink-0 text-(--gui-text-muted,#575a66)'
          aria-hidden
        />
      </button>
      {open ? (
        <div
          className='absolute z-20 mt-1 w-full overflow-hidden rounded-(--gui-radius,12px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#ffffff) shadow-(--gui-shadow-lg,0px_4px_16px_rgba(44,45,51,0.12))'
          onKeyDown={onListKeyDown}
        >
          {searchable ? (
            <div className='border-(--gui-border,#e2e3e5) border-b p-2'>
              <input
                value={query}
                placeholder='Search'
                aria-label='Search options'
                className={cn(GUI_FIELD_INPUT_CLASS, 'h-8')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : null}
          <ul id={listId} aria-label={placeholder} className='max-h-56 overflow-auto py-1'>
            {filtered.length === 0 ? (
              <li className='px-3 py-2 text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                No matches
              </li>
            ) : (
              filtered.map((option, index) => {
                const selected = option.value === value || option.label === value
                const active = index === activeIndex
                return (
                  <li key={`${option.value}-${option.label}`} role='none'>
                    <button
                      type='button'
                      role='option'
                      aria-selected={selected}
                      className={cn(
                        'flex w-full px-3 py-2 text-left text-(length:--gui-body-size,16px)',
                        selected &&
                          'bg-(--gui-brand-surface,#f3f8fe) text-(--gui-brand,#1a73e8)',
                        active && !selected && 'bg-(--gui-canvas,#f7f8f9)',
                        !selected && 'text-(--gui-text,#2c2d33)'
                      )}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectOption(option)}
                    >
                      {option.label}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

interface GuiMultiSelectProps {
  id: string
  name: string
  options: readonly string[]
  selected: readonly string[]
  error?: string
  onChange: (next: string[]) => void
}

export function GuiMultiSelect({ id, name, options, selected, onChange }: GuiMultiSelectProps) {
  const selectedSet = new Set(selected)
  return (
    <div className='flex flex-col gap-2 rounded-(--gui-radius,12px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#ffffff) p-3'>
      {options.map((option) => {
        const optionId = `${id}-${option}`
        return (
          <label key={option} htmlFor={optionId} className='flex items-center gap-2'>
            <input
              id={optionId}
              type='checkbox'
              name={name}
              value={option}
              checked={selectedSet.has(option)}
              onChange={() => {
                const next = selectedSet.has(option)
                  ? selected.filter((item) => item !== option)
                  : [...selected, option]
                onChange(next)
              }}
              className={GUI_FIELD_NATIVE_CONTROL_CLASS}
            />
            <span className='text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33)'>
              {option}
            </span>
          </label>
        )
      })}
    </div>
  )
}
