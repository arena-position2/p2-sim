'use client'

import { useState } from 'react'
import {
  ARENA_GENERATIVE_THEME_DENSITIES,
  ARENA_GENERATIVE_THEME_RADII,
  type ArenaGenerativeTheme,
  DEFAULT_ARENA_GENERATIVE_THEME,
} from '@/lib/arena-generative-ui/theme'
import { themeEditInstructions } from '@/lib/arena-generative-ui/theme-from-edit'

interface PreviewThemePickerProps {
  theme?: ArenaGenerativeTheme
  onChange: (theme: ArenaGenerativeTheme) => void
}

/**
 * Preview-only theme knobs. Live CSS vars; persist by pasting the copied
 * edit instruction into Requested Changes (theme-only edits skip the LLM).
 * Light/dark follows the visitor Sim theme (`sim-theme`), not this picker.
 */
export function PreviewThemePicker({ theme, onChange }: PreviewThemePickerProps) {
  const [copied, setCopied] = useState(false)
  const current = { ...DEFAULT_ARENA_GENERATIVE_THEME, ...theme }
  const patch = (partial: ArenaGenerativeTheme) => onChange({ ...current, ...partial })
  const instructions = themeEditInstructions(current)

  return (
    <div
      data-testid='preview-theme-picker'
      className='flex flex-wrap items-end gap-3 border-(--gui-border,#e2e3e5) border-b bg-(--gui-surface,#fff) px-4 py-3 text-(--gui-text) text-sm'
    >
      <label className='flex flex-col gap-1 text-xs'>
        Brand
        <input
          type='color'
          value={current.brandColor ?? '#1A73E8'}
          onChange={(event) => patch({ brandColor: event.target.value })}
          className='h-8 w-12 cursor-pointer rounded border border-(--gui-border,#e2e3e5) bg-transparent p-0.5'
        />
      </label>
      <label className='flex flex-col gap-1 text-xs'>
        Density
        <select
          value={current.density ?? 'comfortable'}
          onChange={(event) =>
            patch({ density: event.target.value as ArenaGenerativeTheme['density'] })
          }
          className='h-8 rounded border border-(--gui-border,#e2e3e5) bg-(--gui-canvas,#f7f8f9) px-2'
        >
          {ARENA_GENERATIVE_THEME_DENSITIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className='flex flex-col gap-1 text-xs'>
        Radius
        <select
          value={current.radius ?? 'md'}
          onChange={(event) =>
            patch({ radius: event.target.value as ArenaGenerativeTheme['radius'] })
          }
          className='h-8 rounded border border-(--gui-border,#e2e3e5) bg-(--gui-canvas,#f7f8f9) px-2'
        >
          {ARENA_GENERATIVE_THEME_RADII.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <p className='pb-1 text-(--gui-text-muted,#575a66) text-xs'>
        Light/dark follows Sim theme settings
      </p>
      <button
        type='button'
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(instructions)
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }}
        className='h-8 rounded px-2 text-(--gui-brand,#1a73e8) text-xs hover:underline'
      >
        {copied ? 'Copied' : 'Copy theme as edit instructions'}
      </button>
    </div>
  )
}
