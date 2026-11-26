/**
 * Turn-scoped job isolation. Preferred HTML from prior turns must not invent a
 * second job (A5: summarize PDF then re-patch Team To-Do). Enforcement is
 * tool suppress + executor reject — prompts alone are not enough.
 */

import type { ActiveEditTargetReason } from '@/local-copilot/lib/context/active-documents'
import type { ToolExecutionResult } from '@/local-copilot/lib/tools/executor'
import { isCreateFromImageJob } from '@/local-copilot/lib/writes/create-from-image-intent'
import {
  hasHtmlEditContext,
  looksLikeHtmlAnalysisOnly,
  looksLikeHtmlEditIntent,
} from '@/local-copilot/lib/writes/html-edit-intent'

export type LocalCopilotTurnJob = 'summarize_upload' | 'create_from_image' | 'html_edit' | 'general'

/** Read / summarize / overview of an uploaded document — not an HTML edit. */
const SUMMARIZE_UPLOAD_SIGNAL =
  /\b(summaris[ee]|summarize|summary|tl;?dr|tldr|overview|executive summary|key (points|takeaways)|what('?s| is) in|explain (this|the)\b[\s\S]{0,40}\b(pdf|document|doc|upload|file)|read (this|the)\b[\s\S]{0,40}\b(pdf|document|doc))\b/i

const DOCUMENT_OR_UPLOAD_MENTION =
  /\b(\.pdf\b|pdf\b|docx?\b|pptx?\b|the (pdf|document|doc|upload|attachment)|this (pdf|document|doc|upload|attachment)|uploaded (pdf|document|doc|file))\b/i

const DOCUMENT_UPLOAD_EXTENSION = /\.(pdf|docx?|pptx?|txt|md|rtf|csv)$/i

const HTML_PATH = /\.html?(?:\/content)?$/i

/**
 * Mutations / HTML side-quests that must not run on summarize_upload turns.
 * `read`/`grep` stay available for the upload; executor rejects HTML paths.
 */
export const SUMMARIZE_UPLOAD_SUPPRESSED_TOOLS = new Set([
  'workspace_file',
  'edit_content',
  'create_file',
  'function_execute',
  'manage_sandbox',
  'list_file_folders',
  'create_file_folder',
  'rename_file_folder',
  'move_file_folder',
  'delete_file_folder',
])

export interface ResolveTurnJobInput {
  userMessage: string
  resolveReason: ActiveEditTargetReason
  preferredPath?: string | null
  candidatePaths?: readonly string[]
  currentTurnUploadPaths?: readonly string[]
}

/**
 * True when this turn's uploads (or message) focus a non-image document.
 */
export function hasDocumentUploadFocus(options: {
  userMessage: string
  currentTurnUploadPaths?: readonly string[]
}): boolean {
  const uploads = options.currentTurnUploadPaths ?? []
  if (uploads.some((path) => DOCUMENT_UPLOAD_EXTENSION.test(path))) return true
  return DOCUMENT_OR_UPLOAD_MENTION.test(options.userMessage)
}

/**
 * True when the user is asking to summarize/read a document upload.
 */
export function looksLikeSummarizeUploadIntent(message: string): boolean {
  return SUMMARIZE_UPLOAD_SIGNAL.test(message.trim())
}

/**
 * Dual ask: summarize upload AND edit HTML/page in the same message.
 */
export function looksLikeSummarizeAndHtmlEditDualIntent(options: {
  userMessage: string
  preferredPath?: string | null
  candidatePaths?: readonly string[]
}): boolean {
  if (!looksLikeSummarizeUploadIntent(options.userMessage)) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  return hasHtmlEditContext({
    userMessage: options.userMessage,
    preferredPath: options.preferredPath,
    candidatePaths: options.candidatePaths,
  })
}

/**
 * Picks the primary job for this user turn.
 */
export function resolveTurnJob(input: ResolveTurnJobInput): LocalCopilotTurnJob {
  if (
    isCreateFromImageJob({
      resolveReason: input.resolveReason,
      userMessage: input.userMessage,
    })
  ) {
    return 'create_from_image'
  }

  const summarize = looksLikeSummarizeUploadIntent(input.userMessage)
  const docFocus = hasDocumentUploadFocus({
    userMessage: input.userMessage,
    currentTurnUploadPaths: input.currentTurnUploadPaths,
  })
  const dual = looksLikeSummarizeAndHtmlEditDualIntent({
    userMessage: input.userMessage,
    preferredPath: input.preferredPath,
    candidatePaths: input.candidatePaths,
  })

  if (summarize && docFocus && !dual) {
    return 'summarize_upload'
  }

  // Summarize + HTML edit in one message: allow both tool families (no hard fence).
  if (dual) {
    return 'general'
  }

  if (
    looksLikeHtmlEditIntent(input.userMessage) &&
    !looksLikeHtmlAnalysisOnly(input.userMessage) &&
    hasHtmlEditContext({
      userMessage: input.userMessage,
      preferredPath: input.preferredPath,
      candidatePaths: input.candidatePaths,
    })
  ) {
    return 'html_edit'
  }

  return 'general'
}

/**
 * System fence so preferred HTML does not become a second job.
 */
export function buildSummarizeUploadJobSystemMessage(options?: {
  uploadPaths?: readonly string[]
}): string {
  const uploads = (options?.uploadPaths ?? []).filter((path) =>
    DOCUMENT_UPLOAD_EXTENSION.test(path)
  )
  const focus =
    uploads.length > 0
      ? uploads.map((path) => `\`${path}\``).join(', ')
      : 'the uploaded document (PDF/DOC/etc.)'
  return (
    `[System] Summarize/read-upload job: this turn's only job is to read and summarize ${focus}. ` +
    'Do NOT grep, read, patch, or open preferred HTML from earlier turns ' +
    '(e.g. files/**/*.html). Do NOT call workspace_file, edit_content, or create_file. ' +
    'preferredPath is for vague *edit* follow-ups only — ignore it for mutation this turn. ' +
    'Reply with the summary; do not re-verify prior UI edits.'
  )
}

/**
 * Strips mutation / sandbox tools on summarize_upload. Never empty list.
 */
export function filterSummarizeUploadForcedTools<T extends { name: string }>(
  tools: T[],
  active: boolean
): T[] {
  if (!active) return tools
  const filtered = tools.filter((tool) => !SUMMARIZE_UPLOAD_SUPPRESSED_TOOLS.has(tool.name))
  return filtered.length > 0 ? filtered : tools
}

function extractToolPath(args: Record<string, unknown>): string {
  if (typeof args.path === 'string' && args.path.trim()) return args.path.trim()
  const target = args.target
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const path = (target as { path?: unknown }).path
    if (typeof path === 'string' && path.trim()) return path.trim()
  }
  const resources = args.resources
  if (Array.isArray(resources) && resources[0] && typeof resources[0] === 'object') {
    const first = resources[0] as { path?: unknown; type?: unknown }
    if (first.type === 'file' && typeof first.path === 'string') return first.path.trim()
  }
  return ''
}

function isHtmlWorkspacePath(path: string): boolean {
  const normalized = path.replace(/%20/g, ' ').split('?')[0] ?? path
  return HTML_PATH.test(normalized) || /(?:^|\/)files\/.+\.html?(?:\/|$)/i.test(normalized)
}

export const SUMMARIZE_UPLOAD_OUT_OF_SCOPE_ERROR =
  'Out of scope for this turn: the user asked to summarize/read an uploaded document. Do not inspect or mutate preferred HTML. Call read on the upload path (uploads/…) and reply with the summary only.'

/**
 * Hard reject mutations / HTML side-quests when turnJob is summarize_upload.
 */
export function rejectOutOfJobToolCall(options: {
  turnJob: LocalCopilotTurnJob | undefined
  toolName: string
  args: Record<string, unknown>
}): ToolExecutionResult | null {
  if (options.turnJob !== 'summarize_upload') return null

  const { toolName, args } = options
  if (
    toolName === 'workspace_file' ||
    toolName === 'edit_content' ||
    toolName === 'create_file' ||
    toolName === 'function_execute' ||
    toolName === 'manage_sandbox'
  ) {
    return {
      toolName,
      success: false,
      error: SUMMARIZE_UPLOAD_OUT_OF_SCOPE_ERROR,
      result: {
        success: false,
        message: SUMMARIZE_UPLOAD_OUT_OF_SCOPE_ERROR,
        followUpHint: 'Read uploads/<document> and summarize. Do not patch HTML.',
      },
    }
  }

  if (toolName === 'read' || toolName === 'grep' || toolName === 'open_resource') {
    const path = extractToolPath(args)
    if (path && isHtmlWorkspacePath(path)) {
      return {
        toolName,
        success: false,
        error: SUMMARIZE_UPLOAD_OUT_OF_SCOPE_ERROR,
        result: {
          success: false,
          message: SUMMARIZE_UPLOAD_OUT_OF_SCOPE_ERROR,
          followUpHint: 'Use the uploaded document path under uploads/, not files/**/*.html.',
        },
      }
    }
  }

  return null
}
