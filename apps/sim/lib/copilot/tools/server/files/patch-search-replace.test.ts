/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PATCH_SEARCH_CHARS,
  searchLooksTruncated,
  validateSearchReplaceForPatch,
} from '@/lib/copilot/tools/server/files/patch-search-replace'

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
    ).toEqual({ ok: true, search: '<title>Care Plan</title>' })
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

  it('rejects search longer than MAX_PATCH_SEARCH_CHARS before scanning the file', () => {
    const search = `<button id="generateBtn">${'x'.repeat(MAX_PATCH_SEARCH_CHARS)}</button>`
    const result = validateSearchReplaceForPatch({
      search,
      existingContent: `${search}<p>other</p>`,
      fileName,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorType).toBe('search_too_long')
      expect(result.message).toMatch(/too long/i)
      expect(result.message).toContain(String(MAX_PATCH_SEARCH_CHARS))
      expect(result.excerpt).toBeTruthy()
    }
  })

  it('accepts a unique search at the max length', () => {
    const needle = 'a'.repeat(MAX_PATCH_SEARCH_CHARS)
    expect(
      validateSearchReplaceForPatch({
        search: needle,
        existingContent: `prefix ${needle} suffix`,
        fileName,
      })
    ).toEqual({ ok: true, search: needle })
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
      expect(result.excerpt).toMatch(/None of these tokens occur/i)
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
    ).toEqual({ ok: true, search: 'old' })
  })

  it('matches a unique unescaped search and stores the file bytes', () => {
    const result = validateSearchReplaceForPatch({
      search: '<button id=\\"generateBtn\\">Generate</button>',
      existingContent: '<button id="generateBtn">Generate</button>',
      fileName,
    })
    expect(result).toEqual({
      ok: true,
      search: '<button id="generateBtn">Generate</button>',
    })
  })

  it('keeps a raw search that already matches backslash quotes', () => {
    const raw = 'say \\"hi\\"'
    const result = validateSearchReplaceForPatch({
      search: raw,
      existingContent: `before ${raw} after`,
      fileName,
    })
    expect(result).toEqual({ ok: true, search: raw })
  })

  it('returns live lines when a search token occurs in the file', () => {
    const result = validateSearchReplaceForPatch({
      search: '<div class="drop" id="dropzone"><h4>Brand Logo</h4></div>',
      existingContent: '<div class="drop-zone" id="generateBtn">Generate</div>\n<p>Other</p>',
      fileName,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorType).toBe('search_not_found')
      expect(result.excerpt).toContain('1: <div class="drop-zone" id="generateBtn">Generate</div>')
      expect(result.excerpt).not.toContain('<p>Other</p>')
      expect(result.message).toContain(result.excerpt)
    }
  })
})
