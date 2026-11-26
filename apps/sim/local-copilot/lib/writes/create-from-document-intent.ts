/**
 * Create-from-document job: uploaded brief (docx/pdf/…) + create/prototype ask.
 * Distinct from HTML *edit* and summarize — extract may use the sandbox once,
 * then create_file; mid-stream interrupt strips explore so paging cannot resume.
 */

import { turnHasSuccessfulCreateFile } from '@/local-copilot/lib/writes/create-from-image-intent'

/** Create / prototype / mock-up a page or layout from a brief. */
const CREATE_FROM_DOCUMENT_SIGNAL =
  /\b(create|build|generate|design|prototype|mock-?up|mockup)\b[\s\S]{0,120}\b(page|html|webpage|web\s*page|layout|prototype|visual|ui|site|mock-?up|design)\b|\b(visual design prototype|html prototype|design prototype|webpage prototype)\b/i

/**
 * Tools stripped once mid-stream create force activates. Keep create_file +
 * materialize_file. Drop explore *and* further sandbox so extract→create sticks.
 */
export const CREATE_FROM_DOCUMENT_SUPPRESSED_TOOLS = new Set([
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
 * True when the user is asking to create/prototype a page from a document brief.
 */
export function looksLikeCreateFromDocumentIntent(message: string): boolean {
  const text = message.trim()
  if (!text) return false
  return CREATE_FROM_DOCUMENT_SIGNAL.test(text)
}

/**
 * System block: extract the brief briefly, then create_file — do not edit the docx.
 */
export function buildCreateFromDocumentJobSystemMessage(): string {
  return (
    '[System] Create-from-document job: the uploaded document is a *source brief*, not the ' +
    'file to edit. Materialize it if needed, optionally extract once via function_execute ' +
    '(zipfile / python-docx → JSON/text — not an office rebuild), then call create_file once ' +
    'with the HTML/visual prototype. Do NOT keep paging brief_extract.json or the docx with ' +
    'read offset/limit. Do NOT patch the preferred .docx/.pdf. After create_file succeeds you ' +
    'may open_resource on the new path.'
  )
}

/**
 * Forced continuation when the model extracts/reads without creating.
 */
export function buildCreateFromDocumentContinuationMessage(): string {
  return (
    '[System] Create-from-document: you have enough of the brief. Call create_file NOW with ' +
    'fileName under files/ (e.g. files/Apps/…html) and the prototype HTML body. Do not read ' +
    'or grep the extract JSON again this turn. Do not call function_execute again — ' +
    'read/grep/load_copilot_artifact/function_execute are unavailable this round.'
  )
}

/**
 * Soft force: create-from-document turn with no successful create_file yet
 * (text-only settle path — backup for mid-stream interrupt).
 */
export function shouldForceCreateFromDocumentContinuation(options: {
  postBuildToolMode: string
  isCreateFromDocumentJob: boolean
  forcedCreateFromDocumentContinuations: number
  maxForcedCreateFromDocumentContinuations: number
  round: number
  maxToolRounds: number
  hasSuccessfulCreateFile: boolean
}): boolean {
  if (!options.isCreateFromDocumentJob) return false
  if (options.postBuildToolMode !== 'all') return false
  if (options.hasSuccessfulCreateFile) return false
  if (
    options.forcedCreateFromDocumentContinuations >=
    options.maxForcedCreateFromDocumentContinuations
  ) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false
  return true
}

/**
 * Mid-stream (between tool rounds): activate explore/sandbox suppress without
 * waiting for a text-only settle. Mirrors HTML-edit Slice B for create jobs.
 * Triggers after a successful function_execute extract **or** enough inspects.
 */
export function shouldActivateCreateFromDocumentMidStreamSuppress(options: {
  turnJob: string
  alreadyActive: boolean
  inspectionCount: number
  inspectionsBeforeCreateNudge: number
  hasSuccessfulFunctionExecute: boolean
  hasSuccessfulCreateFile: boolean
  forcedCreateFromDocumentContinuations: number
  maxForcedCreateFromDocumentContinuations: number
}): boolean {
  if (options.turnJob !== 'create_from_document') return false
  if (options.hasSuccessfulCreateFile) return false
  if (options.alreadyActive) return true
  if (
    options.forcedCreateFromDocumentContinuations >=
    options.maxForcedCreateFromDocumentContinuations
  ) {
    return false
  }
  if (options.hasSuccessfulFunctionExecute) return true
  if (options.inspectionCount >= options.inspectionsBeforeCreateNudge) return true
  return false
}

/**
 * True when this turn already ran a successful function_execute (brief extract).
 */
export function turnHasSuccessfulFunctionExecute(
  records: ReadonlyArray<{ name: string; success: boolean }>
): boolean {
  return records.some((record) => record.name === 'function_execute' && record.success)
}

/**
 * After mid-stream create force, strip explore/sandbox so paging cannot resume.
 * Never empty list.
 */
export function filterCreateFromDocumentForcedTools<T extends { name: string }>(
  tools: T[],
  active: boolean
): T[] {
  if (!active) return tools
  const filtered = tools.filter((tool) => !CREATE_FROM_DOCUMENT_SUPPRESSED_TOOLS.has(tool.name))
  return filtered.length > 0 ? filtered : tools
}

export { turnHasSuccessfulCreateFile }
