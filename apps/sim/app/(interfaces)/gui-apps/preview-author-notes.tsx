'use client'

import { type KeyboardEvent, useState } from 'react'
import { cn } from '@sim/emcn'
import type {
  ArenaGenerativeAdoptedChange,
  ArenaGenerativeGenerateWarning,
} from '@/lib/arena-generative-ui/generate-warnings'

type PreviewAuthorNotesPanel = 'warnings' | 'edit-instructions'

interface PreviewAuthorNotesProps {
  generateWarnings: ArenaGenerativeGenerateWarning[]
  adoptedChanges: ArenaGenerativeAdoptedChange[]
  screenshotMatchNotes: string | null
  editInstructions: string
}

function warningsCopyText(
  generateWarnings: ArenaGenerativeGenerateWarning[],
  adoptedChanges: ArenaGenerativeAdoptedChange[],
  screenshotMatchNotes: string | null
): string {
  const sections: string[] = []
  if (adoptedChanges.length > 0) {
    sections.push(
      'Changes we applied:',
      ...adoptedChanges.map((change) => `- Asked: ${change.asked}\n  Adopted: ${change.adopted}`)
    )
  }
  if (generateWarnings.length > 0) {
    sections.push(
      'Generate fallbacks:',
      ...generateWarnings.map((warning) => `- ${warning.message}`)
    )
  }
  const screenshot = screenshotMatchNotes?.trim() ?? ''
  if (screenshot) {
    sections.push(screenshot)
  }
  return sections.join('\n\n')
}

/**
 * Preview-only author notes. Warnings and pasteable edit instructions open in a
 * modal so they do not sit on the generated page.
 */
export function PreviewAuthorNotes({
  generateWarnings,
  adoptedChanges,
  screenshotMatchNotes,
  editInstructions,
}: PreviewAuthorNotesProps) {
  const [panel, setPanel] = useState<PreviewAuthorNotesPanel | null>(null)
  const [copied, setCopied] = useState(false)
  const warningText = warningsCopyText(generateWarnings, adoptedChanges, screenshotMatchNotes)
  const hasWarnings = warningText.length > 0
  const hasEditInstructions = editInstructions.trim().length > 0
  const copyText = panel === 'edit-instructions' ? editInstructions : warningText

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setPanel(null)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <>
      {hasWarnings ? (
        <button
          type='button'
          data-testid='preview-view-warnings'
          onClick={() => {
            setCopied(false)
            setPanel('warnings')
          }}
          className='text-(--gui-brand,#1a73e8) hover:underline'
        >
          View warnings
        </button>
      ) : null}
      {hasEditInstructions ? (
        <button
          type='button'
          data-testid='preview-view-edit-instructions'
          onClick={() => {
            setCopied(false)
            setPanel('edit-instructions')
          }}
          className='text-(--gui-brand,#1a73e8) hover:underline'
        >
          View edit instructions
        </button>
      ) : null}
      {panel ? (
        <div
          className='fixed inset-0 z-30 flex items-center justify-center bg-[rgb(44_45_51/40%)] p-4'
          data-testid='preview-author-notes-backdrop'
          onClick={() => setPanel(null)}
        >
          <div
            role='dialog'
            aria-modal='true'
            aria-labelledby='preview-author-notes-title'
            data-testid='preview-author-notes'
            data-panel={panel}
            className='flex max-h-[80vh] w-full max-w-lg flex-col rounded-(--gui-radius,12px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#ffffff) shadow-(--gui-shadow-card,0px_2px_8px_rgba(44,45,51,0.1))'
            onClick={(event) => event.stopPropagation()}
            onKeyDown={onKeyDown}
          >
            <div className='flex items-start justify-between gap-3 border-(--gui-border,#e2e3e5) border-b px-4 py-3'>
              <h2
                id='preview-author-notes-title'
                className='font-medium text-(--gui-text,#2c2d33) text-sm'
              >
                {panel === 'warnings' ? 'Warnings' : 'Edit instructions'}
              </h2>
              <button
                type='button'
                autoFocus
                data-testid='preview-author-notes-close'
                onClick={() => setPanel(null)}
                className='text-(--gui-text-muted,#8a8d99) text-xs hover:underline'
              >
                Close
              </button>
            </div>
            <div className='min-h-0 flex-1 overflow-y-auto px-4 py-3 text-(--gui-text,#2c2d33) text-sm'>
              {panel === 'warnings' ? (
                <WarningsBody
                  generateWarnings={generateWarnings}
                  adoptedChanges={adoptedChanges}
                  screenshotMatchNotes={screenshotMatchNotes}
                />
              ) : (
                <pre className='whitespace-pre-wrap wrap-break-word font-sans'>{editInstructions}</pre>
              )}
            </div>
            <div className='flex justify-end border-(--gui-border,#e2e3e5) border-t px-4 py-3'>
              <button
                type='button'
                data-testid='preview-author-notes-copy'
                onClick={copy}
                className={cn(
                  'rounded px-2 py-1 text-(--gui-brand,#1a73e8) text-xs hover:underline'
                )}
              >
                {copied
                  ? 'Copied'
                  : panel === 'warnings'
                    ? 'Copy warnings'
                    : 'Copy as edit instructions'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

interface WarningsBodyProps {
  generateWarnings: ArenaGenerativeGenerateWarning[]
  adoptedChanges: ArenaGenerativeAdoptedChange[]
  screenshotMatchNotes: string | null
}

function WarningsBody({
  generateWarnings,
  adoptedChanges,
  screenshotMatchNotes,
}: WarningsBodyProps) {
  const screenshot = screenshotMatchNotes?.trim() ?? ''
  return (
    <div className='flex flex-col gap-4'>
      {adoptedChanges.length > 0 ? (
        <section>
          <h3 className='mb-2 font-medium text-xs uppercase tracking-wide text-(--gui-text-muted,#8a8d99)'>
            Changes we applied
          </h3>
          <ul className='flex flex-col gap-3'>
            {adoptedChanges.map((change) => (
              <li key={`${change.code}:${change.asked}`}>
                <p>
                  <span className='text-(--gui-text-muted,#8a8d99)'>Asked: </span>
                  {change.asked}
                </p>
                <p>
                  <span className='text-(--gui-text-muted,#8a8d99)'>Adopted: </span>
                  {change.adopted}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {generateWarnings.length > 0 ? (
        <section>
          <h3 className='mb-2 font-medium text-xs uppercase tracking-wide text-(--gui-text-muted,#8a8d99)'>
            Generate fallbacks
          </h3>
          <ul className='flex list-disc flex-col gap-1 pl-4'>
            {generateWarnings.map((warning) => (
              <li key={warning.code}>{warning.message}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {screenshot ? (
        <section>
          <h3 className='mb-2 font-medium text-xs uppercase tracking-wide text-(--gui-text-muted,#8a8d99)'>
            Screenshot
          </h3>
          <p className='whitespace-pre-wrap wrap-break-word'>{screenshot}</p>
        </section>
      ) : null}
    </div>
  )
}
