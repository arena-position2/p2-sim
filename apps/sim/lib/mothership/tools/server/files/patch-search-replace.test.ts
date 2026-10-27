/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  searchLooksTruncated,
  validateSearchReplaceForPatch,
} from '@/lib/mothership/tools/server/files/patch-search-replace'

describe('searchLooksTruncated', () => {
  it('detects Local Copilot line-clamp markers', () => {
    expect(
      searchLooksTruncated(
        '<svg>…[line truncated — mega inline SVG/CSS/base64; use grep + workspace_file patch, never full-rewrite]'
      )
    ).toBe(true)
  })

  it('detects body truncation markers', () => {
    expect(
      searchLooksTruncated(
        'footer…[truncated for Local Copilot budget — retry read with offset/limit, or grep then workspace_file patch. Do not regenerate the whole file.]'
      )
    ).toBe(true)
  })

  it('allows normal HTML substrings', () => {
    expect(searchLooksTruncated('<title>Care Plan</title>')).toBe(false)
  })
})

describe('validateSearchReplaceForPatch', () => {
  const fileName = 'dashboard.html'
  const existingContent = '<html><title>Care Plan</title><h1>Dashboard</h1></html>'

  it('accepts a unique live match', () => {
    expect(
      validateSearchReplaceForPatch({
        search: '<title>Care Plan</title>',
        existingContent,
        fileName,
      })
    ).toEqual({ ok: true })
  })

  it('rejects empty search', () => {
    const result = validateSearchReplaceForPatch({
      search: '',
      existingContent,
      fileName,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorType).toBe('search_not_found')
    }
  })

  it('rejects truncated search before scanning the file', () => {
    const result = validateSearchReplaceForPatch({
      search: 'path …[line truncated — mega inline SVG/CSS/base64',
      existingContent,
      fileName,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorType).toBe('search_looks_truncated')
      expect(result.message).toMatch(/truncated read/i)
    }
  })

  it('rejects search that is not in the file', () => {
    const result = validateSearchReplaceForPatch({
      search: '<title>Stale Title</title>',
      existingContent,
      fileName,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorType).toBe('search_not_found')
      expect(result.message).toContain('Stale Title')
    }
  })

  it('rejects ambiguous search unless replaceAll', () => {
    const content = 'old old'
    const ambiguous = validateSearchReplaceForPatch({
      search: 'old',
      existingContent: content,
      fileName,
    })
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) {
      expect(ambiguous.errorType).toBe('search_ambiguous')
    }

    expect(
      validateSearchReplaceForPatch({
        search: 'old',
        existingContent: content,
        replaceAll: true,
        fileName,
      })
    ).toEqual({ ok: true })
  })
})
