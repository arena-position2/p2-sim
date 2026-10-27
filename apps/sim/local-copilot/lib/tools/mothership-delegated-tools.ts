import { db } from '@sim/db'
import { workflow } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { extractResourcesFromToolResult } from '@/lib/mothership/resources/extraction'
import { extractLocalToolBillingMetadata } from '@/local-copilot/lib/billing/turn-cost-accumulator'
import { getLocalCopilotMemorySnapshot } from '@/local-copilot/lib/diagnostics'
import {
  clampSuccessfulReadResult,
  isOversizedVfsReadError,
  recoverOversizedVfsReadForLocal,
} from '@/local-copilot/lib/tools/clamped-vfs-read'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import {
  enrichCreateFileArgs,
  enrichEditContentArgs,
  enrichWorkspaceFileArgs,
  rejectCreateFileImageAsText,
} from '@/local-copilot/lib/tools/enrich-file-tool-args'
import type { ToolExecutionContext, ToolExecutionResult } from '@/local-copilot/lib/tools/executor'
import {
  buildMothershipDelegatedToolDefinitions,
  isMothershipDelegatedTool,
  isWorkflowScopedDelegatedTool,
  MOTHERSHIP_DELEGATED_TOOL_NAMES,
  type MothershipDelegatedToolName,
  WORKFLOW_SCOPED_DELEGATED_TOOLS,
} from '@/local-copilot/lib/tools/mothership-delegated-tool-defs'
import { rejectOfficeFileViaSandbox } from '@/local-copilot/lib/tools/reject-office-via-sandbox'
import {
  ARENA_ALIASED_SERVER_TOOL_NAMES,
  ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES,
  isArenaFilePipelineTool,
  toServerRegistryToolName,
} from '@/local-copilot/lib/tools/resolve-tool-name-alias'
import type { LocalCopilotStructuredContext } from '@/local-copilot/lib/types'
import { assertWorkspaceFileLookBeforeWrite } from '@/local-copilot/lib/writes/look-before-write'

export {
  MOTHERSHIP_DELEGATED_TOOL_NAMES,
  WORKFLOW_SCOPED_DELEGATED_TOOLS,
  type MothershipDelegatedToolName,
  isMothershipDelegatedTool,
  isWorkflowScopedDelegatedTool,
  buildMothershipDelegatedToolDefinitions,
}

const logger = createLogger('LocalCopilotMothershipDelegatedTools')

/** Default when the model omits language — Mothership template is Python-based. */
const LOCAL_COPILOT_DEFAULT_LANGUAGE = 'python' as const
const LOCAL_COPILOT_FUNCTION_LANGUAGES = new Set(['python', 'shell'])
const LOCAL_COPILOT_SANDBOX_LANGUAGES = new Set(['python'])

function enforceLocalCopilotSandboxLanguages(
  toolName: MothershipDelegatedToolName,
  args: Record<string, unknown>
): ToolExecutionResult | null {
  if (toolName !== 'function_execute' && toolName !== 'manage_sandbox') return null

  const allowed =
    toolName === 'manage_sandbox'
      ? LOCAL_COPILOT_SANDBOX_LANGUAGES
      : LOCAL_COPILOT_FUNCTION_LANGUAGES
  const raw = args.language
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    args.language = LOCAL_COPILOT_DEFAULT_LANGUAGE
    return null
  }

  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!allowed.has(normalized)) {
    const allowedList = [...allowed].join('" or "')
    const message = `Arena Copilot sandbox execution supports "${allowedList}" only (Mothership template is Python-oriented; javascript is not allowed).`
    return {
      toolName,
      success: false,
      error: message,
      result: { success: false, message },
    }
  }

  args.language = normalized
  return null
}

let copilotServerToolNames: Set<string> | null = null
let handlersRegistered = false
let arenaFileAliasesRegistered = false

async function ensureCopilotToolRuntime(): Promise<Set<string>> {
  if (!handlersRegistered) {
    const loadStartedAt = Date.now()
    logger.info('Arena Copilot registering mothership tool handlers', {
      memory: getLocalCopilotMemorySnapshot(),
    })
    const { ensureHandlersRegistered } = await import(
      '@/lib/mothership/tool-executor/register-handlers'
    )
    ensureHandlersRegistered()
    handlersRegistered = true
    logger.info('Arena Copilot mothership tool handlers registered', {
      durationMs: Date.now() - loadStartedAt,
      memory: getLocalCopilotMemorySnapshot(),
    })
  }

  // Rebuild from the live registry so Arena aliases (create_file) appear after
  // hot reload without requiring a full process restart.
  const { getRegisteredServerToolNames } = await import('@/lib/mothership/tools/server/router')
  copilotServerToolNames = new Set(getRegisteredServerToolNames())

  // Hot-reload safety: older handler snapshots may lack Arena leaf names even
  // when create_empty_file / manage_knowledge_base / web_search are present.
  if (!arenaFileAliasesRegistered) {
    const { registerHandler, hasHandler } = await import('@/lib/mothership/tool-executor/executor')
    const { createServerToolHandler } = await import(
      '@/lib/mothership/tools/registry/server-tool-adapter'
    )
    for (const arenaName of ARENA_ALIASED_SERVER_TOOL_NAMES) {
      // Schema-only aliases (function_execute → run_function, materialize_file →
      // save_upload) execute via executeTool fallthrough — not ServerToolAdapter.
      if (!(ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES as readonly string[]).includes(arenaName)) {
        continue
      }
      if (hasHandler(arenaName)) continue
      const serverName = toServerRegistryToolName(arenaName)
      if (
        copilotServerToolNames.has(arenaName) ||
        copilotServerToolNames.has(serverName) ||
        hasHandler(serverName)
      ) {
        registerHandler(arenaName, createServerToolHandler(arenaName))
      }
    }
    arenaFileAliasesRegistered = true
    logger.info('Arena Copilot aliased server tools registered', {
      tools: [...ARENA_ALIASED_SERVER_TOOL_NAMES],
    })
  }

  return copilotServerToolNames
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function normalizeWorkflowName(name: string): string {
  return name.trim().toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ')
}

function matchWorkflowByName(
  workflows: NonNullable<LocalCopilotStructuredContext['workspaceWorkflows']>,
  name: string
): string | undefined {
  const normalized = normalizeWorkflowName(name)
  if (!normalized) return undefined

  const exact = workflows.find(
    (workflowRow) => normalizeWorkflowName(workflowRow.name) === normalized
  )
  if (exact) return exact.id

  const partialMatches = workflows.filter((workflowRow) => {
    const workflowName = normalizeWorkflowName(workflowRow.name)
    return workflowName.includes(normalized) || normalized.includes(workflowName)
  })
  if (partialMatches.length === 1) return partialMatches[0].id

  return undefined
}

export async function resolveWorkflowIdFromDatabase(
  workspaceId: string,
  args: Record<string, unknown>
): Promise<string | undefined> {
  const nameHint =
    (typeof args.workflowName === 'string' && args.workflowName.trim()) ||
    (typeof args.name === 'string' && args.name.trim() && !isUuid(args.name.trim())
      ? args.name.trim()
      : '') ||
    (typeof args.workflowId === 'string' &&
    args.workflowId.trim() &&
    !isUuid(args.workflowId.trim())
      ? args.workflowId.trim()
      : '')

  if (!nameHint) return undefined

  const rows = await db
    .select({ id: workflow.id, name: workflow.name })
    .from(workflow)
    .where(and(eq(workflow.workspaceId, workspaceId), isNull(workflow.archivedAt)))
    .orderBy(desc(workflow.updatedAt))
    .limit(50)

  const workflows = rows.map((row) => ({
    id: row.id,
    name: row.name ?? 'Untitled workflow',
  }))

  return matchWorkflowByName(workflows, nameHint)
}

/**
 * Resolves a workflow ID for delegated tools on home chat where no workflow is open.
 */
export function resolveWorkflowIdForDelegatedTool(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): string | undefined {
  const fromContext =
    (typeof ctx.workflowId === 'string' && ctx.workflowId.trim()) ||
    ctx.structuredContext.workflow?.id

  const rawArg =
    (typeof args.workflowId === 'string' && args.workflowId.trim()) ||
    (typeof args.id === 'string' && args.id.trim()) ||
    undefined

  if (rawArg) {
    if (isUuid(rawArg)) return rawArg
    const workflows = ctx.structuredContext.workspaceWorkflows ?? []
    const byName = matchWorkflowByName(workflows, rawArg)
    if (byName) return byName
  }

  if (fromContext && isUuid(fromContext)) return fromContext

  for (const field of ['workflowName', 'name', 'workflow'] as const) {
    const value = typeof args[field] === 'string' ? args[field].trim() : ''
    if (!value) continue
    const workflows = ctx.structuredContext.workspaceWorkflows ?? []
    const byName = matchWorkflowByName(workflows, value)
    if (byName) return byName
  }

  const workflows = ctx.structuredContext.workspaceWorkflows ?? []
  if (workflows.length === 1) return workflows[0].id

  return undefined
}

function buildMissingWorkflowIdError(
  structuredContext: LocalCopilotStructuredContext
): ToolExecutionResult {
  const workflows = structuredContext.workspaceWorkflows ?? []
  const availableWorkflows = workflows.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    isDeployed: workflow.isDeployed ?? false,
    lastRunAt: workflow.lastRunAt ?? null,
  }))

  const error =
    workflows.length === 0
      ? 'workflowId is required but this workspace has no workflows yet.'
      : `workflowId is required on home chat. Pass workflowId from workspaceWorkflows. Available: ${workflows
          .map((workflow) => `"${workflow.name}" (${workflow.id})`)
          .join(', ')}`

  return {
    toolName: 'get_workflow_run_options',
    success: false,
    result: { error, availableWorkflows },
    error,
  }
}

async function executeCopilotServerTool(
  arenaToolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  workflowId?: string
): Promise<ToolExecutionResult> {
  const { createServerToolHandler } = await import(
    '@/lib/mothership/tools/registry/server-tool-adapter'
  )
  const serverToolName = toServerRegistryToolName(arenaToolName)
  const handler = createServerToolHandler(serverToolName)
  const result = await handler(args, toCopilotServerToolContext(ctx, workflowId))
  const output =
    result.output ??
    (result.error
      ? { error: result.error }
      : result.success
        ? { success: true, message: `${arenaToolName} completed`, toolName: arenaToolName }
        : {})
  const resources =
    result.resources && result.resources.length > 0
      ? result.resources
      : result.success
        ? extractResourcesFromToolResult(serverToolName, args, output)
        : []

  return {
    toolName: arenaToolName,
    success: result.success,
    result: output,
    error: result.error,
    ...(resources.length > 0 ? { resources } : {}),
  }
}

const VARIATION_INTENT_PATTERN =
  /\b(?:variations?|versions?|options?|alternatives?|[1-5]|one|two|three|four|five)\b/i

/**
 * Remaps common generate_image aliases to `prompt`, falls back to the latest
 * user message when the model omits a prompt, and restores variation counts
 * stripped from the tool args.
 */
function enrichGenerateImagePrompt(args: Record<string, unknown>, lastUserMessage?: string): void {
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
    for (const key of [
      'description',
      'text',
      'query',
      'content',
      'caption',
      'message',
      'image_prompt',
      'imagePrompt',
    ] as const) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) {
        args.prompt = value.trim()
        break
      }
    }
  }

  if ((typeof args.prompt !== 'string' || !args.prompt.trim()) && lastUserMessage?.trim()) {
    args.prompt = lastUserMessage.trim()
  }

  const prompt = args.prompt
  if (typeof prompt !== 'string' || !lastUserMessage?.trim()) return
  if (VARIATION_INTENT_PATTERN.test(prompt)) return
  if (!VARIATION_INTENT_PATTERN.test(lastUserMessage)) return
  args.prompt = lastUserMessage.trim()
}

/**
 * Fills required `search_online` fields the model often omits (`toolTitle`)
 * and remaps common query aliases so AJV validation does not fail open.
 */
function enrichSearchOnlineArgs(args: Record<string, unknown>): void {
  if (typeof args.query !== 'string' || !args.query.trim()) {
    for (const key of ['q', 'search', 'searchQuery', 'text'] as const) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) {
        args.query = value.trim()
        break
      }
    }
  }

  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (query && (typeof args.toolTitle !== 'string' || !args.toolTitle.trim())) {
    args.toolTitle = query.length > 48 ? `${query.slice(0, 45)}...` : query
  }
}

/**
 * Runs a registered Mothership/copilot server tool handler in-process.
 * Heavy handler registration loads on first call only.
 */
export async function executeMothershipDelegatedTool(
  toolName: MothershipDelegatedToolName,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const serverToolNames = await ensureCopilotToolRuntime()

  const enrichedArgs = { ...args }
  let workflowId = resolveWorkflowIdForDelegatedTool(enrichedArgs, ctx)

  const languageError = enforceLocalCopilotSandboxLanguages(toolName, enrichedArgs)
  if (languageError) return languageError

  const officeSandboxError = rejectOfficeFileViaSandbox(toolName, enrichedArgs)
  if (officeSandboxError) return officeSandboxError

  if (!workflowId && ctx.workspaceId) {
    workflowId = await resolveWorkflowIdFromDatabase(ctx.workspaceId, enrichedArgs)
  }

  if (workflowId) {
    enrichedArgs.workflowId = workflowId
  } else if (WORKFLOW_SCOPED_DELEGATED_TOOLS.has(toolName)) {
    logger.warn('Delegated workflow tool missing workflowId', {
      toolName,
      workspaceId: ctx.workspaceId,
      workspaceWorkflowCount: ctx.structuredContext.workspaceWorkflows?.length ?? 0,
    })
    return {
      ...buildMissingWorkflowIdError(ctx.structuredContext),
      toolName,
    }
  }

  if (toolName === 'generate_image') {
    enrichGenerateImagePrompt(enrichedArgs, ctx.lastUserMessage)
  }

  if (toolName === 'search_online') {
    enrichSearchOnlineArgs(enrichedArgs)
  }

  if (toolName === 'create_file') {
    enrichCreateFileArgs(enrichedArgs)
    const imageReject = rejectCreateFileImageAsText(enrichedArgs)
    if (imageReject) {
      return {
        toolName,
        success: false,
        error: imageReject,
        result: { success: false, message: imageReject },
      }
    }
  }

  if (toolName === 'workspace_file') {
    enrichWorkspaceFileArgs(enrichedArgs)
    const lookBefore = assertWorkspaceFileLookBeforeWrite({
      args: enrichedArgs,
      readVfsPaths: ctx.readVfsPaths,
    })
    if (!lookBefore.ok) {
      return {
        toolName,
        success: false,
        error: lookBefore.error,
        result: { success: false, message: lookBefore.error },
      }
    }
  }

  if (toolName === 'edit_content') {
    enrichEditContentArgs(enrichedArgs)
  }

  // Arena always runs server-registry tools in-process via ServerToolAdapter.
  // Never send go-catalogued tools (e.g. search_online) through shared
  // executeTool — that path treats route:'go' as an app-tool lookup and
  // throws "Built-in tool not found". Map Arena leaf names (create_file, …)
  // onto Cloud registry ids (create_empty_file, …) before the membership check.
  //
  // File pipeline tools ALWAYS take this path — falling through to executeTool
  // with the Arena name yields "Tool not found: create_file" and the model
  // invents "office tools unavailable" → python-pptx sandbox loops.
  const serverToolName = toServerRegistryToolName(toolName)
  if (isArenaFilePipelineTool(toolName) || serverToolNames.has(serverToolName)) {
    if (isArenaFilePipelineTool(toolName) && !serverToolNames.has(serverToolName)) {
      const message = `${toolName} is unavailable in this process (server handler "${serverToolName}" is not registered). Restart the Arena app — do not use manage_sandbox or python-pptx.`
      return {
        toolName,
        success: false,
        error: message,
        result: { success: false, message },
      }
    }
    const result = await executeCopilotServerTool(toolName, enrichedArgs, ctx, workflowId)
    if (!result.success) {
      logger.warn('Copilot server tool failed', { toolName, serverToolName, error: result.error })
    }
    if (toolName === 'list_integration_tools' && result.success) {
      const { adaptListIntegrationToolsForLocal } = await import(
        '@/local-copilot/lib/tools/adapt-list-integration-tools'
      )
      return withBillingFromResult({
        ...result,
        result: adaptListIntegrationToolsForLocal(result.result),
      })
    }
    if (toolName === 'read') {
      return withBillingFromResult(await finalizeLocalReadResult(enrichedArgs, ctx, result))
    }
    return withBillingFromResult(result)
  }

  // Remaining delegated tools are sim-/go-routed with registered handlers
  // (run_workflow, list_integration_tools, function_execute → run_function,
  // materialize_file → save_upload, …).
  logger.info('Delegating Mothership tool', {
    toolName,
    serverToolName,
    workflowId: workflowId ?? null,
    hasBillingAttribution: Boolean(ctx.billingAttribution),
    billingEntityType: ctx.billingAttribution?.billingEntity.type ?? null,
    workspaceId: ctx.workspaceId,
  })
  const { executeTool } = await import('@/lib/mothership/tool-executor/executor')
  // Always execute under the Cloud/handler id (run_function, save_upload, …)
  // while keeping the Arena leaf name on the tool result for the model.
  let result = await executeTool(
    serverToolName,
    enrichedArgs,
    toCopilotServerToolContext(ctx, workflowId)
  )

  // Cloud mothership post-processes function_execute with maybeWriteOutputToFile
  // so path-only `outputs.files` land in the workspace VFS. Arena must do the
  // same — otherwise Claude sees a sandbox "success" while files/ never updates.
  if (toolName === 'function_execute' && result.success) {
    const { maybeWriteOutputToFile } = await import('@/lib/mothership/request/tools/files')
    const written = await maybeWriteOutputToFile(
      toolName,
      enrichedArgs,
      { success: result.success, output: result.output, error: result.error },
      {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        workflowId: workflowId ?? ctx.workflowId ?? '',
        userPermission: ctx.userPermission ?? 'write',
        chatId: ctx.chatId,
        messageId: ctx.messageId,
        abortSignal: ctx.abortSignal,
        ...(ctx.billingAttribution ? { billingAttribution: ctx.billingAttribution } : {}),
        ...(ctx.resolvedSecretTraceRegistry
          ? { resolvedSecretTraceRegistry: ctx.resolvedSecretTraceRegistry }
          : {}),
      }
    )
    result = {
      success: written.success,
      output: written.output,
      error: written.error,
      resources: written.resources ?? result.resources,
    }
  }

  if (!result.success) {
    logger.warn('Delegated Mothership tool failed', {
      toolName,
      workflowId: workflowId ?? null,
      error: result.error,
    })
  }

  if (toolName === 'list_integration_tools' && result.success) {
    const { adaptListIntegrationToolsForLocal } = await import(
      '@/local-copilot/lib/tools/adapt-list-integration-tools'
    )
    return withBillingFromResult({
      toolName,
      success: result.success,
      result: adaptListIntegrationToolsForLocal(
        result.output ?? (result.error ? { error: result.error } : {})
      ),
      error: result.error,
      resources: result.resources,
    })
  }

  const delegatedResult: ToolExecutionResult = {
    toolName,
    success: result.success,
    result:
      result.output ??
      (result.error
        ? { error: result.error }
        : result.success
          ? { success: true, message: `${toolName} completed`, toolName }
          : {}),
    error: result.error,
    resources: result.resources,
  }

  if (toolName === 'read') {
    return withBillingFromResult(await finalizeLocalReadResult(enrichedArgs, ctx, delegatedResult))
  }

  return withBillingFromResult(delegatedResult)
}

function withBillingFromResult(result: ToolExecutionResult): ToolExecutionResult {
  if (result.billing) return result
  const billing = extractLocalToolBillingMetadata(result.result)
  return billing ? { ...result, billing } : result
}

/**
 * Local Copilot post-process for `read`: clamp mega lines on success, or recover
 * when shared vfs_read hard-fails on Arena-scale HTML — without changing shared VFS.
 */
async function finalizeLocalReadResult(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  result: ToolExecutionResult
): Promise<ToolExecutionResult> {
  if (result.success) {
    return clampSuccessfulReadResult(result)
  }
  if (!isOversizedVfsReadError(result.error)) {
    return result
  }
  const recovered = await recoverOversizedVfsReadForLocal(args, ctx)
  return recovered ?? result
}
