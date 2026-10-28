/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_CREATE_CONTENT_MAX_BYTES,
  HTML_FULL_UPDATE_MAX_EXISTING_BYTES,
  HTML_LARGE_EXISTING_BYTES,
  isHtmlWorkspaceTarget,
  rejectHtmlCreateContent,
  rejectHtmlFullUpdate,
  utf8ByteLength,
} from '@/lib/mothership/tools/server/files/html-edit-size-guards'
import { SIM_PAGE_CONTENT_TYPE } from '@/lib/workspace-files/page-compile'

describe('isHtmlWorkspaceTarget', () => {
  it('detects html extensions and content types', () => {
    expect(isHtmlWorkspaceTarget('files/page.html')).toBe(true)
    expect(isHtmlWorkspaceTarget('page.HTM')).toBe(true)
    expect(isHtmlWorkspaceTarget('files/page.html/content')).toBe(true)
    expect(isHtmlWorkspaceTarget('About', SIM_PAGE_CONTENT_TYPE)).toBe(true)
    expect(isHtmlWorkspaceTarget('note.md', 'text/html')).toBe(true)
    expect(isHtmlWorkspaceTarget('note.md')).toBe(false)
    expect(isHtmlWorkspaceTarget('deck.pptx')).toBe(false)
  })
})

describe('rejectHtmlFullUpdate', () => {
  it('allows lean HTML under the update ceiling', () => {
    const content = '<html><body>small</body></html>'
    expect(utf8ByteLength(content)).toBeLessThan(HTML_FULL_UPDATE_MAX_EXISTING_BYTES)
    expect(
      rejectHtmlFullUpdate({
        fileName: 'ad-generator.html',
        existingContent: content,
      })
    ).toBeNull()
  })

  it('rejects medium HTML full updates with a patch steer', () => {
    const existingContent = 'a'.repeat(HTML_FULL_UPDATE_MAX_EXISTING_BYTES)
    const result = rejectHtmlFullUpdate({
      fileName: 'dashboard.html',
      existingContent,
    })
    expect(result?.errorType).toBe('html_full_update_too_large')
    expect(result?.recoverable).toBe(true)
    expect(result?.message).toMatch(/Full update blocked/i)
    expect(result?.message).toMatch(/operation=patch/i)
    expect(result?.message).not.toMatch(/Arena\/Figma-scale/)
  })

  it('labels Arena-scale files in the reject message', () => {
    const existingContent = 'b'.repeat(HTML_LARGE_EXISTING_BYTES)
    const result = rejectHtmlFullUpdate({
      fileName: 'arena-export.html',
      existingContent,
      contentType: 'text/html',
    })
    expect(result?.errorType).toBe('html_full_update_too_large')
    expect(result?.message).toMatch(/Arena\/Figma-scale/)
  })

  it('does not gate non-HTML files', () => {
    expect(
      rejectHtmlFullUpdate({
        fileName: 'notes.md',
        existingContent: 'x'.repeat(HTML_LARGE_EXISTING_BYTES),
      })
    ).toBeNull()
  })
})

describe('rejectHtmlCreateContent', () => {
  it('allows lean create_file HTML bodies', () => {
    expect(
      rejectHtmlCreateContent({
        fileName: 'files/shell.html',
        content: '<html><body><h1>Lean</h1></body></html>',
      })
    ).toBeNull()
  })

  it('rejects oversized HTML create bodies', () => {
    const content = 'c'.repeat(HTML_CREATE_CONTENT_MAX_BYTES + 1)
    const result = rejectHtmlCreateContent({
      fileName: 'files/dump.html',
      content,
    })
    expect(result?.errorType).toBe('html_create_too_large')
    expect(result?.message).toMatch(/too large/i)
    expect(result?.message).toMatch(/lean shell/i)
  })

  it('does not gate markdown create bodies', () => {
    expect(
      rejectHtmlCreateContent({
        fileName: 'files/notes.md',
        content: 'd'.repeat(HTML_CREATE_CONTENT_MAX_BYTES + 1),
      })
    ).toBeNull()
  })
})
