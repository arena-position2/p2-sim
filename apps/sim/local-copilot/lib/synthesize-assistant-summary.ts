import { truncate } from '@sim/utils/string'
import { buildOAuthConnectControl } from '@/local-copilot/lib/oauth-connect-text'
import { stripDeepSeekDsmlMarkup } from '@/local-copilot/lib/providers/deepseek-dsml'
import { extractCapturedOutput } from '@/local-copilot/lib/tools/format-tool-result'

const LEAKED_TOOL_MARKER_PATTERN = /\[Tool [^\]]+\]/g
const GENERIC_MESSAGE_MAX_CHARS = 4_000

export interface ToolTurnRecord {
  name: string
  success: boolean
  result: unknown
  /** Top-level tool error message when the call failed. */
  error?: string
}

const FAILURE_EVIDENCE_MAX_CHARS = 220

/**
 * Builds compact failure evidence lines for session memory / next-turn context.
 */
export function buildToolFailureEvidenceLines(records: ToolTurnRecord[]): string[] {
  return records
    .filter((record) => !record.success)
    .map((record) => {
      const detail = extractToolFailureDetail(record)
      return detail ? `${record.name}: ${detail}` : `${record.name} failed`
    })
}

function extractToolFailureDetail(record: ToolTurnRecord): string | null {
  if (typeof record.error === 'string' && record.error.trim()) {
    return truncate(record.error.trim(), FAILURE_EVIDENCE_MAX_CHARS, '…')
  }

  const payload = asRecord(record.result)
  for (const key of ['error', 'message', 'detail', 'reason'] as const) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.trim(), FAILURE_EVIDENCE_MAX_CHARS, '…')
    }
  }

  if (typeof payload.success === 'boolean' && payload.success === false) {
    const nested = payload.result
    if (typeof nested === 'string' && nested.trim()) {
      return truncate(nested.trim(), FAILURE_EVIDENCE_MAX_CHARS, '…')
    }
  }

  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const WORKFLOW_RUN_TOOL_NAMES = new Set([
  'run_workflow',
  'run_block',
  'run_from_block',
  'run_workflow_until_block',
])

/** Tools used to inspect failed runs — often leave the bubble empty without a forced reply. */
const DEBUG_INSPECTION_TOOL_NAMES = new Set(['query_logs', 'get_execution_logs', 'explain_error'])

/** Discovery-only tools that should be followed by create_workflow / edit_workflow. */
const WORKFLOW_DISCOVERY_TOOL_NAMES = new Set(['get_available_blocks', 'get_blocks_metadata'])

/**
 * File inspection tools. `load_copilot_artifact` belongs here (not workflow
 * discovery) — HTML reads are offloaded and reloaded via artifact, which must
 * not trigger a create_workflow nudge.
 */
const FILE_INSPECTION_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'load_copilot_artifact'])

const FILE_MUTATION_TOOL_NAMES = new Set([
  'create_file',
  'create_file_folder',
  'workspace_file',
  'edit_content',
  'delete_file',
  'rename_file',
  'move_file',
])

const RECOVERABLE_WORKSPACE_FILE_PATCH_ERROR_TYPES = new Set([
  'search_not_found',
  'search_ambiguous',
  'search_looks_truncated',
])

/**
 * True when workspace_file patch failed in a recoverable way (stale/truncated search).
 * Those messages must not be dumped into the user-facing chat bubble.
 */
function isRecoverableWorkspaceFilePatchFailure(record: ToolTurnRecord): boolean {
  if (record.name !== 'workspace_file') return false
  const payload = asRecord(record.result)
  if (payload.recoverable === true) return true
  const errorType = typeof payload.errorType === 'string' ? payload.errorType : ''
  return RECOVERABLE_WORKSPACE_FILE_PATCH_ERROR_TYPES.has(errorType)
}

const WORKFLOW_MUTATION_TOOL_NAMES = new Set(['create_workflow', 'edit_workflow'])

const RUN_OUTPUT_MAX_CHARS = 6_000
const DEBUG_SUMMARY_MAX_CHARS = 4_000

/**
 * True for tools that execute a workflow (or part of one) and produce run output.
 */
export function isWorkflowRunToolName(name: string): boolean {
  return WORKFLOW_RUN_TOOL_NAMES.has(name)
}

/**
 * True when this turn ran block-discovery tools (catalog / metadata).
 */
export function turnHasWorkflowDiscoveryTools(records: ToolTurnRecord[]): boolean {
  return records.some((record) => WORKFLOW_DISCOVERY_TOOL_NAMES.has(record.name))
}

/**
 * True when this turn successfully created or edited a workflow.
 */
export function turnHasWorkflowMutationTools(records: ToolTurnRecord[]): boolean {
  return records.some((record) => WORKFLOW_MUTATION_TOOL_NAMES.has(record.name) && record.success)
}

/**
 * True for the create_workflow populate instruction. After an edit was attempted
 * that hint is stale — the closer should report the edit failure instead.
 */
function isCreateWorkflowPopulateHint(hint: string): boolean {
  return /New workflow created/i.test(hint)
}

function firstRecordDetail(value: unknown, keys: string[]): string | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) return item.trim()
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    for (const key of keys) {
      const text = record[key]
      if (typeof text === 'string' && text.trim()) return text.trim()
    }
  }
  return null
}

/**
 * Plain-language reason the latest edit_workflow did not finish the graph.
 */
export function describeEditWorkflowFailure(record: ToolTurnRecord): string | null {
  const payload = asRecord(record.result)
  const validation = firstRecordDetail(payload.inputValidationErrors, ['error', 'message'])
  if (validation) return `An input was rejected: ${truncate(validation, 280, '…')}`

  const skipped = firstRecordDetail(payload.skippedItems, ['reason', 'message', 'error'])
  if (skipped) return `Some operations were skipped: ${truncate(skipped, 280, '…')}`

  const errorText =
    (typeof record.error === 'string' && record.error.trim()) ||
    (typeof payload.error === 'string' && payload.error.trim()) ||
    (typeof payload.message === 'string' && payload.message.trim()) ||
    ''
  if (payload.editPrecondition === 'metadata' || /get_blocks_metadata/i.test(errorText)) {
    return 'The edit was blocked until block metadata was loaded for the types being added.'
  }

  const lint =
    typeof payload.workflowLintMessage === 'string' ? payload.workflowLintMessage.trim() : ''
  if (lint) return `The workflow still has a configuration issue: ${truncate(lint, 280, '…')}`

  if (errorText && record.success === false) return truncate(errorText, 280, '…')

  const followUp = typeof payload.followUpHint === 'string' ? payload.followUpHint.trim() : ''
  if (followUp && !isCreateWorkflowPopulateHint(followUp)) return truncate(followUp, 280, '…')

  return null
}

/**
 * Closing prose when a workflow build turn would otherwise settle incomplete or blank.
 */
export function buildWorkflowBuildChatAppendix(
  records: ToolTurnRecord[],
  options?: {
    createdWorkflowThisTurn?: boolean
    successfulPopulateEdits?: number
    unresolvedFollowUpHint?: string | null
  }
): string | null {
  const createdWithoutPopulate =
    options?.createdWorkflowThisTurn === true && (options.successfulPopulateEdits ?? 0) === 0

  const hint = options?.unresolvedFollowUpHint?.trim() ?? ''
  const lastEdit = [...records].reverse().find((record) => record.name === 'edit_workflow')
  if (lastEdit && isCreateWorkflowPopulateHint(hint)) {
    const detail = describeEditWorkflowFailure(lastEdit)
    return detail
      ? `I created the workflow, but the last edit did not add the blocks. ${detail}`
      : 'I created the workflow, but the edits did not add the requested blocks. Continue so I can apply them.'
  }

  if (hint) {
    return `I made partial progress but still need to finish: ${hint}`
  }

  if (createdWithoutPopulate) {
    const fromTools = synthesizeAssistantSummaryFromTools(
      records.filter(
        (record) => record.name === 'create_workflow' || record.name === 'edit_workflow'
      )
    )
    if (fromTools) return fromTools
    return (
      'Created an empty workflow. The requested blocks still need to be added — ' +
      'continue so I can call edit_workflow to populate it.'
    )
  }

  if (turnHasWorkflowDiscoveryTools(records) && !turnHasWorkflowMutationTools(records)) {
    return (
      'I looked up available blocks but did not finish creating or editing the workflow. ' +
      'Please continue so I can call create_workflow / edit_workflow.'
    )
  }

  if (turnHasWorkflowMutationTools(records)) {
    return synthesizeAssistantSummaryFromTools(
      records.filter(
        (record) =>
          WORKFLOW_MUTATION_TOOL_NAMES.has(record.name) ||
          WORKFLOW_DISCOVERY_TOOL_NAMES.has(record.name)
      )
    )
  }

  return null
}

/**
 * True for log/debug tools that gather failure evidence but do not themselves
 * produce user-facing chat prose.
 */
export function isDebugInspectionToolName(name: string): boolean {
  return DEBUG_INSPECTION_TOOL_NAMES.has(name)
}

/**
 * True when this turn already ran debug tools — used to force a closing explanation.
 */
export function turnHasDebugInspectionTools(records: ToolTurnRecord[]): boolean {
  return records.some((record) => isDebugInspectionToolName(record.name) || record.name === 'run')
}

/**
 * True when this turn inspected workspace files (read/grep/artifact) without writing.
 */
export function turnHasFileInspectionTools(records: ToolTurnRecord[]): boolean {
  return records.some((record) => FILE_INSPECTION_TOOL_NAMES.has(record.name))
}

/**
 * True when this turn successfully mutated a workspace file.
 */
export function turnHasFileMutationTools(records: ToolTurnRecord[]): boolean {
  return records.some((record) => FILE_MUTATION_TOOL_NAMES.has(record.name) && record.success)
}

/**
 * Closing prose when file inspection finished without an edit or reply.
 */
export function buildFileInspectionChatAppendix(records: ToolTurnRecord[]): string | null {
  if (!turnHasFileInspectionTools(records) || turnHasFileMutationTools(records)) return null
  const inspected = records
    .filter((record) => FILE_INSPECTION_TOOL_NAMES.has(record.name))
    .map((record) => record.name.replace(/_/g, ' '))
  const unique = [...new Set(inspected)]
  if (unique.length === 0) return null
  return (
    `I inspected the file (${unique.join(', ')}) but did not finish applying the fix. ` +
    'Please try again — I should call workspace_file / edit_content with the corrected binding.'
  )
}

/**
 * Parses `[explain_error] {…}` dumps from specialist findings into chat prose.
 */
export function synthesizeExplainErrorFromSpecialistFindings(message: string): string | null {
  const match = message.match(/\[explain_error\]\s*(\{[\s\S]*?\})(?=\n\n|\n\[|$)/i)
  if (!match?.[1]) return null
  try {
    const parsed = JSON.parse(match[1]) as unknown
    return formatDebugInspectionChatResult({
      name: 'explain_error',
      success: true,
      result: parsed,
    })
  } catch {
    return null
  }
}

function stringifyRunValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => stringifyRunValue(item))
      .filter((item): item is string => Boolean(item))
    return parts.length > 0 ? parts.join('\n') : null
  }
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  for (const key of ['content', 'summary', 'text', 'message', 'result', 'stdout', 'response']) {
    const nested = record[key]
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
    if (nested && typeof nested === 'object') {
      const deeper = stringifyRunValue(nested)
      if (deeper) return deeper
    }
  }
  return null
}

function extractTextFromBlockOutput(output: unknown): string | null {
  return stringifyRunValue(output)
}

/**
 * Pulls the most useful user-facing text from a workflow execution payload.
 */
export function extractWorkflowRunOutputText(result: unknown): string | null {
  const payload = asRecord(result)
  const logs = Array.isArray(payload.logs) ? payload.logs : []

  let best: { order: number; blockName: string; text: string } | null = null
  for (const entry of logs) {
    const log = asRecord(entry)
    if (log.success === false) continue
    const blockType = typeof log.blockType === 'string' ? log.blockType : ''
    if (blockType === 'start_trigger' || blockType === 'starter') continue
    const text = extractTextFromBlockOutput(log.output)
    if (!text) continue
    const order = typeof log.executionOrder === 'number' ? log.executionOrder : 0
    const blockName =
      (typeof log.blockName === 'string' && log.blockName.trim()) ||
      (blockType ? blockType.replace(/_/g, ' ') : 'Block')
    if (!best || order >= best.order) {
      best = { order, blockName, text }
    }
  }

  if (best) {
    return `**${best.blockName}**\n${truncate(best.text, RUN_OUTPUT_MAX_CHARS)}`
  }

  const fromOutput = extractTextFromBlockOutput(payload.output)
  if (fromOutput) return truncate(fromOutput, RUN_OUTPUT_MAX_CHARS)

  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  return message ? truncate(message, RUN_OUTPUT_MAX_CHARS) : null
}

function workflowRunLabel(toolName: string): string {
  if (toolName === 'run_block') return 'Block run'
  if (toolName === 'run_from_block') return 'Run-from-block'
  return 'Workflow run'
}

/**
 * Builds chat-ready prose for a single workflow run tool record.
 */
export function formatWorkflowRunChatResult(record: ToolTurnRecord): string {
  const label = workflowRunLabel(record.name)
  const payload = asRecord(record.result)

  if (!record.success || payload.success === false) {
    const error =
      (typeof payload.error === 'string' && payload.error.trim()) ||
      (typeof payload.message === 'string' && payload.message.trim()) ||
      null
    return error ? `${label} failed: ${error}` : `${label} failed.`
  }

  const status =
    (typeof payload.status === 'string' && payload.status.trim()) ||
    (typeof payload.success === 'boolean'
      ? payload.success
        ? 'completed'
        : 'failed'
      : 'completed')
  const header = `${label} ${status}.`
  const body = extractWorkflowRunOutputText(record.result)
  return body ? `${header}\n\n${body}` : header
}

/**
 * Latest workflow-run tool result formatted for the chat window.
 */
export function buildWorkflowRunChatAppendix(records: ToolTurnRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (!record || !isWorkflowRunToolName(record.name)) continue
    return formatWorkflowRunChatResult(record)
  }
  return null
}

function formatExplainErrorChatResult(record: ToolTurnRecord): string {
  const payload = asRecord(record.result)
  const analysis = asRecord(payload.analysis)
  const errorMessage =
    (typeof payload.errorMessage === 'string' && payload.errorMessage.trim()) ||
    (typeof record.error === 'string' && record.error.trim()) ||
    ''
  const rootCause =
    (typeof analysis.rootCause === 'string' && analysis.rootCause.trim()) ||
    'Block execution failure'
  const failingBlock = asRecord(analysis.failingBlock)
  const blockLabel =
    (typeof failingBlock.name === 'string' && failingBlock.name.trim()) ||
    (typeof failingBlock.type === 'string' && failingBlock.type.trim()) ||
    (typeof failingBlock.id === 'string' && failingBlock.id.trim()) ||
    (typeof payload.blockId === 'string' && payload.blockId.trim()) ||
    null

  const lines: string[] = [`**Why it failed:** ${rootCause}`]
  if (blockLabel) {
    lines.push(
      typeof failingBlock.type === 'string' && failingBlock.type.trim() && failingBlock.name
        ? `**Failing block:** ${failingBlock.name} (${failingBlock.type})`
        : `**Failing block:** ${blockLabel}`
    )
  }
  if (errorMessage) {
    lines.push(`**Error:** ${truncate(errorMessage, 800)}`)
  }

  const fixes = Array.isArray(analysis.suggestedFixes)
    ? analysis.suggestedFixes.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0
      )
    : []
  if (fixes.length > 0) {
    lines.push('**Suggested fixes:**')
    for (const fix of fixes.slice(0, 4)) {
      lines.push(`- ${fix.trim()}`)
    }
  }

  return truncate(lines.join('\n'), DEBUG_SUMMARY_MAX_CHARS)
}

function pickFailedLogEntries(value: unknown): Array<Record<string, unknown>> {
  const payload = asRecord(value)
  const candidates: unknown[] = []
  if (Array.isArray(payload.data)) candidates.push(...payload.data)
  if (Array.isArray(payload.logs)) candidates.push(...payload.logs)
  if (Array.isArray(payload.executions)) candidates.push(...payload.executions)
  if (Array.isArray(payload.entries)) candidates.push(...payload.entries)
  if (Array.isArray(value)) candidates.push(...value)

  const failed: Array<Record<string, unknown>> = []
  for (const entry of candidates) {
    const row = asRecord(entry)
    const status = typeof row.status === 'string' ? row.status.toLowerCase() : ''
    const level = typeof row.level === 'string' ? row.level.toLowerCase() : ''
    const success = row.success
    if (
      status === 'error' ||
      status === 'failed' ||
      level === 'error' ||
      success === false ||
      (typeof row.error === 'string' && row.error.trim())
    ) {
      failed.push(row)
    }
  }
  return failed
}

function formatLogEntryLine(row: Record<string, unknown>): string {
  const name =
    (typeof row.workflowName === 'string' && row.workflowName.trim()) ||
    (typeof row.blockName === 'string' && row.blockName.trim()) ||
    (typeof row.executionId === 'string' && row.executionId.trim()) ||
    'Execution'
  const error =
    (typeof row.error === 'string' && row.error.trim()) ||
    (typeof row.message === 'string' && row.message.trim()) ||
    (typeof asRecord(row.executionError).message === 'string' &&
      String(asRecord(row.executionError).message).trim()) ||
    null
  const status =
    (typeof row.status === 'string' && row.status.trim()) ||
    (typeof row.level === 'string' && row.level.trim()) ||
    'failed'
  return error ? `- ${name}: ${status} — ${truncate(error, 240)}` : `- ${name}: ${status}`
}

function formatGetExecutionLogsChatResult(record: ToolTurnRecord): string {
  const failed = pickFailedLogEntries(record.result)
  if (failed.length === 0) {
    const payload = asRecord(record.result)
    const count = Array.isArray(payload.data) ? payload.data.length : 0
    return count > 0
      ? `Checked ${count} recent execution log${count === 1 ? '' : 's'} — none were marked failed.`
      : 'No execution logs were found for this workflow.'
  }

  const lines = [
    `Found ${failed.length} failed execution${failed.length === 1 ? '' : 's'}:`,
    ...failed.slice(0, 5).map(formatLogEntryLine),
  ]
  return truncate(lines.join('\n'), DEBUG_SUMMARY_MAX_CHARS)
}

function formatQueryLogsChatResult(record: ToolTurnRecord): string {
  const payload = asRecord(record.result)
  // Overview / full views often nest the failure on `error` or span summaries.
  const topError =
    (typeof payload.error === 'string' && payload.error.trim()) ||
    (typeof payload.message === 'string' && payload.message.trim()) ||
    null
  if (topError && !Array.isArray(payload.data)) {
    const status =
      (typeof payload.status === 'string' && payload.status.trim()) ||
      (payload.success === false ? 'failed' : null)
    return truncate(
      status ? `Log inspection (${status}): ${topError}` : `Log inspection: ${topError}`,
      DEBUG_SUMMARY_MAX_CHARS
    )
  }

  const failed = pickFailedLogEntries(record.result)
  if (failed.length > 0) {
    return truncate(
      [`From the logs:`, ...failed.slice(0, 5).map(formatLogEntryLine)].join('\n'),
      DEBUG_SUMMARY_MAX_CHARS
    )
  }

  if (typeof payload.summary === 'string' && payload.summary.trim()) {
    return truncate(payload.summary.trim(), DEBUG_SUMMARY_MAX_CHARS)
  }

  return 'Queried execution logs.'
}

/**
 * Formats a debug-inspection tool record into chat prose.
 */
export function formatDebugInspectionChatResult(record: ToolTurnRecord): string | null {
  if (!isDebugInspectionToolName(record.name)) return null
  if (!record.success) {
    const payload = asRecord(record.result)
    const error =
      (typeof record.error === 'string' && record.error.trim()) ||
      (typeof payload.error === 'string' && payload.error.trim()) ||
      (typeof payload.message === 'string' && payload.message.trim()) ||
      null
    return error
      ? `I couldn't inspect the logs: ${error}`
      : `I couldn't complete ${record.name.replace(/_/g, ' ')}.`
  }
  if (record.name === 'explain_error') return formatExplainErrorChatResult(record)
  if (record.name === 'get_execution_logs') return formatGetExecutionLogsChatResult(record)
  if (record.name === 'query_logs') return formatQueryLogsChatResult(record)
  return null
}

/**
 * Prefers the latest explain_error / log tool result when synthesizing a reply.
 */
export function buildDebugInspectionChatAppendix(records: ToolTurnRecord[]): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (!record || !isDebugInspectionToolName(record.name)) continue
    return formatDebugInspectionChatResult(record)
  }
  return null
}

/**
 * True when a run finished and the UI never got post-run assistant prose —
 * typical stuck state after "Let me run it." + Running workflow.
 */
export function shouldAppendWorkflowRunChatResult(options: {
  streamedUserFacingText: string
  streamedCharsAtLastRunTool: number | null
  toolRecords: ToolTurnRecord[]
}): boolean {
  if (options.streamedCharsAtLastRunTool === null) return false
  if (!buildWorkflowRunChatAppendix(options.toolRecords)) return false
  return options.streamedUserFacingText.length <= options.streamedCharsAtLastRunTool
}

/**
 * Removes legacy `[Tool name: state]` markers that must not appear in user-facing text.
 *
 * @param options.trim When `false`, preserves leading/trailing whitespace — required
 *   for streaming deltas where spaces live on chunk boundaries. Defaults to `true`.
 */
export function stripLeakedToolMarkers(text: string, options?: { trim?: boolean }): string {
  const stripped = stripDeepSeekDsmlMarkup(text)
    .replace(LEAKED_TOOL_MARKER_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
  return options?.trim === false ? stripped : stripped.trim()
}

/**
 * Builds a concise assistant reply when the model finishes tool use without prose.
 */
export function synthesizeAssistantSummaryFromTools(records: ToolTurnRecord[]): string | null {
  const parts: string[] = []

  for (const record of records) {
    if (!record.success) {
      const payload = asRecord(record.result)
      const error =
        (typeof payload.error === 'string' && payload.error) ||
        (typeof payload.message === 'string' && payload.message) ||
        null
      parts.push(
        error
          ? `I couldn't complete that step: ${error}`
          : `I couldn't complete ${record.name.replace(/_/g, ' ')}.`
      )
      continue
    }

    if (record.name === 'create_workflow') {
      const payload = asRecord(record.result)
      const name =
        (typeof payload.workflowName === 'string' && payload.workflowName.trim()) ||
        (typeof payload.name === 'string' && payload.name.trim()) ||
        null
      const populated = records.some((item) => item.name === 'edit_workflow' && item.success)
      if (!populated) {
        parts.push(
          name
            ? `Created "${name}" as an empty workflow. The requested blocks still need to be added.`
            : 'Created an empty workflow. The requested blocks still need to be added.'
        )
        continue
      }
      parts.push(
        name
          ? `Created the workflow "${name}" and opened it in the panel.`
          : 'Created a new workflow and opened it in the panel.'
      )
      continue
    }

    if (record.name === 'edit_workflow') {
      const payload = asRecord(record.result)
      const message = typeof payload.message === 'string' ? payload.message.trim() : ''
      if (!record.success) {
        parts.push(message || 'Could not update the workflow. Check the edit errors and retry.')
      } else if (payload.partialApply === true || payload.needsFollowUpEdit === true) {
        parts.push(
          message || 'Updated the workflow partially — some changes still need a follow-up edit.'
        )
      } else if (message) {
        parts.push(truncate(message, GENERIC_MESSAGE_MAX_CHARS))
      } else {
        parts.push('Updated the workflow with the requested blocks and connections.')
      }
      continue
    }

    if (record.name === 'oauth_get_auth_link') {
      const control = buildOAuthConnectControl(record.result)
      if (control) {
        parts.push(`Connect ${control.provider}, then continue.`)
      } else {
        const payload = asRecord(record.result)
        const message = typeof payload.message === 'string' ? payload.message.trim() : ''
        if (message) parts.push(message)
      }
      continue
    }

    if (record.name === 'generate_image') {
      const payload = asRecord(record.result)
      const message = typeof payload.message === 'string' ? payload.message.trim() : ''
      if (message) {
        parts.push(message)
        continue
      }

      const files = Array.isArray(payload.files) ? payload.files : []
      if (files.length > 1) {
        const paths = files
          .map((file) => asRecord(file).vfsPath ?? asRecord(file).fileName)
          .filter((path): path is string => typeof path === 'string' && path.length > 0)
        parts.push(
          paths.length
            ? `Generated ${files.length} images: ${paths.map((path) => `"${path}"`).join(', ')}.`
            : `Generated ${files.length} image variations.`
        )
        continue
      }

      const vfsPath =
        (typeof payload.vfsPath === 'string' && payload.vfsPath) ||
        (typeof payload.fileName === 'string' && payload.fileName) ||
        null
      if (vfsPath) {
        parts.push(`Image saved to "${vfsPath}".`)
      }
      continue
    }

    if (record.name === 'open_resource') {
      continue
    }

    if (record.name === 'search_online') {
      const payload = asRecord(record.result)
      const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
      if (summary) {
        parts.push(summary)
        continue
      }
      const results = Array.isArray(payload.results) ? payload.results : []
      const lines = results
        .slice(0, 5)
        .map((entry) => {
          const row = asRecord(entry)
          const title = typeof row.title === 'string' ? row.title.trim() : ''
          const snippet =
            (typeof row.snippet === 'string' && row.snippet.trim()) ||
            (typeof row.highlights === 'string' && row.highlights.trim()) ||
            (Array.isArray(row.highlights) &&
              row.highlights
                .filter((h): h is string => typeof h === 'string')
                .join(' ')
                .trim()) ||
            ''
          if (!title && !snippet) return null
          return snippet ? `${title}: ${snippet}` : title
        })
        .filter((line): line is string => Boolean(line))
      if (lines.length > 0) {
        parts.push(truncate(lines.join('\n'), GENERIC_MESSAGE_MAX_CHARS))
      }
      continue
    }

    if (isWorkflowRunToolName(record.name)) {
      parts.push(formatWorkflowRunChatResult(record))
      continue
    }

    if (isDebugInspectionToolName(record.name)) {
      // Prefer explain_error over earlier list/query tools so the bubble is one clear answer.
      if (record.name !== 'explain_error') {
        const hasExplain = records.some((other) => other.name === 'explain_error' && other.success)
        if (hasExplain) continue
      }
      if (record.name === 'query_logs') {
        const hasExecutionLogs = records.some(
          (other) => other.name === 'get_execution_logs' && other.success
        )
        if (hasExecutionLogs) continue
      }
      const debugSummary = formatDebugInspectionChatResult(record)
      if (debugSummary) parts.push(debugSummary)
      continue
    }

    if (record.name === 'function_execute' || record.name === 'invoke_integration_tool') {
      const captured = extractCapturedOutput(record.result)
      if (captured) {
        parts.push(truncate(captured, GENERIC_MESSAGE_MAX_CHARS))
      }
      continue
    }

    // Recoverable patch misses are for the agent loop — never echo "Patch failed…" to chat.
    if (isRecoverableWorkspaceFilePatchFailure(record)) {
      continue
    }

    // Specialist domains (`workflow`, `run`, …) and other tools often finish with
    // only a `message` / findings payload. Without this, mothership can settle with
    // zero renderable prose (specialist tool names are absorbed as empty groups).
    const payload = asRecord(record.result)
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (message) {
      // Prefer a short human summary over raw `[tool] {json…}` specialist dumps.
      const cleaned = summarizeSpecialistFindings(record.name, message)
      parts.push(truncate(cleaned, GENERIC_MESSAGE_MAX_CHARS))
      continue
    }

    if (isLikelySpecialistDomain(record.name)) {
      parts.push(`Finished the ${record.name.replace(/_/g, ' ')} steps for your request.`)
    }
  }

  if (
    parts.length === 0 &&
    turnHasWorkflowDiscoveryTools(records) &&
    !turnHasWorkflowMutationTools(records)
  ) {
    return (
      'I looked up the available blocks, but did not finish creating the workflow. ' +
      'Please try again (or switch models if Vertex quota is exhausted).'
    )
  }

  if (
    parts.length === 0 &&
    turnHasFileInspectionTools(records) &&
    !turnHasFileMutationTools(records)
  ) {
    return buildFileInspectionChatAppendix(records)
  }

  if (parts.length === 0 && records.some(isRecoverableWorkspaceFilePatchFailure)) {
    return 'I need another look at the live file to finish that edit. Please try again if it did not complete.'
  }

  const summary = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
  return summary || null
}

const SPECIALIST_DOMAIN_NAMES = new Set([
  'workflow',
  'run',
  'deploy',
  'auth',
  'knowledge',
  'table',
  'scheduled_task',
  'agent',
  'research',
  'media',
  'file',
  'superagent',
])

function isLikelySpecialistDomain(name: string): boolean {
  return SPECIALIST_DOMAIN_NAMES.has(name)
}

/**
 * Turns specialist findings like `[create_workflow] {"workflowName":"…"}` into short prose.
 */
function summarizeSpecialistFindings(domain: string, message: string): string {
  const explainSummary = synthesizeExplainErrorFromSpecialistFindings(message)
  if (explainSummary) return explainSummary

  const created = message.match(/\[create_workflow\][^\n]*/i)
  if (created) {
    const nameMatch =
      created[0].match(/"workflowName"\s*:\s*"([^"]+)"/) ||
      created[0].match(/"name"\s*:\s*"([^"]+)"/)
    if (nameMatch?.[1]) {
      return `Created the workflow "${nameMatch[1]}" and set it up for your request.`
    }
    return 'Created a new workflow and set it up for your request.'
  }

  if (/\[edit_workflow\]/i.test(message)) {
    return 'Updated the workflow with the requested blocks and connections.'
  }

  // Drop dense JSON tool dumps; keep any free-form specialist prose.
  const withoutToolJson = message
    .replace(/\[[a-z0-9_]+\]\s*\{[\s\S]*?}(?=\n\n|\n\[|$)/gi, '')
    .trim()
  if (withoutToolJson.length >= 20) return withoutToolJson

  if (isLikelySpecialistDomain(domain)) {
    return `Finished the ${domain.replace(/_/g, ' ')} steps for your request.`
  }

  return message
}
