'use client'

import type { CSSProperties, HTMLAttributes } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'

const HEADING = 'text-(--gui-text,#2c2d33)'
const BODY = 'text-(--gui-text,#2c2d33)'
const META = 'text-(--gui-text-muted,#575a66)'

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const trimmed = href.trim()
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('javascript:') || lower.startsWith('data:')) return undefined
  return trimmed
}

const COMPONENTS = {
  p: ({ children }: HTMLAttributes<HTMLParagraphElement>) => (
    <p
      className={`mb-2 text-(length:--gui-body-size,16px) leading-(--gui-body-leading,24px) last:mb-0 ${BODY}`}
    >
      {children}
    </p>
  ),
  h1: ({ children }: HTMLAttributes<HTMLHeadingElement>) => (
    <h1
      className={`mt-4 mb-2 font-semibold text-(length:--gui-title-size,24px) leading-(--gui-title-leading,32px) first:mt-0 ${HEADING}`}
    >
      {children}
    </h1>
  ),
  h2: ({ children }: HTMLAttributes<HTMLHeadingElement>) => (
    <h2
      className={`mt-4 mb-2 font-semibold text-(length:--gui-section-size,18px) leading-(--gui-section-leading,26px) first:mt-0 ${HEADING}`}
    >
      {children}
    </h2>
  ),
  h3: ({ children }: HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className={`mt-3 mb-2 font-semibold text-(length:--gui-body-size,16px) leading-(--gui-body-leading,24px) first:mt-0 ${HEADING}`}
    >
      {children}
    </h3>
  ),
  h4: ({ children }: HTMLAttributes<HTMLHeadingElement>) => (
    <h4
      className={`mt-2 mb-1 font-semibold text-(length:--gui-label-size,12px) leading-(--gui-label-leading,16px) first:mt-0 ${HEADING}`}
    >
      {children}
    </h4>
  ),
  ul: ({ children }: HTMLAttributes<HTMLUListElement>) => (
    <ul
      className={`mb-3 list-disc space-y-2 pl-5 text-(length:--gui-body-size,16px) last:mb-0 ${META}`}
    >
      {children}
    </ul>
  ),
  ol: ({ children }: HTMLAttributes<HTMLOListElement>) => (
    <ol
      className={`mb-3 list-decimal space-y-2 pl-5 text-(length:--gui-body-size,16px) last:mb-0 ${META}`}
    >
      {children}
    </ol>
  ),
  li: ({ children }: HTMLAttributes<HTMLLIElement>) => (
    <li className={`leading-(--gui-body-leading,24px) ${META}`}>{children}</li>
  ),
  strong: ({ children }: HTMLAttributes<HTMLElement>) => (
    <strong className={`font-semibold ${HEADING}`}>{children}</strong>
  ),
  em: ({ children }: HTMLAttributes<HTMLElement>) => <em>{children}</em>,
  pre: ({ children }: HTMLAttributes<HTMLPreElement>) => (
    <pre className='mb-2 overflow-x-auto rounded-md bg-(--color-ds-grey-50,#f7f8f9) p-3 font-mono text-xs last:mb-0'>
      {children}
    </pre>
  ),
  code: ({ children, className }: HTMLAttributes<HTMLElement>) => {
    const isBlock = Boolean(className)
    if (isBlock) {
      return <code className={className}>{children}</code>
    }
    return (
      <code className='rounded bg-(--color-ds-grey-100,#eef0f2) px-1 py-0.5 font-mono text-[0.9em]'>
        {children}
      </code>
    )
  },
  blockquote: ({ children }: HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      className={`my-2 border-(--color-ds-grey-300,#c5c6cc) border-l-2 pl-3 text-(length:--gui-body-size,16px) italic ${META}`}
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr className='my-3 border-(--color-ds-grey-200,#e2e3e5)' />,
  a: ({ href, children }: HTMLAttributes<HTMLAnchorElement> & { href?: string }) => {
    const safe = safeHref(href)
    if (!safe) {
      return <span>{children}</span>
    }
    return (
      <a
        href={safe}
        className='text-(--color-ds-blue-600,#1a73e8) underline-offset-2 hover:underline'
        target='_blank'
        rel='noreferrer'
      >
        {children}
      </a>
    )
  },
  table: ({ children }: HTMLAttributes<HTMLTableElement>) => (
    <div className='my-2 w-full overflow-x-auto'>
      <table className='min-w-full border border-(--color-ds-grey-200,#e2e3e5) text-sm'>
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: HTMLAttributes<HTMLTableSectionElement>) => (
    <thead className='bg-(--color-ds-grey-50,#f7f8f9) text-left'>{children}</thead>
  ),
  tbody: ({ children }: HTMLAttributes<HTMLTableSectionElement>) => <tbody>{children}</tbody>,
  tr: ({ children }: HTMLAttributes<HTMLTableRowElement>) => (
    <tr className='border-(--color-ds-grey-200,#e2e3e5) border-b'>{children}</tr>
  ),
  th: ({ children }: HTMLAttributes<HTMLTableCellElement>) => (
    <th className='px-3 py-1.5 font-medium'>{children}</th>
  ),
  td: ({ children }: HTMLAttributes<HTMLTableCellElement>) => (
    <td className='px-3 py-1.5'>{children}</td>
  ),
  img: ({ src, alt }: HTMLAttributes<HTMLImageElement> & { src?: string; alt?: string }) => (
    <img src={src} alt={alt || ''} className='my-2 h-auto max-w-full rounded-md' />
  ),
}

interface MarkdownTextProps {
  content: string
  className?: string
  style?: CSSProperties
}

/**
 * Renders catalog copy and API bodies as markdown (GFM). JSON literals are
 * fenced so they keep indentation instead of collapsing into a paragraph.
 * Plain strings stay a single paragraph. Empty content is omitted.
 */
export function MarkdownText({ content, className, style }: MarkdownTextProps) {
  const trimmed = content.trim()
  if (!trimmed) return null

  const body =
    looksLikeJsonLiteral(trimmed) && !trimmed.startsWith('```')
      ? `\`\`\`json\n${trimmed}\n\`\`\``
      : trimmed

  return (
    <div className={className} style={style}>
      <Streamdown mode='static' animated={false} components={COMPONENTS}>
        {body}
      </Streamdown>
    </div>
  )
}

function looksLikeJsonLiteral(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}
