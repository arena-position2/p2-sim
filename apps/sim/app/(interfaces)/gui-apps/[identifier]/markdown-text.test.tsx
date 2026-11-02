/**
 * @vitest-environment jsdom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('streamdown/styles.css', () => ({}))

import { MarkdownText } from '@/app/(interfaces)/gui-apps/[identifier]/markdown-text'

describe('MarkdownText', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    unmount?.()
    unmount = undefined
  })

  function render(content: string) {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(<MarkdownText content={content} />)
    })
    unmount = () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    }
    return container
  }

  it('renders nothing for empty content', () => {
    const container = render('   ')
    expect(container.textContent).toBe('')
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders a JSON literal in a code block so indentation is kept', () => {
    const container = render('{"id":"1441","industry":"Software"}')
    expect(container.querySelector('pre')).toBeTruthy()
    expect(container.textContent).toContain('Software')
    expect(container.querySelector('p')?.textContent ?? '').not.toBe(
      '{"id":"1441","industry":"Software"}'
    )
  })

  it('renders headings darker than body lists', () => {
    const container = render(
      '## H2: What are CFL bulbs?\n\n- Cite EPA sources\n- **Target Keywords:** CFL bulbs'
    )
    const heading = container.querySelector('h2')
    const list = container.querySelector('ul')
    expect(heading?.className).toContain('font-semibold')
    expect(heading?.className).toContain('gui-section-size')
    expect(heading?.className).not.toContain('gui-title-size')
    expect(heading?.className).toContain('text-(--gui-text,#2c2d33)')
    expect(list?.className).toContain('space-y-2')
    expect(list?.className).toContain('text-(--gui-text-muted,#575a66)')
    expect(list?.className).toContain('gui-body-size')
  })

  it('opens markdown links in a new tab and drops javascript hrefs', () => {
    const container = render('[ok](https://example.com) [bad](javascript:alert(1))')
    const links = Array.from(container.querySelectorAll('a'))
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toMatch(/^https:\/\/example\.com\/?$/)
    expect(links[0]?.getAttribute('rel')).toBe('noreferrer')
    expect(links[0]?.getAttribute('target')).toBe('_blank')
    expect(container.textContent).toContain('bad')
  })
})
