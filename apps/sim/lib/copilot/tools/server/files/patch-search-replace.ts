import { truncate } from '@sim/utils/string'

/** Structured patch prepare failures the agent can recover from without aborting the turn. */
export type SearchReplacePatchErrorType =
  | 'search_looks_truncated'
  | 'search_not_found'
  | 'search_ambiguous'

export type SearchReplacePatchValidation =
  | { ok: true; search: string }
  | {
      ok: false
      errorType: SearchReplacePatchErrorType
      message: string
      /** Short live-file slice so the next search is copied from the file. */
      excerpt?: string
    }

/**
 * Markers injected by Local Copilot read clamping. A search string that still
 * contains these was copied from a truncated view and will never match the file.
 */
const TRUNCATION_MARKERS = [
  '…[line truncated',
  '...[line truncated',
  '…[truncated for Local Copilot',
  '...[truncated for Local Copilot',
  'mega inline SVG/CSS/base64',
] as const

const EXCERPT_MAX_LINES = 12
const EXCERPT_LINE_MAX_CHARS = 200
const EXCERPT_MAX_CHARS = 1500
const EXCERPT_MAX_TOKENS = 8
const EXCERPT_TOKEN_MAX_CHARS = 80

/**
 * True when `search` looks copied from a clamped read rather than live file bytes.
 */
export function searchLooksTruncated(search: string): boolean {
  return TRUNCATION_MARKERS.some((marker) => search.includes(marker))
}

/**
 * Turns JSON-escaped quotes (`\"`) into the quote characters stored in the file.
 * One replacement only — a script that really contains a backslash keeps it when
 * the raw search already matches.
 */
export function unescapePatchSearchQuotes(search: string): string {
  return search.replace(/\\"/g, '"')
}

/**
 * Identity used only to detect a repeated failed search. Whitespace and `\"`
 * collapse so the same block with different indentation counts once.
 * The file match itself stays an exact `indexOf`.
 */
export function normalizePatchSearchForRetry(search: string): string {
  return unescapePatchSearchQuotes(search).replace(/\s+/g, ' ').trim()
}

/**
 * Pulls id, class, quoted text, and text nodes out of a missed search.
 */
function extractPatchSearchTokens(search: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    if (tokens.length >= EXCERPT_MAX_TOKENS) return
    const token = raw.replace(/\s+/g, ' ').trim()
    if (token.length < 4 || token.length > EXCERPT_TOKEN_MAX_CHARS) return
    if (token.includes('<') || token.includes('>')) return
    const key = token.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    tokens.push(token)
  }

  for (const match of search.matchAll(/\b(?:id|class|className)\s*=\s*["']([^"']+)["']/gi)) {
    for (const part of match[1].split(/\s+/)) add(part)
  }
  for (const match of search.matchAll(/["']([^"']{4,})["']/g)) add(match[1])
  for (const match of search.matchAll(/>([^<]{8,})</g)) add(match[1])
  return tokens
}

/**
 * Up to 12 source lines that contain a token from the missed search.
 * When nothing hits, names the tokens and does not dump the file.
 */
export function buildPatchSearchMissExcerpt(search: string, existingContent: string): string {
  const tokens = extractPatchSearchTokens(unescapePatchSearchQuotes(search))
  if (tokens.length === 0) {
    return 'No id, class, or text tokens could be taken from the search. Call read with offset and limit, or grep, and copy a short unique live substring.'
  }

  const lines = existingContent.split('\n')
  const hits: string[] = []
  for (let index = 0; index < lines.length && hits.length < EXCERPT_MAX_LINES; index++) {
    const line = lines[index] ?? ''
    if (!tokens.some((token) => line.includes(token))) continue
    const clipped =
      line.length > EXCERPT_LINE_MAX_CHARS ? `${line.slice(0, EXCERPT_LINE_MAX_CHARS)}…` : line
    hits.push(`${index + 1}: ${clipped}`)
  }

  const tokenList = tokens.join(', ')
  if (hits.length === 0) {
    return `None of these tokens occur in the file: ${tokenList}`
  }

  let body = `Live lines containing ${tokenList}:\n${hits.join('\n')}`
  if (body.length > EXCERPT_MAX_CHARS) {
    body = `${body.slice(0, EXCERPT_MAX_CHARS)}…`
  }
  return body
}

type SearchHit = 'missing' | 'ambiguous' | 'unique'

function classifySearch(content: string, search: string, replaceAll?: boolean): SearchHit {
  const firstIdx = content.indexOf(search)
  if (firstIdx === -1) return 'missing'
  if (!replaceAll && content.indexOf(search, firstIdx + 1) !== -1) return 'ambiguous'
  return 'unique'
}

/**
 * Validates a search_replace patch against the current file body before storing intent.
 * Failures are recoverable — the caller should return success=false with structured fields.
 * On success, `search` is the string that matched the file (raw, or unescaped when the
 * raw form missed and the unescaped form is a unique match).
 */
export function validateSearchReplaceForPatch(params: {
  search: string
  existingContent: string
  replaceAll?: boolean
  fileName: string
}): SearchReplacePatchValidation {
  const search = params.search
  const fileName = params.fileName

  if (!search) {
    return {
      ok: false,
      errorType: 'search_not_found',
      message: `Patch failed: empty search string for "${fileName}". Re-read the live file and use a short unique substring.`,
    }
  }

  if (searchLooksTruncated(search)) {
    return {
      ok: false,
      errorType: 'search_looks_truncated',
      message: `Patch failed: search string looks copied from a truncated read of "${fileName}". Call read/grep on the live file and use a short unique substring that does not contain truncation markers.`,
    }
  }

  const rawHit = classifySearch(params.existingContent, search, params.replaceAll)
  if (rawHit === 'unique') return { ok: true, search }
  if (rawHit === 'ambiguous') {
    return {
      ok: false,
      errorType: 'search_ambiguous',
      message: `Patch failed: search string is ambiguous — found at multiple locations in "${fileName}". Use a longer unique search string or replaceAll.`,
    }
  }

  const unescaped = unescapePatchSearchQuotes(search)
  if (unescaped !== search) {
    const unescapedHit = classifySearch(params.existingContent, unescaped, params.replaceAll)
    if (unescapedHit === 'unique') return { ok: true, search: unescaped }
    if (unescapedHit === 'ambiguous') {
      return {
        ok: false,
        errorType: 'search_ambiguous',
        message: `Patch failed: search string is ambiguous — found at multiple locations in "${fileName}". Use a longer unique search string or replaceAll.`,
      }
    }
  }

  const excerpt = buildPatchSearchMissExcerpt(search, params.existingContent)
  return {
    ok: false,
    errorType: 'search_not_found',
    excerpt,
    message: `Patch failed: search string not found in file "${fileName}". Search: "${truncate(search, 100)}"\n${excerpt}`,
  }
}
