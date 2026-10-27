import { truncate } from '@sim/utils/string'
import type { WorkflowState } from '@sim/workflow-types/workflow'
import { documentLayoutFollowUpHint } from '@/lib/copilot/chat/document-format-guidance'
import { REDACTED_MARKER } from '@/lib/core/security/redaction'
import { sanitizeForCopilot } from '@/lib/workflows/sanitization/json-sanitizer'
import { getBlock } from '@/blocks/registry'
import { MAX_POPULATE_EDITS } from '@/local-copilot/lib/agent/limits'
import type { ArtifactStore } from '@/local-copilot/lib/context/artifacts'
import {
  LOAD_COPILOT_ARTIFACT_TOOL_NAME,
  maybeOffloadToolResult,
} from '@/local-copilot/lib/context/artifacts'
import { sanitizeForLlm } from '@/local-copilot/lib/security/sanitize'

const FUNCTION_EXECUTE_STDOUT_MAX = 12_000

/** Default hard cap for LLM-bound tool result JSON (history + live path). */
export const LOCAL_COPILOT_TOOL_RESULT_MAX_CHARS = 8_000

/**
 * Slightly higher cap so {@link FUNCTION_EXECUTE_STDOUT_MAX} stdout can still fit
 * inside the JSON envelope without a second hard cut.
 */
export const LOCAL_COPILOT_TOOL_RESULT_MAX_CHARS_FUNCTION_EXECUTE = 13_000

const TOOL_RESULT_TRUNCATION_MARKER =
  '\n…[truncated: tool result exceeded char budget; re-query with a narrower call or load_copilot_artifact if an artifactId is present]'

/**
 * Compact JSON for LLM tool results. Falls back to a tiny error payload on failure.
 * Applies a hard char cap so history reload (no artifact store) cannot rehydrate
 * multi-10k tool bodies.
 */
export function compactStringifyForLlm(
  value: unknown,
  maxChars: number = LOCAL_COPILOT_TOOL_RESULT_MAX_CHARS
): string {
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length <= maxChars) return serialized
    const budget = Math.max(0, maxChars - TOOL_RESULT_TRUNCATION_MARKER.length)
    return `${serialized.slice(0, budget)}${TOOL_RESULT_TRUNCATION_MARKER}`
  } catch {
    return JSON.stringify({ success: false, error: 'tool result omitted' })
  }
}

const TOOL_EXECUTION_ORDER: Record<string, number> = {
  create_workflow: 0,
  edit_workflow: 1,
  get_workflow_run_options: 2,
  run_workflow: 3,
  run_workflow_until_block: 3,
  run_block: 3,
  run_from_block: 3,
  create_file_folder: 10,
  create_file: 11,
  workspace_file: 12,
  edit_content: 13,
}

const FILE_PIPELINE_TOOLS = [
  'create_file_folder',
  'create_file',
  'workspace_file',
  'edit_content',
] as const
const FILE_PIPELINE_TOOL_SET = new Set<string>(FILE_PIPELINE_TOOLS)
const WORKFLOW_TOOLS_BEFORE_FILES = 10

function interleaveFilePipelines<T extends { name: string }>(fileCalls: T[]): T[] {
  const queues = new Map<string, T[]>()
  for (const name of FILE_PIPELINE_TOOLS) {
    queues.set(name, [])
  }
  for (const call of fileCalls) {
    queues.get(call.name)?.push(call)
  }

  const ordered: T[] = []
  const hasRemaining = () => FILE_PIPELINE_TOOLS.some((name) => (queues.get(name)?.length ?? 0) > 0)
  while (hasRemaining()) {
    for (const name of FILE_PIPELINE_TOOLS) {
      const next = queues.get(name)?.shift()
      if (next) ordered.push(next)
    }
  }
  return ordered
}

/**
 * Orders a tool batch so workflow mutations stay first, then each office file
 * runs as create → workspace_file → edit_content. A plain numeric sort would
 * run every workspace_file before any edit_content, and the later intent would
 * steal the first file's body (empty DOCX preview).
 */
export function sortToolCallsForExecution<T extends { name: string }>(calls: T[]): T[] {
  const early: T[] = []
  const fileCalls: T[] = []
  const late: T[] = []

  for (const call of calls) {
    if (FILE_PIPELINE_TOOL_SET.has(call.name)) {
      fileCalls.push(call)
      continue
    }
    const order = TOOL_EXECUTION_ORDER[call.name]
    if (order !== undefined && order < WORKFLOW_TOOLS_BEFORE_FILES) {
      early.push(call)
    } else {
      late.push(call)
    }
  }

  early.sort((a, b) => (TOOL_EXECUTION_ORDER[a.name] ?? 0) - (TOOL_EXECUTION_ORDER[b.name] ?? 0))
  late.sort((a, b) => (TOOL_EXECUTION_ORDER[a.name] ?? 99) - (TOOL_EXECUTION_ORDER[b.name] ?? 99))
  return [...early, ...interleaveFilePipelines(fileCalls), ...late]
}

/**
 * Binds `workspace_file` → `edit_content` Redis intents to one channel.
 * When a File Agent pass already seeded `previousChannelId` (the specialist
 * tool-call id), keep it so preview, span, and consume all share that id.
 * Otherwise fall back to this `workspace_file` call id (parent-lane writes).
 */
export function bindLocalFileIntentChannel(
  toolName: string,
  toolCallId: string,
  previousChannelId: string | undefined
): string | undefined {
  if (toolName === 'workspace_file') return previousChannelId ?? toolCallId
  return previousChannelId
}

/** Drop the channel after `edit_content` so the next file starts a new intent. */
export function clearLocalFileIntentChannel(
  toolName: string,
  channelId: string | undefined
): string | undefined {
  return toolName === 'edit_content' ? undefined : channelId
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * True when `workflowState` is already Copilot-shaped (`sanitizeForCopilot` output),
 * not a full editor {@link WorkflowState}. Re-sanitizing Copilot blocks used to
 * crash with `Object.entries(undefined)` because they lack `subBlocks`.
 */
export function isAlreadyCopilotSanitizedWorkflowState(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const blocks = record.blocks
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) return false

  const blockValues = Object.values(blocks as Record<string, unknown>)
  if (blockValues.length === 0) {
    // Empty Copilot payload is `{ blocks: {} }` with no edges array.
    return !Array.isArray(record.edges)
  }

  for (const block of blockValues) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    const entry = block as Record<string, unknown>
    if ('subBlocks' in entry) return false
    if (typeof entry.type === 'string') return true
  }

  return false
}

function resolveCopilotSanitizedWorkflowState(workflowState: unknown): unknown {
  if (!workflowState || typeof workflowState !== 'object') return undefined
  if (isAlreadyCopilotSanitizedWorkflowState(workflowState)) {
    return workflowState
  }
  const state = workflowState as WorkflowState
  return sanitizeForCopilot({
    blocks: state.blocks ?? {},
    edges: state.edges ?? [],
    loops: state.loops ?? {},
    parallels: state.parallels ?? {},
  })
}

/**
 * Pulls model-facing hints from `block_not_found` skipped items that include
 * `details.suggestions` (from the edit engine).
 */
function formatBlockNotFoundFollowUpHint(skippedItems: unknown): string | undefined {
  if (!Array.isArray(skippedItems) || skippedItems.length === 0) return undefined

  const lines: string[] = []
  for (const item of skippedItems) {
    const row = asRecord(item)
    if (row.type !== 'block_not_found') continue
    const details = asRecord(row.details)
    const suggestions = Array.isArray(details.suggestions) ? details.suggestions : []
    const missingId = typeof row.blockId === 'string' ? row.blockId : 'unknown'
    if (suggestions.length === 0) {
      if (typeof row.reason === 'string' && row.reason.trim()) {
        lines.push(row.reason.trim())
      }
      continue
    }
    const listed = suggestions
      .map((suggestion) => {
        const entry = asRecord(suggestion)
        const id = typeof entry.blockId === 'string' ? entry.blockId : ''
        const name = typeof entry.blockName === 'string' ? entry.blockName : ''
        const type = typeof entry.blockType === 'string' ? entry.blockType : ''
        if (!id) return null
        return `block_id="${id}" (name "${name || id}", type ${type || 'unknown'})`
      })
      .filter((value): value is string => Boolean(value))
    if (listed.length === 1) {
      lines.push(
        `Missing block "${missingId}" — delete/edit using ${listed[0]} instead. Do not invent ids.`
      )
    } else if (listed.length > 1) {
      lines.push(
        `Missing block "${missingId}" — candidates: ${listed.join('; ')}. Use a real block_id.`
      )
    }
  }

  return lines.length > 0 ? lines.join(' ') : undefined
}

/**
 * Builds the value passed into {@link formatToolResultForLlm} so failures with
 * an empty `result` still surface `error`, and bare success does not become `{}`.
 */
export function coalesceToolExecutionPayloadForLlm(params: {
  success: boolean
  result: unknown
  error?: string
  toolName?: string
}): unknown {
  const record = asRecord(params.result)
  const hasFields = Object.keys(record).length > 0
  if (hasFields) {
    if (
      !params.success &&
      params.error &&
      typeof record.error !== 'string' &&
      typeof record.message !== 'string'
    ) {
      return { ...record, success: false, error: params.error }
    }
    return params.result
  }

  if (params.error) {
    return { success: false, error: params.error }
  }

  return {
    success: params.success !== false,
    message: params.toolName
      ? `${params.toolName} completed`
      : 'Tool completed with no detail payload.',
    ...(params.toolName ? { toolName: params.toolName } : {}),
  }
}

const FILE_TOOLS_NEEDING_EMPTY_GUARD = new Set([
  'create_file',
  'create_file_folder',
  'workspace_file',
  'edit_content',
  'list_file_folders',
])

/**
 * When a file tool succeeds with a near-empty body, add an explicit hint so the
 * model does not invent "tools returned empty results."
 */
function guardEmptyFileToolPayload(toolName: string, formatted: unknown): unknown {
  if (!FILE_TOOLS_NEEDING_EMPTY_GUARD.has(toolName)) return formatted
  const record = asRecord(formatted)
  const keys = Object.keys(record).filter(
    (key) => key !== 'success' && key !== 'toolName' && record[key] !== undefined
  )
  if (keys.length > 0) return formatted
  if (record.success === false) return formatted
  return {
    ...record,
    success: true,
    message:
      typeof record.message === 'string' && record.message.trim()
        ? record.message
        : `${toolName} completed`,
    followUpHint:
      'Tool succeeded but returned no detail fields. Continue the file pipeline (workspace_file / edit_content) or check files/ — do not narrate empty tool results or restart.',
  }
}

const FOLLOW_UP_FIELD_KEYS = [
  'needsFollowUpPopulate',
  'needsFollowUpEdit',
  'needsFollowUpWrite',
  'needsFollowUpWorkspaceFile',
  'needsFollowUpEditContent',
  'needsFollowUpPatchRepair',
  'needsFollowUpRun',
  'needsOAuthConnect',
  'followUpHint',
  'editPrecondition',
] as const

const RECOVERABLE_PATCH_ERROR_TYPES = new Set([
  'search_not_found',
  'search_ambiguous',
  'search_looks_truncated',
  'search_too_long',
  'search_repeated',
  'search_ignores_live_excerpt',
  'html_full_update_too_large',
])

const PATCH_REPAIR_FOLLOW_UP_HINT =
  'Patch search did not match the live file (stale/truncated/too long/ambiguous/repeated/invented search — file is still there). Call read or grep on the file path NOW, copy a short unique substring from the live excerpt into search (well under 600 chars; must reuse a live token), then workspace_file operation=patch once. Do not reuse the previous search and do not invent new markup. Do not regenerate the whole file. Do not tell the user the file is missing or that the edit permanently failed.'

const HTML_FULL_UPDATE_FOLLOW_UP_HINT =
  'Full HTML update was blocked because the file is too large. Call grep (or a tight read) for the region to change, then workspace_file operation=patch with search_replace and a short unique live substring, then edit_content with only the replacement. Do not retry operation=update and do not create_file a full rewrite of this page.'

/** User-facing closer. The model hint stays on {@link PATCH_REPAIR_FOLLOW_UP_HINT}. */
export const PATCH_REPAIR_USER_HINT =
  'I could not find that exact text in the file, so nothing was changed. Tell me the button label, heading, or section to update and I will try again.'

/**
 * Copies mandatory-follow-up flags onto an artifact stub so offload cannot
 * drop `create_workflow` populate (or other required next tools).
 */
function copyFollowUpFields(
  source: unknown,
  stub: Record<string, unknown>
): Record<string, unknown> {
  const record = asRecord(source)
  const next = { ...stub }
  for (const key of FOLLOW_UP_FIELD_KEYS) {
    if (record[key] !== undefined) next[key] = record[key]
  }
  return next
}

export interface MandatoryFollowUp {
  id: string
  /** Instruction injected into the model continuation. */
  hint: string
  /** Sentence shown in chat when the follow-up is still open at the end of the turn. */
  userHint?: string
  resolveWith: string[]
}

/**
 * True when a missing required field label maps to an OAuth credential control
 * (or its advanced manual credential twin) on the given block type.
 */
function isOAuthCredentialField(blockType: string | undefined, fieldLabel: string): boolean {
  if (!blockType || !fieldLabel.trim()) return false
  const blockConfig = getBlock(blockType)
  if (!blockConfig?.subBlocks?.length) {
    // Fallback when registry is unavailable in tests: common OAuth field titles.
    return /\b(account|credential|oauth)\b/i.test(fieldLabel)
  }

  const label = fieldLabel.trim().toLowerCase()
  return blockConfig.subBlocks.some((subBlock) => {
    const title = (subBlock.title ?? '').trim().toLowerCase()
    const id = subBlock.id.trim().toLowerCase()
    if (title !== label && id !== label) return false
    if (subBlock.type === 'oauth-input') return true
    const canonical = subBlock.canonicalParamId?.toLowerCase() ?? ''
    return (
      canonical === 'oauthcredential' ||
      canonical.includes('credential') ||
      id === 'credential' ||
      id === 'manualcredential'
    )
  })
}

/**
 * True when the only remaining workflow lint is missing OAuth credentials the
 * user must connect — edits cannot clear these.
 */
export function isOAuthOnlyEditResult(output: unknown): boolean {
  const record = asRecord(output)
  if (record.success === false) return false

  const skipped = record.skippedItems
  if (Array.isArray(skipped) && skipped.length > 0) return false

  const inputErrors = record.inputValidationErrors
  if (Array.isArray(inputErrors) && inputErrors.length > 0) return false

  const lint = asRecord(record.workflowLint)
  const hasLintObject = Object.keys(lint).length > 0

  if (hasLintObject) {
    const orphanBlocks = Array.isArray(lint.orphanBlocks) ? lint.orphanBlocks : []
    const emptyOutgoingPorts = Array.isArray(lint.emptyOutgoingPorts) ? lint.emptyOutgoingPorts : []
    const invalidBranchPorts = Array.isArray(lint.invalidBranchPorts) ? lint.invalidBranchPorts : []
    const invalidConnectionTargets = Array.isArray(lint.invalidConnectionTargets)
      ? lint.invalidConnectionTargets
      : []
    if (
      orphanBlocks.length > 0 ||
      emptyOutgoingPorts.length > 0 ||
      invalidBranchPorts.length > 0 ||
      invalidConnectionTargets.length > 0
    ) {
      return false
    }

    const unresolved = Array.isArray(lint.unresolvedReferences) ? lint.unresolvedReferences : []
    if (
      unresolved.some((ref) => {
        const kind = asRecord(ref).kind
        return kind !== 'credential'
      })
    ) {
      return false
    }

    const fieldIssues = Array.isArray(lint.fieldIssues) ? lint.fieldIssues : []
    let oauthFieldCount = 0
    for (const issue of fieldIssues) {
      const row = asRecord(issue)
      const inactive = Array.isArray(row.inactiveModeValues) ? row.inactiveModeValues : []
      if (inactive.length > 0) return false

      const missing = Array.isArray(row.missingRequiredFields)
        ? row.missingRequiredFields.filter((value): value is string => typeof value === 'string')
        : []
      if (missing.length === 0) continue

      const blockType = typeof row.blockType === 'string' ? row.blockType : undefined
      for (const field of missing) {
        if (!isOAuthCredentialField(blockType, field)) return false
        oauthFieldCount += 1
      }
    }

    return oauthFieldCount > 0 || unresolved.some((ref) => asRecord(ref).kind === 'credential')
  }

  // Message-only fallback when workflowLint was stripped from the payload.
  const message =
    typeof record.workflowLintMessage === 'string' ? record.workflowLintMessage.trim() : ''
  if (!message) return false
  if (
    /orphan|unconnected|invalid (condition|router|branch)|connections pointing|inactive field mode|tool\/skill references/i.test(
      message
    )
  ) {
    return false
  }
  return (
    /blocks missing required fields/i.test(message) &&
    /\b(account|credential|oauth)\b/i.test(message) &&
    !/\b(query|prompt|model|to|subject|body|url)\b/i.test(
      message.replace(/\b(gmail account|google account|slack account)\b/gi, '')
    )
  )
}

/**
 * Returns true when edit_workflow applied partially and the agent should retry with fixes.
 * OAuth/credential-only lint is excluded — that requires user authorization, not another edit.
 * Precondition failures (missing metadata / workflowId / stale revision) are excluded — those
 * need a different tool first; forcing bare edit_workflow loops forever.
 */
export function editWorkflowNeedsFollowUp(output: unknown): boolean {
  const record = asRecord(output)
  if (classifyEditWorkflowPrecondition(record)) return false

  if (record.success === false) return true

  if (record.partialApply === true) return true

  const skipped = record.skippedItems
  if (Array.isArray(skipped) && skipped.length > 0) return true

  const inputErrors = record.inputValidationErrors
  if (Array.isArray(inputErrors) && inputErrors.length > 0) return true

  if (typeof record.workflowLintMessage === 'string' && record.workflowLintMessage.trim()) {
    if (isOAuthOnlyEditResult(record)) return false
    return true
  }

  return false
}

export type EditWorkflowPreconditionKind =
  | 'metadata'
  | 'workflow_id'
  | 'stale_revision'
  | 'tool_call_id'

/**
 * Classifies hard gate failures that must not become mandatory bare edit_workflow retries.
 */
export function classifyEditWorkflowPrecondition(
  output: unknown
): EditWorkflowPreconditionKind | null {
  const record = asRecord(output)
  const error =
    (typeof record.error === 'string' && record.error) ||
    (typeof record.message === 'string' && record.message) ||
    ''
  if (!error) return null
  if (/get_blocks_metadata/i.test(error)) return 'metadata'
  if (/stale revision|changed since this turn loaded/i.test(error)) return 'stale_revision'
  if (/workflowId is required|create a workflow first/i.test(error)) return 'workflow_id'
  if (/tool call ID/i.test(error)) return 'tool_call_id'
  return null
}

function stringifyCapturedValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === 'undefined' || trimmed === 'null') return ''
    return trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Extracts user-visible text from code-execution tool payloads (`stdout`, `result`, Daytona output).
 */
export function extractCapturedOutput(result: unknown): string | null {
  const record = asRecord(result)

  if ('stdout' in record || ('result' in record && !('toolId' in record))) {
    const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : ''
    const returnText = stringifyCapturedValue(record.result)
    const captured = stdout || returnText
    return captured || null
  }

  if (typeof record.toolId === 'string') {
    const output = asRecord(record.output)
    if (typeof output.result === 'string' && output.result.trim()) {
      return output.result.trim()
    }
    const nested = extractCapturedOutput(output)
    if (nested) return nested
  }

  if (typeof record.capturedOutput === 'string' && record.capturedOutput.trim()) {
    return record.capturedOutput.trim()
  }

  return null
}

function enrichCodeExecutionResultForLlm(record: Record<string, unknown>): Record<string, unknown> {
  const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : ''
  const returnText = stringifyCapturedValue(record.result)
  const capturedOutput = stdout || returnText

  const formatted: Record<string, unknown> = { ...record }

  if (capturedOutput) {
    if (capturedOutput.length > FUNCTION_EXECUTE_STDOUT_MAX) {
      formatted.capturedOutput = truncate(capturedOutput, FUNCTION_EXECUTE_STDOUT_MAX)
      formatted.capturedOutputTruncated = true
    } else {
      formatted.capturedOutput = capturedOutput
    }
    formatted.readOutputFrom = stdout ? 'stdout' : 'result'
  } else {
    formatted.outputHint =
      'Execution succeeded but both stdout and return value were empty. Use print/console.log or return a value from the script.'
  }

  return formatted
}

function enrichInvokeIntegrationResultForLlm(
  record: Record<string, unknown>
): Record<string, unknown> {
  const output = asRecord(record.output)
  const toolId = typeof record.toolId === 'string' ? record.toolId : ''

  if (toolId.startsWith('daytona_') || 'exitCode' in output) {
    const capturedOutput = (typeof output.result === 'string' && output.result.trim()) || undefined
    return {
      ...record,
      ...(capturedOutput ? { capturedOutput, readOutputFrom: 'result' } : {}),
      ...(!capturedOutput
        ? {
            outputHint:
              'Sandbox execution finished but produced no captured text. Use print/logging in the script.',
          }
        : {}),
    }
  }

  if ('stdout' in output || 'result' in output) {
    return {
      ...record,
      output: enrichCodeExecutionResultForLlm(output),
    }
  }

  return record
}

/**
 * Shapes tool output for the LLM — omits heavy workflowState, keeps repair signals,
 * and compact-serializes. Oversized payloads are offloaded when an artifact store is provided.
 */
export function formatToolResultForLlm(
  toolName: string,
  result: unknown,
  options?: { artifactStore?: ArtifactStore }
): string {
  let formatted: unknown = result

  if (toolName === 'function_execute') {
    formatted = enrichCodeExecutionResultForLlm(asRecord(result))
  } else if (toolName === 'invoke_integration_tool') {
    formatted = enrichInvokeIntegrationResultForLlm(asRecord(result))
  } else if (toolName === 'create_file') {
    const record = asRecord(result)
    const data = asRecord(record.data)
    const size = typeof data.size === 'number' ? data.size : 0
    if (record.success === false) {
      const createErrorType = typeof record.errorType === 'string' ? record.errorType : ''
      formatted = {
        ...record,
        followUpHint:
          createErrorType === 'html_create_too_large'
            ? 'HTML create_file body was too large. create_file a lean shell under 100KB (semantic HTML + small CSS, CDN icons) or patch the existing large file with workspace_file operation=patch. Do NOT retry the same megabyte dump, and do not switch to manage_sandbox or python-pptx.'
            : 'create_file failed — fix the args and call create_file again (fileName for office shells; fileName + content for html/md/txt/json/csv). Do NOT switch to manage_sandbox, function_execute, or python-pptx, and do not tell the user office tools are unavailable.',
      }
    } else if (size === 0) {
      const filePath =
        (typeof data.vfsPath === 'string' && data.vfsPath) ||
        (typeof data.name === 'string' && data.name) ||
        ''
      const message =
        (typeof record.message === 'string' && record.message) ||
        (typeof record.error === 'string' && record.error) ||
        ''
      const isOfficeShell =
        /\.(pptx|docx|pdf)$/i.test(filePath) || /empty file shell/i.test(message)
      if (isOfficeShell) {
        // size=0 is the intended first step for office docs — models often
        // misread it as "tools returned empty" and waste minutes retrying /
        // escalating to the file agent.
        formatted = {
          ...record,
          success: true,
          expectedEmptyShell: true,
          needsFollowUpWorkspaceFile: true,
          followUpHint:
            'SUCCESS — empty PDF/DOCX/PPTX shell is expected (size 0). Do NOT retry create_file, list folders, or call the file agent. Next: workspace_file operation=update with target.kind=path and data.vfsPath (plus title), then edit_content in a later round.',
        }
      } else {
        formatted = {
          ...record,
          needsFollowUpWrite: true,
          followUpHint:
            'Text/markdown file is empty — call create_file again on the same path with the full body in `content` (do not use the office workspace_file → edit_content pipeline for .md/.txt/.html/.json/.csv).',
        }
      }
    } else {
      formatted = record
    }
  } else if (toolName === 'list_file_folders') {
    const record = asRecord(result)
    const data = asRecord(record.data)
    const folders = Array.isArray(data.folders) ? data.folders : []
    if (record.success !== false && folders.length === 0) {
      formatted = {
        ...record,
        followUpHint:
          'No folders yet — that is normal. Call create_file_folder if you need a subfolder, or create_file directly under files/. An empty folder list is not a tool failure.',
      }
    } else {
      formatted = record
    }
  } else if (toolName === 'workspace_file') {
    const record = asRecord(result)
    const data = asRecord(record.data)
    const operation = typeof data.operation === 'string' ? data.operation : ''
    const errorType = typeof record.errorType === 'string' ? record.errorType : ''
    if (
      record.success === false &&
      (record.recoverable === true || RECOVERABLE_PATCH_ERROR_TYPES.has(errorType))
    ) {
      const followUpHint =
        errorType === 'html_full_update_too_large'
          ? HTML_FULL_UPDATE_FOLLOW_UP_HINT
          : PATCH_REPAIR_FOLLOW_UP_HINT
      formatted = {
        ...record,
        recoverable: true,
        needsFollowUpPatchRepair: true,
        followUpHint,
      }
    } else if (
      record.success !== false &&
      (operation === 'append' || operation === 'update' || operation === 'patch')
    ) {
      const fileName =
        (typeof data.name === 'string' && data.name) ||
        (typeof data.vfsPath === 'string' && data.vfsPath) ||
        'the file'
      const baseHint =
        typeof record.message === 'string' && record.message.trim()
          ? record.message.trim()
          : `Call edit_content in the next step with the content to write to "${fileName}". Do not call edit_content in parallel with workspace_file.`
      formatted = {
        ...record,
        needsFollowUpEditContent: true,
        followUpHint: documentLayoutFollowUpHint(fileName, baseHint),
      }
    } else {
      formatted = record
    }
  } else if (toolName === 'edit_workflow' || toolName === 'create_workflow') {
    const record = asRecord(result)
    const { workflowState, workflowLint: _workflowLint, ...rest } = record
    const next: Record<string, unknown> = { ...rest }

    if (workflowState && typeof workflowState === 'object') {
      // edit_workflow already returns sanitizeForCopilot(graph) under workflowState.
      // Pass that through — re-sanitizing Copilot-shaped blocks crashes.
      next.copilotSanitizedWorkflowState = resolveCopilotSanitizedWorkflowState(workflowState)
    } else if (record.copilotSanitizedWorkflowState) {
      next.copilotSanitizedWorkflowState = record.copilotSanitizedWorkflowState
    }

    if (editWorkflowNeedsFollowUp(record)) {
      next.needsFollowUpEdit = true
      const blockNotFoundHint = formatBlockNotFoundFollowUpHint(record.skippedItems)
      next.followUpHint = blockNotFoundHint
        ? `${blockNotFoundHint} Call edit_workflow again with corrected operations before finishing.`
        : 'Some operations were skipped, inputs rejected, or lint issues remain. Call edit_workflow again with corrected operations before finishing.'
    } else if (classifyEditWorkflowPrecondition(record)) {
      const kind = classifyEditWorkflowPrecondition(record)!
      next.needsFollowUpEdit = true
      next.editPrecondition = kind
      next.followUpHint =
        kind === 'metadata'
          ? 'Call get_blocks_metadata for the missing block types, then edit_workflow again.'
          : kind === 'stale_revision'
            ? 'Call get_workflow_context to refresh the graph, then edit_workflow again.'
            : kind === 'workflow_id'
              ? 'Pass workflowId (or create_workflow first), then edit_workflow.'
              : 'Retry edit_workflow with a trusted tool call.'
    } else if (isOAuthOnlyEditResult(record)) {
      next.needsOAuthConnect = true
      next.followUpHint =
        'Workflow structure is complete. The only remaining lint is a missing OAuth credential — call oauth_get_auth_link once for each missing provider in this response, then STOP. Do not re-edit; edits cannot clear credential lint.'
    }

    if (
      toolName === 'create_workflow' &&
      record.success !== false &&
      typeof record.workflowId === 'string' &&
      record.workflowId.trim()
    ) {
      // Keep the create payload small so populate flags are not lost to artifact
      // offload. The model already has workflowId + startBlockId.
      next.copilotSanitizedWorkflowState = undefined
      next.needsFollowUpPopulate = true
      next.followUpHint = `New workflow created. Do NOT create_workflow or get_workflow_context again. Call get_blocks_metadata once with every type you will add (e.g. { blockIds: ["agent","schedule","human_in_the_loop"] }), then edit_workflow using startBlockId. Do not load_copilot_artifact to re-read that metadata. Up to ${MAX_POPULATE_EDITS} sequential edit_workflow calls are OK. Human review uses type human_in_the_loop. A daily time trigger is block type "schedule" (scheduleType "daily", dailyTime "09:00", timezone "Asia/Kolkata" for IST) — never "schedule_trigger". Put triggerMode next to inputs, not inside inputs. A named fetch-and-send sequence is canvas blocks of the current types (google_calendar_v2, gmail_v2, slack) wired in order, not Agent.tools. Omit Agent model unless metadata lists that exact current id.`
    }

    formatted = next
  } else if (toolName === 'get_blocks_metadata') {
    const record = asRecord(result)
    const metadata = asRecord(record.metadata)
    const metadataKeys = Object.keys(metadata)
    formatted = {
      ...record,
      followUpHint:
        metadataKeys.length === 0
          ? "No block metadata returned for the requested ids (often sunset/legacy names). Retry with current successors (e.g. image_generator → image_generator_v2, gmail → gmail_v2). To attach Image/Chart/Exa/etc. to an Agent, edit that Agent's tools array — do not add them as canvas blocks."
          : "If you just created a workflow, call edit_workflow now to add blocks. To attach Image Generator / Chart Generator / Exa to an existing Agent, edit that Agent's tools array (type image_generator_v2 / chart_generator / exa) and update its messages/prompt so it chooses those tools from the user question — do not add those as canvas blocks and do not add a Function block as a substitute. Do not load_copilot_artifact unless a specific field id is missing from this result.",
    }
  } else if (toolName === 'edit_content') {
    const record = asRecord(result)
    const message =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      ''
    if (
      record.success === false &&
      /unexpected token|syntaxerror|syntax error|parse error|unexpected end/i.test(message)
    ) {
      formatted = {
        ...record,
        regenerateNow: true,
        followUpHint:
          'Syntax/parse error in office JS. Do NOT keep Thinking about parentheses or table rows. Call edit_content immediately with a clean full rewrite (simpler tables, fewer nested expressions). One rewrite beats ten diagnosis paragraphs.',
      }
    }
  }

  if (toolName === 'generate_api_key') {
    const record = asRecord(formatted)
    if (typeof record.key === 'string') {
      formatted = {
        ...record,
        key: REDACTED_MARKER,
        redacted: true,
      }
    }
  }

  formatted = guardEmptyFileToolPayload(toolName, formatted)

  const sanitized = sanitizeForLlm(formatted)
  if (options?.artifactStore && toolName !== LOAD_COPILOT_ARTIFACT_TOOL_NAME) {
    const offload = maybeOffloadToolResult(toolName, sanitized, options.artifactStore)
    if (offload.offloaded) {
      return compactStringifyForLlm(copyFollowUpFields(sanitized, offload.stub))
    }
  }

  const maxChars =
    toolName === 'function_execute'
      ? LOCAL_COPILOT_TOOL_RESULT_MAX_CHARS_FUNCTION_EXECUTE
      : LOCAL_COPILOT_TOOL_RESULT_MAX_CHARS
  return compactStringifyForLlm(sanitized, maxChars)
}

/**
 * Detects when a tool result requires another tool call before the turn can end.
 */
export function detectMandatoryFollowUp(
  toolName: string,
  llmFormattedJson: string
): MandatoryFollowUp | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(llmFormattedJson) as Record<string, unknown>
  } catch {
    return null
  }

  return detectMandatoryFollowUpFromRecord(toolName, parsed)
}

/**
 * Same as {@link detectMandatoryFollowUp}, but also inspects the raw tool result
 * so artifact stubs / truncated JSON cannot drop `create_workflow` populate.
 */
export function detectMandatoryFollowUpFromExecution(
  toolName: string,
  success: boolean,
  result: unknown,
  llmFormattedJson: string
): MandatoryFollowUp | null {
  const fromFormatted = detectMandatoryFollowUp(toolName, llmFormattedJson)
  if (fromFormatted) return fromFormatted
  if (!success) return null
  return detectMandatoryFollowUpFromRecord(toolName, asRecord(result))
}

function detectMandatoryFollowUpFromRecord(
  toolName: string,
  parsed: Record<string, unknown>
): MandatoryFollowUp | null {
  const hint =
    typeof parsed.followUpHint === 'string' && parsed.followUpHint.trim()
      ? parsed.followUpHint.trim()
      : null

  if (parsed.needsFollowUpWrite === true) {
    return {
      id: 'create_file:write',
      hint:
        hint ??
        'Text/markdown file is empty. Call create_file again with the full body in content.',
      resolveWith: ['create_file'],
    }
  }

  if (parsed.needsFollowUpWorkspaceFile === true) {
    return {
      id: 'create_file:workspace-file',
      hint:
        hint ??
        'SUCCESS — empty office shell is expected. Call workspace_file operation=update on the file path, then edit_content in a later round. Do not retry create_file or call the file agent.',
      resolveWith: ['workspace_file'],
    }
  }

  if (parsed.needsFollowUpEditContent === true) {
    return {
      id: 'workspace_file:edit-content',
      hint: hint ?? 'Call edit_content in the next step with the file body.',
      resolveWith: ['edit_content'],
    }
  }

  if (parsed.needsFollowUpPatchRepair === true) {
    return {
      id: 'workspace_file:patch-repair',
      hint: hint ?? PATCH_REPAIR_FOLLOW_UP_HINT,
      userHint: PATCH_REPAIR_USER_HINT,
      resolveWith: ['read', 'grep'],
    }
  }

  if (parsed.needsFollowUpEdit === true) {
    const precondition =
      parsed.editPrecondition === 'metadata' ||
      parsed.editPrecondition === 'workflow_id' ||
      parsed.editPrecondition === 'stale_revision' ||
      parsed.editPrecondition === 'tool_call_id'
        ? parsed.editPrecondition
        : classifyEditWorkflowPrecondition(parsed)

    if (precondition === 'metadata') {
      return {
        id: 'edit_workflow:metadata',
        hint:
          hint ?? 'Call get_blocks_metadata for the missing block types, then edit_workflow again.',
        resolveWith: ['get_blocks_metadata', 'edit_workflow'],
      }
    }
    if (precondition === 'stale_revision') {
      return {
        id: 'edit_workflow:reread',
        hint: hint ?? 'Call get_workflow_context to refresh, then edit_workflow again.',
        resolveWith: ['get_workflow_context', 'edit_workflow'],
      }
    }
    if (precondition === 'workflow_id') {
      return {
        id: 'edit_workflow:workflow-id',
        hint: hint ?? 'Pass workflowId or create_workflow first, then edit_workflow.',
        resolveWith: ['create_workflow', 'edit_workflow'],
      }
    }

    return {
      id: `${toolName}:edit-repair`,
      hint:
        hint ??
        'Workflow edits were incomplete. Call edit_workflow again with corrected operations.',
      resolveWith: ['edit_workflow'],
    }
  }

  if (parsed.needsOAuthConnect === true) {
    return {
      id: 'edit_workflow:oauth',
      hint:
        hint ??
        'Missing OAuth credential. Call oauth_get_auth_link once for each missing provider in this response, then stop.',
      resolveWith: ['oauth_get_auth_link'],
    }
  }

  if (parsed.needsFollowUpPopulate === true) {
    return {
      id: 'create_workflow:populate',
      hint: hint ?? 'New workflow created. Call edit_workflow with add operations to populate it.',
      resolveWith: ['edit_workflow'],
    }
  }

  if (
    toolName === 'create_workflow' &&
    parsed.success !== false &&
    typeof parsed.workflowId === 'string' &&
    parsed.workflowId.trim()
  ) {
    return {
      id: 'create_workflow:populate',
      hint: hint ?? 'New workflow created. Call edit_workflow with add operations to populate it.',
      resolveWith: ['edit_workflow'],
    }
  }

  if (parsed.needsFollowUpRun === true) {
    return {
      id: 'create_workflow:run',
      hint:
        hint ??
        'An existing workflow should be run instead. Call get_workflow_run_options then run_workflow.',
      resolveWith: ['get_workflow_run_options', 'run_workflow'],
    }
  }

  return null
}

/**
 * Follow-ups that must still run after `workspace_file` / `create_file` even
 * when the normal tool-round budget is exhausted — otherwise the turn ends with
 * prepare-without-apply (no `edit_content`).
 */
export const WRITE_CRITICAL_FOLLOW_UP_IDS = new Set([
  'workspace_file:edit-content',
  'create_file:write',
  'create_file:workspace-file',
  'workspace_file:patch-repair',
])

/**
 * True when a pending follow-up must complete a file write pipeline.
 */
export function hasWriteCriticalFollowUp(pending: MandatoryFollowUp[]): boolean {
  return pending.some((item) => WRITE_CRITICAL_FOLLOW_UP_IDS.has(item.id))
}

/**
 * Whether the agent loop may start another model round. Overflow past
 * `maxToolRounds` is reserved for write-critical mandatory follow-ups.
 */
export function canEnterToolRound(options: {
  round: number
  maxToolRounds: number
  maxForcedFollowUpRounds: number
  pendingFollowUps: MandatoryFollowUp[]
}): boolean {
  if (options.round < options.maxToolRounds) return true
  if (options.round >= options.maxToolRounds + options.maxForcedFollowUpRounds) return false
  return hasWriteCriticalFollowUp(options.pendingFollowUps)
}

/**
 * Whether to inject a mandatory-follow-up continuation when the model stopped
 * with no tools. Write-critical follow-ups may use the last normal round and
 * overflow rounds; other follow-ups keep the historical `maxToolRounds - 1` cap.
 */
export function canForceMandatoryFollowUp(options: {
  round: number
  maxToolRounds: number
  maxForcedFollowUpRounds: number
  forcedFollowUpRounds: number
  pendingFollowUps: MandatoryFollowUp[]
  postBuildAllows: boolean
}): boolean {
  if (options.pendingFollowUps.length === 0) return false
  if (!options.postBuildAllows) return false
  if (options.forcedFollowUpRounds >= options.maxForcedFollowUpRounds) return false

  const hardCeil = options.maxToolRounds + options.maxForcedFollowUpRounds
  if (options.round >= hardCeil - 1) return false

  if (options.round < options.maxToolRounds - 1) return true
  return hasWriteCriticalFollowUp(options.pendingFollowUps)
}

/**
 * Removes satisfied follow-ups after a resolving tool succeeds.
 */
export function resolveMandatoryFollowUps(
  pending: MandatoryFollowUp[],
  toolName: string,
  success: boolean,
  result: unknown
): MandatoryFollowUp[] {
  if (!success) return pending

  let next = pending

  if (toolName === 'edit_content') {
    next = next.filter(
      (item) => item.id !== 'create_file:write' && item.id !== 'workspace_file:edit-content'
    )
  }

  if (toolName === 'workspace_file') {
    next = next.filter(
      (item) =>
        item.id !== 'create_file:workspace-file' && item.id !== 'workspace_file:patch-repair'
    )
  }

  if (toolName === 'read' || toolName === 'grep') {
    next = next.filter((item) => item.id !== 'workspace_file:patch-repair')
  }

  if (toolName === 'create_file') {
    const data = asRecord(asRecord(result).data)
    const size = typeof data.size === 'number' ? data.size : 0
    if (size > 0) {
      next = next.filter(
        (item) => item.id !== 'create_file:write' && item.id !== 'create_file:workspace-file'
      )
    }
  }

  if (toolName === 'edit_workflow' && !editWorkflowNeedsFollowUp(result)) {
    next = next.filter(
      (item) =>
        item.id !== 'create_workflow:populate' &&
        !item.id.endsWith(':edit-repair') &&
        item.id !== 'edit_workflow:metadata' &&
        item.id !== 'edit_workflow:reread' &&
        item.id !== 'edit_workflow:workflow-id'
    )
  }

  if (toolName === 'get_blocks_metadata') {
    next = next.filter((item) => item.id !== 'edit_workflow:metadata')
  }

  if (toolName === 'get_workflow_context') {
    next = next.filter((item) => item.id !== 'edit_workflow:reread')
  }

  if (toolName === 'create_workflow') {
    next = next.filter((item) => item.id !== 'edit_workflow:workflow-id')
  }

  if (toolName === 'oauth_get_auth_link') {
    next = next.filter((item) => item.id !== 'edit_workflow:oauth')
  }

  if (toolName === 'run_workflow') {
    next = next.filter((item) => item.id !== 'create_workflow:run')
  }

  return next
}

/**
 * Nudge message injected when the model stops before mandatory follow-up tools run.
 */
export function buildFollowUpContinuationMessage(followUps: MandatoryFollowUp[]): string {
  const hints = followUps.map((item) => `- ${item.hint}`).join('\n')
  const tools = [...new Set(followUps.flatMap((item) => item.resolveWith))].join(', ')
  return `[System] The user's request is not complete yet. Required follow-up:\n${hints}\n\nCall the needed tools now (${tools}) before responding. Do not end the turn until the task is finished.`
}
