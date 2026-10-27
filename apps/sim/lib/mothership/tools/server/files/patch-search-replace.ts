import { truncate } from '@sim/utils/string'

/** Structured patch prepare failures the agent can recover from without aborting the turn. */
export type SearchReplacePatchErrorType =
  | 'search_looks_truncated'
  | 'search_not_found'
  | 'search_ambiguous'

export type SearchReplacePatchValidation =
  | { ok: true }
  | {
      ok: false
      errorType: SearchReplacePatchErrorType
      message: string
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

/**
 * True when `search` looks copied from a clamped read rather than live file bytes.
 */
export function searchLooksTruncated(search: string): boolean {
  return TRUNCATION_MARKERS.some((marker) => search.includes(marker))
}

/**
 * Validates a search_replace patch against the current file body before storing intent.
 * Failures are recoverable — the caller should return success=false with structured fields.
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

  const firstIdx = params.existingContent.indexOf(search)
  if (firstIdx === -1) {
    return {
      ok: false,
      errorType: 'search_not_found',
      message: `Patch failed: search string not found in file "${fileName}". Search: "${truncate(search, 100)}"`,
    }
  }

  if (!params.replaceAll && params.existingContent.indexOf(search, firstIdx + 1) !== -1) {
    return {
      ok: false,
      errorType: 'search_ambiguous',
      message: `Patch failed: search string is ambiguous — found at multiple locations in "${fileName}". Use a longer unique search string or replaceAll.`,
    }
  }

  return { ok: true }
}
