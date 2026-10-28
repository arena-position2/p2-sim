import { SIM_PAGE_CONTENT_TYPE } from '@/lib/workspace-files/page-compile'

/**
 * Existing HTML at or above this size cannot use `workspace_file` operation=update
 * (full replace). Surgical `patch` remains allowed.
 */
export const HTML_FULL_UPDATE_MAX_EXISTING_BYTES = 40 * 1024

/**
 * Existing HTML at or above this size is treated as Arena/Figma-scale in messages
 * (still the same hard reject as the 40KB gate for full update).
 */
export const HTML_LARGE_EXISTING_BYTES = 200 * 1024

/**
 * `create_file` HTML bodies above this are rejected — lean shells and modular
 * pages stay under; megabyte dumps belong in patch or a redesign, not one shot.
 */
export const HTML_CREATE_CONTENT_MAX_BYTES = 100 * 1024

export type HtmlFullUpdateReject = {
  errorType: 'html_full_update_too_large'
  recoverable: true
  message: string
}

/**
 * True when the workspace file is HTML (extension, Sim page type, or text/html).
 */
export function isHtmlWorkspaceTarget(fileName: string, contentType?: string | null): boolean {
  const leaf =
    fileName
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/content$/i, '')
      .split('/')
      .pop()
      ?.toLowerCase() ?? ''
  if (leaf.endsWith('.html') || leaf.endsWith('.htm')) return true
  if (contentType === SIM_PAGE_CONTENT_TYPE) return true
  if (typeof contentType === 'string' && /text\/html/i.test(contentType)) return true
  return false
}

/**
 * UTF-8 byte length of a string (matches on-disk HTML size for ASCII-heavy pages).
 */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Rejects full-file HTML updates when the live file is too large to safely rewrite.
 */
export function rejectHtmlFullUpdate(params: {
  fileName: string
  existingContent: string
  contentType?: string | null
}): HtmlFullUpdateReject | null {
  if (!isHtmlWorkspaceTarget(params.fileName, params.contentType)) return null
  const size = utf8ByteLength(params.existingContent)
  if (size < HTML_FULL_UPDATE_MAX_EXISTING_BYTES) return null

  const sizeLabel =
    size >= HTML_LARGE_EXISTING_BYTES
      ? `${Math.round(size / 1024)}KB (Arena/Figma-scale)`
      : `${Math.round(size / 1024)}KB`

  return {
    errorType: 'html_full_update_too_large',
    recoverable: true,
    message:
      `Full update blocked for "${params.fileName}" — file is ${sizeLabel} (limit ${HTML_FULL_UPDATE_MAX_EXISTING_BYTES / 1024}KB for operation=update). ` +
      'Call grep (or read with a tight offset/limit) for the exact region, then workspace_file operation=patch with search_replace and a short unique live substring, then edit_content with only the replacement. ' +
      'Do not create_file a full rewrite of this page. For a visual redesign, create_file a lean new shell (semantic HTML + small CSS) and leave the large file unchanged.',
  }
}

/**
 * Rejects oversized HTML bodies on create_file (new page or overwrite).
 */
export function rejectHtmlCreateContent(params: {
  fileName: string
  content: string
  contentType?: string | null
}): { message: string; errorType: 'html_create_too_large' } | null {
  if (!params.content) return null
  if (!isHtmlWorkspaceTarget(params.fileName, params.contentType)) return null
  const size = utf8ByteLength(params.content)
  if (size <= HTML_CREATE_CONTENT_MAX_BYTES) return null

  return {
    errorType: 'html_create_too_large',
    message:
      `create_file HTML body is too large (${Math.round(size / 1024)}KB, max ${HTML_CREATE_CONTENT_MAX_BYTES / 1024}KB) for "${params.fileName}". ` +
      'Write a lean shell (semantic HTML + small CSS, CDN icons) or split CSS/JS into sibling files. ' +
      'To change an existing large page, materialize/read it and use workspace_file operation=patch — never dump multi-hundred-KB SVG/CSS into create_file.',
  }
}
