/**
 * Create-from-image job: screenshot/image reference + build/create ask with no
 * named HTML target. Distinct from HTML *edit* follow-ups — explore/patch caps
 * must not fire; the model should create_file from the image.
 */

import type { ActiveEditTargetReason } from '@/local-copilot/lib/context/active-documents'

/** Create / build / clone from a visual — not "fix existing using screenshot". */
const CREATE_FROM_IMAGE_SIGNAL =
  /\b(build|create|generate|make|design|recreate|clone|convert|turn into|scaffold)\b/i

const FROM_IMAGE_SIGNAL =
  /\b(from|based on|like|matching)\s+(this\s+)?(screenshot|image|png|photo|mockup|design|ui)\b|\b(screenshot|mockup|uploaded image)\b/i

/** Explicit HTML path / filename in the user ask — not an image-only create job. */
const NAMED_HTML_TARGET =
  /\b[\w./-]+\.html?\b|\bfiles\/[^\s"'<>]+\.html?\b|\buploads\/[^\s"'<>]+\.html?\b/i

/**
 * Explore / sandbox tools that thrash on create-from-image (A1). Lifted after
 * a successful create_file so open_resource / post-create read can run.
 */
export const CREATE_FROM_IMAGE_SUPPRESSED_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'load_copilot_artifact',
  'list_file_folders',
  'create_file_folder',
  'rename_file_folder',
  'move_file_folder',
  'delete_file_folder',
  'function_execute',
  'manage_sandbox',
])

/**
 * True when this turn should create a new file from an image, not edit existing HTML.
 */
export function isCreateFromImageJob(options: {
  resolveReason: ActiveEditTargetReason
  userMessage: string
}): boolean {
  if (options.resolveReason !== 'image_reference') return false
  const text = options.userMessage.trim()
  if (!text) return false
  if (NAMED_HTML_TARGET.test(text)) return false
  return CREATE_FROM_IMAGE_SIGNAL.test(text) || FROM_IMAGE_SIGNAL.test(text)
}

/**
 * System block: do not explore unrelated workspace HTML; create_file from the image.
 */
export function buildCreateFromImageJobSystemMessage(): string {
  return (
    '[System] Create-from-image job: the uploaded image is a visual reference only ' +
    '(resolveReason image_reference). Call create_file once with the full lean HTML body ' +
    'inspired by the screenshot. Do NOT read/grep/list existing files/**/*.html, do NOT ' +
    'use function_execute / manage_sandbox, and do NOT patch an older preferred file. ' +
    'After create_file succeeds you may open_resource on the new path.'
  )
}

/**
 * Forced continuation when the model explores or narrates without creating.
 */
export function buildCreateFromImageContinuationMessage(): string {
  return (
    '[System] Create-from-image: you have not created the file yet. Call create_file now ' +
    'with fileName under files/ (e.g. files/Apps/…) and the full HTML content from the ' +
    'screenshot. Do not inspect unrelated workspace HTML or use the sandbox.'
  )
}

/**
 * Soft force: create-from-image turn with no successful create_file yet.
 */
export function shouldForceCreateFromImageContinuation(options: {
  postBuildToolMode: string
  isCreateFromImageJob: boolean
  forcedCreateFromImageContinuations: number
  maxForcedCreateFromImageContinuations: number
  round: number
  maxToolRounds: number
  hasSuccessfulCreateFile: boolean
}): boolean {
  if (!options.isCreateFromImageJob) return false
  if (options.postBuildToolMode !== 'all') return false
  if (options.hasSuccessfulCreateFile) return false
  if (options.forcedCreateFromImageContinuations >= options.maxForcedCreateFromImageContinuations) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false
  return true
}

/**
 * Strips explore/sandbox tools until create_file succeeds. Never empty list.
 */
export function filterCreateFromImageForcedTools<T extends { name: string }>(
  tools: T[],
  active: boolean
): T[] {
  if (!active) return tools
  const filtered = tools.filter((tool) => !CREATE_FROM_IMAGE_SUPPRESSED_TOOLS.has(tool.name))
  return filtered.length > 0 ? filtered : tools
}

/**
 * True when the turn already created a workspace file successfully.
 */
export function turnHasSuccessfulCreateFile(
  records: ReadonlyArray<{ name: string; success: boolean }>
): boolean {
  return records.some((record) => record.name === 'create_file' && record.success)
}
