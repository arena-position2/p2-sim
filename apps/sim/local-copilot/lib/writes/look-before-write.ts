import { isPlainTextWorkspaceFileName } from '@/lib/mothership/chat/document-format-guidance'
import { hasToolId } from '@/tools/tool-ids'

const BOOTSTRAP_BLOCK_TYPES = new Set(['start_trigger', 'starter', 'start'])

/**
 * Types that belong on an Agent's `inputs.tools` array — not as separate canvas
 * blocks — when the user asks to "add tools to the agent". Adding them via
 * edit_workflow `add` is the failure mode that leaves Image/Chart/Exa off the
 * agent and dumps orphan blocks on the canvas.
 */
export const AGENT_TOOLS_NOT_CANVAS_ADD_TYPES = new Set([
  'image_generator',
  'image_generator_v2',
  'chart_generator',
  'exa',
])

export const AGENT_TOOLS_NOT_CANVAS_ADD_ERROR =
  'Do not add image_generator_v2 / chart_generator / exa as canvas blocks. ' +
  'Edit the existing Agent block and set params.inputs.tools to an array that MERGES these entries with any existing tools, e.g. ' +
  '{ type: "image_generator_v2", title: "Image Generator", toolId: "image_generate", usageControl: "auto", params: { inputImage: "<start.files>" } }, ' +
  '{ type: "chart_generator", title: "Chart Generator", operation: "generate", toolId: "chart_generate", usageControl: "auto" }, ' +
  '{ type: "exa", title: "Exa Search", operation: "exa_search", toolId: "exa_search", usageControl: "auto" }. ' +
  'Also update the Agent messages/system prompt so the model knows when to call each tool based on the user question.'

export interface LookBeforeWriteOk {
  ok: true
}

export interface LookBeforeWriteDenied {
  ok: false
  error: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function operationType(operation: Record<string, unknown>): string {
  const raw = operation.operation_type ?? operation.operationType ?? operation.type
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function blockTypeFromOperation(operation: Record<string, unknown>): string | undefined {
  const params = asRecord(operation.params)
  for (const key of ['type', 'blockType', 'block_type']) {
    const value = params[key] ?? operation[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * Rejects canvas `add` for types that must be attached on Agent.tools instead.
 */
export function assertAgentToolsNotAddedAsCanvasBlocks(params: {
  operations: unknown
}): LookBeforeWriteOk | LookBeforeWriteDenied {
  if (!Array.isArray(params.operations)) return { ok: true }
  const offenders = new Set<string>()
  for (const item of params.operations) {
    const operation = asRecord(item)
    if (operationType(operation) !== 'add') continue
    const blockType = blockTypeFromOperation(operation)?.toLowerCase()
    if (!blockType) continue
    if (AGENT_TOOLS_NOT_CANVAS_ADD_TYPES.has(blockType)) offenders.add(blockType)
  }
  if (offenders.size === 0) return { ok: true }
  return {
    ok: false,
    error: `${AGENT_TOOLS_NOT_CANVAS_ADD_ERROR} Rejected canvas add for: ${[...offenders].join(', ')}.`,
  }
}

/**
 * Requires get_blocks_metadata for block types being added (except bootstrap types).
 * Also rejects Image/Chart/Exa canvas adds that belong on Agent.tools.
 */
export function assertEditWorkflowLookBeforeWrite(params: {
  operations: unknown
  blocksMetadataByType?: Map<string, unknown>
}): LookBeforeWriteOk | LookBeforeWriteDenied {
  const agentToolsGuard = assertAgentToolsNotAddedAsCanvasBlocks({
    operations: params.operations,
  })
  if (!agentToolsGuard.ok) return agentToolsGuard

  if (!Array.isArray(params.operations)) return { ok: true }
  const missing = new Set<string>()
  for (const item of params.operations) {
    const operation = asRecord(item)
    if (operationType(operation) !== 'add') continue
    const blockType = blockTypeFromOperation(operation)
    if (!blockType || BOOTSTRAP_BLOCK_TYPES.has(blockType)) continue
    if (!params.blocksMetadataByType?.has(blockType.toLowerCase())) missing.add(blockType)
  }
  if (missing.size === 0) return { ok: true }
  return {
    ok: false,
    error: `Call get_blocks_metadata for [${[...missing].join(', ')}] before edit_workflow.`,
  }
}

/**
 * Allows invoke when the id is a registered Sim tool, an Arena-known tool, or
 * listed this turn. Blocks hallucinated ids that exist in none of those sets.
 */
export function assertInvokeLookBeforeWrite(params: {
  toolId: string
  listedIntegrationToolIds?: Set<string>
  knownToolIds?: Set<string>
}): LookBeforeWriteOk | LookBeforeWriteDenied {
  const toolId = params.toolId.trim()
  if (!toolId) {
    return { ok: false, error: 'toolId is required — call list_integration_tools first' }
  }
  if (
    params.knownToolIds?.has(toolId) ||
    params.listedIntegrationToolIds?.has(toolId) ||
    hasToolId(toolId)
  ) {
    return { ok: true }
  }
  return {
    ok: false,
    error: `Call list_integration_tools before invoke_integration_tool for "${toolId}".`,
  }
}

/**
 * Canonical workspace file leaf used to match `read` paths with `workspace_file` targets.
 */
export function normalizeWorkspaceFileReadPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/')
  if (!trimmed) return ''
  const withFiles = trimmed.startsWith('files/') ? trimmed : `files/${trimmed}`
  return withFiles.replace(/\/content$/i, '')
}

function workspaceFileTargetPath(args: Record<string, unknown>): string {
  const target = args.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) return ''
  const path = (target as Record<string, unknown>).path
  return typeof path === 'string' ? path.trim() : ''
}

/**
 * Full-replace (`update`) of an existing HTML/text file must follow a `read` of
 * that file this turn. Otherwise the model regenerates from the filename and
 * overwrites the page. Targeted `patch` applies against on-disk content.
 */
export function assertWorkspaceFileLookBeforeWrite(params: {
  args: Record<string, unknown>
  readVfsPaths?: Set<string>
}): LookBeforeWriteOk | LookBeforeWriteDenied {
  const operation =
    typeof params.args.operation === 'string' ? params.args.operation.trim().toLowerCase() : ''
  if (operation !== 'update') return { ok: true }

  const path = workspaceFileTargetPath(params.args)
  const canonical = normalizeWorkspaceFileReadPath(path)
  if (!canonical || !isPlainTextWorkspaceFileName(canonical)) return { ok: true }

  if (params.readVfsPaths?.has(canonical)) return { ok: true }

  return {
    ok: false,
    error: `Call read("${canonical}/content") first so the edit starts from the current file. For a small change (title, heading, one string) use operation=patch with search_replace instead of update — update replaces the entire file.`,
  }
}
