'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Code, cn, Tooltip } from '@sim/emcn'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { renumberMarkdownOrderedLists } from '@/lib/core/utils/markdown-ordered-lists'

/**
 * Recursively extracts text content from React elements
 * @param element - React node to extract text from
 * @returns Concatenated text content
 */
const getTextContent = (element: React.ReactNode): string => {
  if (typeof element === 'string') {
    return element
  }
  if (typeof element === 'number') {
    return String(element)
  }
  if (React.isValidElement(element)) {
    const elementProps = element.props as { children?: React.ReactNode }
    return getTextContent(elementProps.children)
  }
  if (Array.isArray(element)) {
    return element.map(getTextContent).join('')
  }
  return ''
}

// Global layout fixes for markdown content inside the copilot panel
if (typeof document !== 'undefined') {
  const styleId = 'copilot-markdown-fix'
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      /* Prevent any markdown content from expanding beyond the panel */
      .copilot-markdown-wrapper,
      .copilot-markdown-wrapper * {
        max-width: 100% !important;
      }

      .copilot-markdown-wrapper p,
      .copilot-markdown-wrapper li {
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }

      .copilot-markdown-wrapper a {
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }

      .copilot-markdown-wrapper code:not(pre code) {
        white-space: normal !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }

      /* Table overflow handling for many columns */
      .copilot-markdown-wrapper table {
        table-layout: auto !important;
        width: 100% !important;
        min-width: max-content !important;
      }

      .copilot-markdown-wrapper th {
        white-space: nowrap !important;
        min-width: 80px !important;
      }

      .copilot-markdown-wrapper td {
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
        max-width: 400px !important;
        min-width: 80px !important;
      }

      /* Reduce top margin for first heading (e.g., right after thinking block) */
      .copilot-markdown-wrapper > h1:first-child,
      .copilot-markdown-wrapper > h2:first-child,
      .copilot-markdown-wrapper > h3:first-child,
      .copilot-markdown-wrapper > h4:first-child {
        margin-top: 0.25rem !important;
      }
    `
    document.head.appendChild(style)
  }
}

/**
 * Link component with hover preview tooltip
 * Displays full URL on hover for better UX
 * @param props - Component props with href and children
 * @returns Link element with tooltip preview
 */
function LinkWithPreview({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>
        <a
          href={href}
          className='inline break-words text-[var(--text-primary)] underline decoration-dashed underline-offset-4 hover:text-[var(--text-primary)]'
          target='_blank'
          rel='noopener noreferrer'
        >
          {children}
        </a>
      </Tooltip.Trigger>
      <Tooltip.Content side='top' align='center' sideOffset={5} className='max-w-sm p-3'>
        <span className='text-sm'>{href}</span>
      </Tooltip.Content>
    </Tooltip.Root>
  )
}

/**
 * Props for the CopilotMarkdownRenderer component
 */
interface ArenaCopilotMarkdownRendererProps {
  /** Markdown content to render */
  content: string
  /**
   * `block` (default) is for normal message blocks. `inline` maps paragraphs to spans so emphasis
   * and links can render inside one visual line (e.g. pipe-delimited pricing rows).
   */
  variant?: 'block' | 'inline'
  /** Custom image renderer for preview/download/select overlays in chat */
  renderImage?: (args: { src: string; alt?: string }) => React.ReactNode
  /** Tailwind font family class for markdown body text */
  fontClassName?: string
  /** Tailwind text color classes for markdown body copy */
  bodyTextClassName?: string
  /** Tailwind text color classes for markdown headings */
  headingTextClassName?: string
}

/**
 * CopilotMarkdownRenderer renders markdown content with custom styling
 * Supports GitHub-flavored markdown, code blocks with syntax highlighting,
 * tables, links with preview, and more
 *
 * @param props - Component props
 * @returns Rendered markdown content
 */
export default function ArenaCopilotMarkdownRenderer({
  content,
  variant = 'block',
  renderImage,
  fontClassName = 'font-geist-sans',
  bodyTextClassName = 'text-[var(--text-primary)]',
  headingTextClassName = 'text-[var(--text-primary)]',
}: ArenaCopilotMarkdownRendererProps) {
  const [copiedCodeBlocks, setCopiedCodeBlocks] = useState<Record<string, boolean>>({})
  const displayContent = useMemo(() => renumberMarkdownOrderedLists(content), [content])

  // Reset copy success state after 2 seconds
  useEffect(() => {
    const timers: Record<string, NodeJS.Timeout> = {}

    Object.keys(copiedCodeBlocks).forEach((key) => {
      if (copiedCodeBlocks[key]) {
        timers[key] = setTimeout(() => {
          setCopiedCodeBlocks((prev) => ({ ...prev, [key]: false }))
        }, 2000)
      }
    })

    return () => {
      Object.values(timers).forEach(clearTimeout)
    }
  }, [copiedCodeBlocks])

  // Custom components for react-markdown with current styling - memoized to prevent re-renders
  const markdownComponents = useMemo(
    () => ({
      // Paragraph
      p: ({ children }: React.HTMLAttributes<HTMLParagraphElement>) =>
        variant === 'inline' ? (
          <span
            className={cn(
              'my-0 inline text-base leading-relaxed',
              bodyTextClassName,
              fontClassName
            )}
          >
            {children}
          </span>
        ) : (
          <p
            className={cn(
              'my-2 text-base leading-relaxed last:mb-0',
              bodyTextClassName,
              fontClassName
            )}
          >
            {children}
          </p>
        ),

      // Headings
      h1: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h1 className={cn('my-3 font-semibold text-2xl', headingTextClassName, fontClassName)}>
          {children}
        </h1>
      ),
      h2: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h2 className={cn('my-3 font-semibold text-xl', headingTextClassName, fontClassName)}>
          {children}
        </h2>
      ),
      h3: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h3 className={cn('my-3 font-semibold text-lg', headingTextClassName, fontClassName)}>
          {children}
        </h3>
      ),
      h4: ({ children }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h4 className={cn('my-3 font-semibold text-base', headingTextClassName, fontClassName)}>
          {children}
        </h4>
      ),

      // Lists
      ul: ({ children }: React.HTMLAttributes<HTMLUListElement>) => (
        <ul
          className={cn('ml-7 pl-2', bodyTextClassName, fontClassName)}
          style={{ listStyleType: 'disc' }}
        >
          {children}
        </ul>
      ),
      ol: ({ children, start }: React.OlHTMLAttributes<HTMLOListElement>) => (
        <ol
          start={start}
          className={cn('ml-7 pl-2', bodyTextClassName, fontClassName)}
          style={{ listStyleType: 'decimal' }}
        >
          {children}
        </ol>
      ),
      li: ({ children }: React.LiHTMLAttributes<HTMLLIElement> & { ordered?: boolean }) => (
        <li className={cn(bodyTextClassName, fontClassName)} style={{ display: 'list-item' }}>
          {children}
        </li>
      ),

      // Code blocks - render using shared Code.Viewer for consistent styling
      pre: ({ children }: React.HTMLAttributes<HTMLPreElement>) => {
        let codeContent: React.ReactNode = children
        let language = 'code'

        if (
          React.isValidElement<{ className?: string; children?: React.ReactNode }>(children) &&
          children.type === 'code'
        ) {
          const childElement = children as React.ReactElement<{
            className?: string
            children?: React.ReactNode
          }>
          codeContent = childElement.props.children
          language = childElement.props.className?.replace('language-', '') || 'code'
        }

        // Extract actual text content
        let actualCodeText = ''
        if (typeof codeContent === 'string') {
          actualCodeText = codeContent
        } else if (React.isValidElement(codeContent)) {
          // If it's a React element, try to get its text content
          actualCodeText = getTextContent(codeContent)
        } else if (Array.isArray(codeContent)) {
          // If it's an array of elements, join their text content
          actualCodeText = codeContent
            .map((child) =>
              typeof child === 'string'
                ? child
                : React.isValidElement(child)
                  ? getTextContent(child)
                  : ''
            )
            .join('')
        } else {
          actualCodeText = String(codeContent || '')
        }

        // Create a unique key for this code block based on content
        const codeText = actualCodeText || 'code'
        const codeBlockKey = `${language}-${codeText.substring(0, 30).replace(/\s/g, '-')}-${codeText.length}`

        const showCopySuccess = copiedCodeBlocks[codeBlockKey] || false

        const handleCopy = () => {
          const textToCopy = actualCodeText
          if (textToCopy) {
            navigator.clipboard.writeText(textToCopy)
            setCopiedCodeBlocks((prev) => ({ ...prev, [codeBlockKey]: true }))
          }
        }

        // Map markdown language tag to Code.Viewer supported languages
        const normalizedLanguage = (language || '').toLowerCase()
        const viewerLanguage:
          | 'javascript'
          | 'json'
          | 'python'
          | 'typescript'
          | 'tsx'
          | 'jsx'
          | 'bash'
          | 'yaml' =
          normalizedLanguage === 'json'
            ? 'json'
            : normalizedLanguage === 'python' || normalizedLanguage === 'py'
              ? 'python'
              : normalizedLanguage === 'typescript' || normalizedLanguage === 'ts'
                ? 'typescript'
                : normalizedLanguage === 'tsx'
                  ? 'tsx'
                  : normalizedLanguage === 'jsx'
                    ? 'jsx'
                    : normalizedLanguage === 'bash' ||
                        normalizedLanguage === 'shell' ||
                        normalizedLanguage === 'sh'
                      ? 'bash'
                      : normalizedLanguage === 'yaml' || normalizedLanguage === 'yml'
                        ? 'yaml'
                        : 'javascript'

        return (
          <div className='my-6 w-0 min-w-full overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] text-sm dark:bg-[#1F1F1F]'>
            <div className='flex items-center justify-between border-[var(--border-strong)] border-b px-4 py-1.5'>
              <span className='font-season text-[#A3A3A3] text-xs'>
                {language === 'code' ? viewerLanguage : language}
              </span>
              <button
                onClick={handleCopy}
                className='text-[#A3A3A3] transition-colors hover:text-gray-300'
                title='Copy'
              >
                {showCopySuccess ? (
                  <Check className='h-3 w-3' strokeWidth={2} />
                ) : (
                  <Copy className='h-3 w-3' strokeWidth={2} />
                )}
              </button>
            </div>
            <Code.Viewer
              code={actualCodeText}
              showGutter
              language={viewerLanguage}
              className='m-0 rounded-none border-0 bg-transparent'
            />
          </div>
        )
      },

      // Inline code
      code: ({
        inline,
        className,
        children,
        ...props
      }: React.HTMLAttributes<HTMLElement> & { className?: string; inline?: boolean }) => {
        if (inline) {
          return (
            <code
              className='whitespace-normal break-all rounded bg-[var(--surface-3)] px-1 py-0.5 font-mono text-[0.9em] text-[var(--text-primary)]'
              {...props}
            >
              {children}
            </code>
          )
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      },

      // Bold text
      strong: ({ children }: React.HTMLAttributes<HTMLElement>) => (
        <strong className={cn('font-semibold', headingTextClassName)}>{children}</strong>
      ),

      // Bold text (alternative)
      b: ({ children }: React.HTMLAttributes<HTMLElement>) => (
        <b className={cn('font-semibold', headingTextClassName)}>{children}</b>
      ),

      // Italic text
      em: ({ children }: React.HTMLAttributes<HTMLElement>) => (
        <em className={cn('italic', bodyTextClassName)}>{children}</em>
      ),

      // Italic text (alternative)
      i: ({ children }: React.HTMLAttributes<HTMLElement>) => (
        <i className={cn('italic', bodyTextClassName)}>{children}</i>
      ),

      // Blockquotes
      blockquote: ({ children }: React.HTMLAttributes<HTMLQuoteElement>) => (
        <blockquote
          className={cn(
            'my-4 border-[var(--border)] border-l-4 py-1 pl-4 italic',
            bodyTextClassName,
            fontClassName
          )}
        >
          {children}
        </blockquote>
      ),

      // Horizontal rule
      hr: () => <hr className='my-4 border-[var(--border)] border-t' />,

      // Links
      a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <LinkWithPreview href={href || '#'} {...props}>
          {children}
        </LinkWithPreview>
      ),

      // Tables
      table: ({ children }: React.TableHTMLAttributes<HTMLTableElement>) => (
        <div className='my-4 w-full overflow-x-auto overflow-y-visible'>
          <div className='inline-block min-w-full align-middle'>
            <table
              className={cn(
                'min-w-full table-auto border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] text-sm',
                bodyTextClassName,
                fontClassName
              )}
            >
              {children}
            </table>
          </div>
        </div>
      ),
      thead: ({ children }: React.HTMLAttributes<HTMLTableSectionElement>) => (
        <thead className='bg-[var(--surface-3)] text-left text-[var(--text-secondary)]'>
          {children}
        </thead>
      ),
      tbody: ({ children }: React.HTMLAttributes<HTMLTableSectionElement>) => (
        <tbody className='divide-y divide-[var(--border)]'>{children}</tbody>
      ),
      tr: ({ children }: React.HTMLAttributes<HTMLTableRowElement>) => (
        <tr className='border-[var(--border)] border-b transition-colors hover:bg-[var(--surface-hover)]'>
          {children}
        </tr>
      ),
      th: ({ children }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
        <th className='whitespace-nowrap border-[var(--border)] border-r px-4 py-2 font-medium text-[var(--text-secondary)] last:border-r-0'>
          {children}
        </th>
      ),
      td: ({ children }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
        <td className='max-w-[360px] whitespace-normal break-words border-[var(--border)] border-r bg-[var(--surface-2)] px-4 py-2 align-top text-[var(--text-primary)] last:border-r-0'>
          {children}
        </td>
      ),

      // Images
      img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
        if (typeof src === 'string' && renderImage) {
          return <>{renderImage({ src, alt })}</>
        }

        return (
          <img
            src={src}
            alt={alt || 'Image'}
            className='my-3 h-auto max-w-full rounded-md'
            {...props}
          />
        )
      },
    }),
    [copiedCodeBlocks, variant, renderImage, fontClassName, bodyTextClassName, headingTextClassName]
  )

  const Root = variant === 'inline' ? 'span' : 'div'

  return (
    <Tooltip.Provider>
      <Root
        className={cn(
          'copilot-markdown-wrapper max-w-full break-words text-base leading-relaxed',
          bodyTextClassName,
          fontClassName,
          variant === 'inline' && 'inline'
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[
            rehypeRaw,
            [
              rehypeSanitize,
              {
                // Allow safe HTML tags for formatting
                tagNames: [
                  'br',
                  'p',
                  'strong',
                  'em',
                  'b',
                  'i',
                  'u',
                  's',
                  'code',
                  'pre',
                  'blockquote',
                  'hr',
                  'a',
                  'img',
                  'ul',
                  'ol',
                  'li',
                  'h1',
                  'h2',
                  'h3',
                  'h4',
                  'h5',
                  'h6',
                  'table',
                  'thead',
                  'tbody',
                  'tr',
                  'th',
                  'td',
                  'div',
                  'span',
                ],
                // Allow attributes for links and images
                attributes: {
                  a: ['href', 'title', 'target', 'rel'],
                  img: ['src', 'alt', 'title', 'width', 'height'],
                  // GFM sets start when a split ordered list continues (2., 3.…).
                  // Without it, every separate <ol> renders as 1. 1. 1.
                  ol: ['start'],
                  '*': ['className', 'id'],
                },
              },
            ],
          ]}
          components={markdownComponents}
        >
          {displayContent}
        </ReactMarkdown>
      </Root>
    </Tooltip.Provider>
  )
}
