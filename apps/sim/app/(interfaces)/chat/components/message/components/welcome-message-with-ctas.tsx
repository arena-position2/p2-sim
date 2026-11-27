'use client'

import { cn } from '@sim/emcn'
import { DEPLOYED_CHAT_TEXT_BODY } from '@/app/(interfaces)/chat/constants'
import {
  parseWelcomeSegments,
  type WelcomeSegment,
} from '@/app/(interfaces)/chat/utils/welcome-message-ctas'

export type WelcomeMessageCtaVariant = 'chat' | 'landing'

interface WelcomeMessageWithCtasProps {
  content: string
  onQueryClick?: (query: string) => void
  className?: string
  /**
   * `chat` is stacked suggestion chips under welcome copy; `landing` is inline
   * brand-link CTAs inside muted landing / modal body copy.
   */
  variant?: WelcomeMessageCtaVariant
}

type WelcomeRenderPart = { type: 'text'; value: string } | { type: 'queries'; values: string[] }

/**
 * Collapses whitespace-only gaps between query CTAs so flex gap owns spacing,
 * and keeps meaningful welcome copy as text parts.
 */
function groupWelcomeParts(segments: WelcomeSegment[]): WelcomeRenderPart[] {
  const parts: WelcomeRenderPart[] = []

  for (const segment of segments) {
    if (segment.type === 'text') {
      if (/^\s*$/.test(segment.value)) {
        continue
      }
      parts.push({ type: 'text', value: segment.value.replace(/\n{3,}/g, '\n\n').trimEnd() })
      continue
    }

    const last = parts[parts.length - 1]
    if (last?.type === 'queries') {
      last.values.push(segment.value)
    } else {
      parts.push({ type: 'queries', values: [segment.value] })
    }
  }

  return parts
}

/**
 * Renders welcome-message text with `{{query}}` tokens as clickable CTAs.
 */
export function WelcomeMessageWithCtas({
  content,
  onQueryClick,
  className,
  variant = 'landing',
}: WelcomeMessageWithCtasProps) {
  const segments = parseWelcomeSegments(content).filter(
    (s) => s.type !== 'text' || s.value.length > 0
  )

  if (variant === 'chat') {
    const parts = groupWelcomeParts(segments)

    return (
      <div className={cn('flex w-full min-w-0 max-w-full flex-col break-words', className)}>
        {parts.map((part, index) => {
          if (part.type === 'text') {
            return (
              <span
                key={`w-text-${index}`}
                className='whitespace-pre-wrap'
                style={{ color: DEPLOYED_CHAT_TEXT_BODY }}
              >
                {part.value}
              </span>
            )
          }

          return (
            <div
              key={`w-queries-${index}`}
              className={cn(
                'flex w-full min-w-0 max-w-full flex-col items-start gap-2',
                index > 0 && 'mt-3'
              )}
            >
              {part.values.map((query, queryIndex) => (
                <button
                  key={`w-query-${index}-${queryIndex}`}
                  type='button'
                  className={cn(
                    'w-fit max-w-full min-w-0 cursor-pointer whitespace-normal break-words rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-left font-[family-name:var(--font-inter)] font-medium text-[var(--text-primary)] text-small leading-[21px] transition-colors',
                    'hover:bg-[var(--surface-hover)]'
                  )}
                  onClick={() => onQueryClick?.(query)}
                  title='Run this query'
                >
                  {query}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={`w-text-${index}`}>{segment.value}</span>
        }
        return (
          <button
            key={`w-query-${index}`}
            type='button'
            className='inline cursor-pointer break-words rounded-sm border-0 bg-transparent p-0 font-medium text-[var(--color-ds-text-link-hover,#155CBA)] underline decoration-[var(--color-ds-text-link-hover,#155CBA)]/40 underline-offset-2 transition-colors hover:decoration-[var(--color-ds-text-link-hover,#155CBA)]'
            onClick={() => onQueryClick?.(segment.value)}
            title='Run this query'
          >
            {segment.value}
          </button>
        )
      })}
    </span>
  )
}
