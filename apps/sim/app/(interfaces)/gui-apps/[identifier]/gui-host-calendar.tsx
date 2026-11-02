'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@sim/emcn'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { GUI_BOUND_EMPTY_CLASS } from '@/app/(interfaces)/gui-apps/gui-chrome'
import {
  addCalendarDays,
  addCalendarMonths,
  calendarItemsForCollection,
  defaultCalendarDateField,
  defaultCalendarTitleField,
  isoDateFromParts,
  isoDateInRange,
  monthGridDays,
  monthTitle,
  parseIsoDateParts,
  WEEKDAY_LABELS,
  weekGridDays,
  type CalendarDay,
} from '@/lib/arena-generative-ui/gui-calendar'

const DAY_BUTTON_CLASS =
  'flex min-h-8 w-full flex-col items-center justify-center rounded-(--gui-radius-sm,8px) text-(length:--gui-label-size,12px) outline-none transition-[background-color,color] duration-100 focus-visible:shadow-[0_0_0_3px_var(--gui-focus,rgb(26_115_232/30%))]'

const BOUND_EMPTY_CLASS = GUI_BOUND_EMPTY_CLASS

interface GuiHostMonthGridProps {
  year: number
  month: number
  value?: string
  min?: string
  max?: string
  itemsByDate?: Map<string, Array<{ title: string; index: number }>>
  onSelectDay: (iso: string) => void
  onMoveMonth?: (delta: number) => void
}

export function GuiHostMonthGrid({
  year,
  month,
  value,
  min,
  max,
  itemsByDate,
  onSelectDay,
  onMoveMonth,
}: GuiHostMonthGridProps) {
  const days = monthGridDays(year, month)
  return (
    <div data-testid='gui-month-grid' className='flex w-full flex-col gap-2'>
      <div className='flex items-center justify-between gap-2'>
        <button
          type='button'
          aria-label='Previous month'
          className='inline-flex size-8 items-center justify-center rounded-(--gui-radius-sm,8px) text-(--gui-text,#2c2d33) hover:bg-(--gui-canvas,#f7f8f9)'
          onClick={() => onMoveMonth?.(-1)}
        >
          <ChevronLeft className='size-[14px]' />
        </button>
        <p className='font-medium text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33)'>
          {monthTitle(year, month)}
        </p>
        <button
          type='button'
          aria-label='Next month'
          className='inline-flex size-8 items-center justify-center rounded-(--gui-radius-sm,8px) text-(--gui-text,#2c2d33) hover:bg-(--gui-canvas,#f7f8f9)'
          onClick={() => onMoveMonth?.(1)}
        >
          <ChevronRight className='size-[14px]' />
        </button>
      </div>
      <div className='grid grid-cols-7 gap-1'>
        {WEEKDAY_LABELS.map((label) => (
          <p
            key={label}
            className='px-1 text-center font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66) uppercase tracking-[0.25px]'
          >
            {label}
          </p>
        ))}
        {days.map((day) => (
          <DayCell
            key={day.iso}
            day={day}
            selected={day.iso === value}
            disabled={!isoDateInRange(day.iso, min, max)}
            chips={itemsByDate?.get(day.iso) ?? []}
            onSelect={onSelectDay}
          />
        ))}
      </div>
    </div>
  )
}

function DayCell({
  day,
  selected,
  disabled,
  chips,
  onSelect,
}: {
  day: CalendarDay
  selected: boolean
  disabled: boolean
  chips: Array<{ title: string; index: number }>
  onSelect: (iso: string) => void
}) {
  return (
    <button
      type='button'
      data-iso={day.iso}
      disabled={disabled}
      aria-pressed={selected || undefined}
      className={cn(
        DAY_BUTTON_CLASS,
        'min-h-10 px-0.5 py-1',
        day.inMonth ? 'text-(--gui-text,#2c2d33)' : 'text-(--gui-text-tertiary,#8a8d99)',
        selected && 'bg-(--gui-brand-surface,#f3f8fe) text-(--gui-brand,#1a73e8)',
        !selected && !disabled && 'hover:bg-(--gui-canvas,#f7f8f9)',
        disabled && 'cursor-not-allowed opacity-40'
      )}
      onClick={() => onSelect(day.iso)}
    >
      <span>{day.day}</span>
      {chips.length > 0 ? (
        <span className='mt-0.5 line-clamp-1 w-full text-micro text-(--gui-brand,#1a73e8)'>
          {chips[0]?.title}
        </span>
      ) : null}
    </button>
  )
}

interface GuiHostDateInputProps {
  id: string
  name: string
  value: string
  required?: boolean
  min?: string
  max?: string
  className?: string
  onChange: (value: string) => void
}

export function GuiHostDateInput({
  id,
  name,
  value,
  required,
  min,
  max,
  className,
  onChange,
}: GuiHostDateInputProps) {
  const fallback = parseIsoDateParts(new Date().toISOString().slice(0, 10))
  const parsed = parseIsoDateParts(value) ?? fallback
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(parsed ?? { year: 2026, month: 9, day: 1 })
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const next = parseIsoDateParts(value)
    if (next) setCursor(next)
  }, [value])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (!open) return
    const iso = value || isoDateFromParts(cursor.year, cursor.month, cursor.day)
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onChange(addCalendarDays(iso, -1))
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      onChange(addCalendarDays(iso, 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      onChange(addCalendarDays(iso, -7))
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      onChange(addCalendarDays(iso, 7))
    }
  }

  return (
    <div ref={rootRef} className='relative w-full'>
      <input
        id={id}
        name={name}
        type='date'
        required={required}
        min={min || undefined}
        max={max || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className='sr-only'
        tabIndex={-1}
        aria-hidden
      />
      <button
        type='button'
        aria-haspopup='dialog'
        aria-expanded={open}
        className={className}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        {value || 'Select date'}
      </button>
      {open ? (
        <div
          role='dialog'
          className='absolute z-20 mt-1 w-[min(100%,20rem)] rounded-(--gui-radius,12px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#ffffff) p-3 shadow-(--gui-shadow-lg,0px_4px_16px_rgba(44,45,51,0.12))'
        >
          <GuiHostMonthGrid
            year={cursor.year}
            month={cursor.month}
            value={value}
            min={min}
            max={max}
            onSelectDay={(iso) => {
              if (!isoDateInRange(iso, min, max)) return
              onChange(iso)
              setOpen(false)
            }}
            onMoveMonth={(delta) => setCursor((current) => addCalendarMonths(current, delta))}
          />
        </div>
      ) : null}
    </div>
  )
}

interface GuiHostCalendarProps {
  items: readonly unknown[]
  dateField?: string
  titleField?: string
  view?: 'month' | 'week'
  emptyText: string
  busy?: boolean
  allowViewToggle?: boolean
  onSelectItem?: (item: unknown, index: number) => void
}

export function GuiHostCalendar({
  items,
  dateField,
  titleField,
  view: viewProp,
  emptyText,
  busy,
  allowViewToggle = false,
  onSelectItem,
}: GuiHostCalendarProps) {
  const resolvedDate = dateField || defaultCalendarDateField(items)
  const resolvedTitle = titleField || defaultCalendarTitleField(items, resolvedDate)
  const grouped = calendarItemsForCollection(items, resolvedDate, resolvedTitle)
  const today = new Date()
  const [cursor, setCursor] = useState({
    year: today.getFullYear(),
    month: today.getMonth() + 1,
    day: today.getDate(),
  })
  const [view, setView] = useState<'month' | 'week'>(viewProp ?? 'month')
  const headingId = useId()

  useEffect(() => {
    if (viewProp) setView(viewProp)
  }, [viewProp])

  if (items.length === 0) {
    return (
      <p data-testid='empty-state' className={BOUND_EMPTY_CLASS}>
        {emptyText}
      </p>
    )
  }

  const anchorIso = isoDateFromParts(cursor.year, cursor.month, cursor.day)
  const weekDays = weekGridDays(anchorIso)

  const renderChip = (entry: { title: string; item: unknown; index: number }) => (
    <button
      type='button'
      key={`${entry.index}-${entry.title}`}
      className='w-full truncate rounded-(--gui-radius-sm,8px) bg-(--gui-brand-surface,#f3f8fe) px-1.5 py-0.5 text-left text-(length:--gui-label-size,12px) text-(--gui-brand,#1a73e8)'
      onClick={() => onSelectItem?.(entry.item, entry.index)}
    >
      {entry.title}
    </button>
  )

  return (
    <div
      data-testid='gui-calendar'
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      className='flex w-full flex-col gap-3 rounded-(--gui-radius,12px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#ffffff) p-4'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p id={headingId} className='font-medium text-(--gui-text,#2c2d33)'>
          {monthTitle(cursor.year, cursor.month)}
        </p>
        {allowViewToggle ? (
          <div className='flex gap-1'>
            {(['month', 'week'] as const).map((next) => (
              <button
                key={next}
                type='button'
                className={cn(
                  'rounded-(--gui-radius-sm,8px) px-2 py-1 text-(length:--gui-label-size,12px)',
                  view === next
                    ? 'bg-(--gui-brand-surface,#f3f8fe) text-(--gui-brand,#1a73e8)'
                    : 'text-(--gui-text-muted,#575a66)'
                )}
                onClick={() => setView(next)}
              >
                {next === 'month' ? 'Month' : 'Week'}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {view === 'month' ? (
        <GuiHostMonthGrid
          year={cursor.year}
          month={cursor.month}
          itemsByDate={
            new Map(
              [...grouped.byDate.entries()].map(([iso, entries]) => [
                iso,
                entries.map((entry) => ({ title: entry.title, index: entry.index })),
              ])
            )
          }
          onSelectDay={(iso) => {
            const first = grouped.byDate.get(iso)?.[0]
            if (first) onSelectItem?.(first.item, first.index)
            const parts = parseIsoDateParts(iso)
            if (parts) setCursor(parts)
          }}
          onMoveMonth={(delta) => setCursor((current) => addCalendarMonths(current, delta))}
        />
      ) : (
        <div className='grid grid-cols-7 gap-2'>
          {weekDays.map((day, index) => (
            <div key={day.iso} className='flex min-h-32 flex-col gap-1'>
              <p className='text-center text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                {WEEKDAY_LABELS[index]} {day.day}
              </p>
              {(grouped.byDate.get(day.iso) ?? []).map(renderChip)}
            </div>
          ))}
        </div>
      )}
      {grouped.unscheduled.length > 0 ? (
        <div
          data-testid='unscheduled'
          className='flex flex-col gap-1 border-(--gui-border,#e2e3e5) border-t pt-3'
        >
          <p className='font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66) uppercase tracking-[0.25px]'>
            Unscheduled
          </p>
          {grouped.unscheduled.map(renderChip)}
        </div>
      ) : null}
    </div>
  )
}
