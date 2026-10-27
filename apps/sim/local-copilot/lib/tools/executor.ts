import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import type { WorkflowState } from '@sim/workflow-types/workflow'
import type { BillingAttributionSnapshot } from '@/lib/billing/core/billing-attribution'
import type { MothershipResource } from '@/lib/mothership/resources/types'
import { normalizeEditWorkflowArgs } from '@/lib/mothership/tools/server/workflow/edit-workflow/normalize-args'
import type { ResolvedSecretTraceRegistry } from '@/executor/utils/resolved-secret-trace-registry'
import type { LocalToolBillingMetadata } from '@/local-copilot/lib/billing/turn-cost-accumulator'
import { extractLocalToolBillingMetadata } from '@/local-copilot/lib/billing/turn-cost-accumulator'
import {
  LOAD_COPILOT_ARTIFACT_TOOL_NAME,
  loadArtifactFromRecord,
  loadArtifacts,
  truncateArtifactBodyForModel,
} from '@/local-copilot/lib/context/artifacts'
import { buildGetWorkflowContextResult } from '@/local-copilot/lib/context/context-budget'
import { reloadLocalCopilotWorkflowContext } from '@/local-copilot/lib/context/reload-workflow-context'
import { getLocalCopilotMemorySnapshot } from '@/local-copilot/lib/diagnostics'
import { generateWorkflowPatchFromRequest } from '@/local-copilot/lib/patches/generate'
import { validateWorkflowPatch, validateWorkflowState } from '@/local-copilot/lib/patches/validate'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import { getToolDefinition } from '@/local-copilot/lib/tools/definitions'
import { canonicalCreateFilePath } from '@/local-copilot/lib/tools/enrich-file-tool-args'
import {
  enrichLocalIntegrationToolParams,
  SEPARATE_DRAFT_RECIPIENTS_KEY,
} from '@/local-copilot/lib/tools/enrich-integration-params'
import { injectWorkspaceEnvApiKeyIfNeeded } from '@/local-copilot/lib/tools/inject-workspace-env-api-key'
import {
  executeMothershipDelegatedTool,
  isMothershipDelegatedTool,
  resolveWorkflowIdForDelegatedTool,
  resolveWorkflowIdFromDatabase,
} from '@/local-copilot/lib/tools/mothership-delegated-tools'
import { normalizeLocalEditConnections } from '@/local-copilot/lib/tools/normalize-edit-connections'
import {
  normalizeBlockIdsArgs,
  resolveBlockIdsArg,
} from '@/local-copilot/lib/tools/resolve-block-ids-arg'
import { resolveLocalCopilotToolName } from '@/local-copilot/lib/tools/resolve-tool-name-alias'
import { resolveWorkflowStateForLocalTool } from '@/local-copilot/lib/tools/resolve-workflow-state'
import {
  executeLoadUserSkill,
  LOAD_USER_SKILL_TOOL_NAME,
} from '@/local-copilot/lib/tools/user-skills'
import {
  runCreateWorkflowTool,
  runEditWorkflowTool,
} from '@/local-copilot/lib/tools/workflow-mutations'
import type { LocalCopilotStructuredContext, WorkflowPatch } from '@/local-copilot/lib/types'
import {
  buildEditWorkflowDryRunResult,
  shouldPreviewEditWorkflow,
} from '@/local-copilot/lib/writes/edit-preview'
import {
  buildIdempotencyKey,
  getIdempotentResult,
  rememberIdempotentResult,
  toolSupportsIdempotency,
} from '@/local-copilot/lib/writes/idempotency'
import {
  assertEditWorkflowLookBeforeWrite,
  assertInvokeLookBeforeWrite,
  normalizeWorkspaceFileReadPath,
} from '@/local-copilot/lib/writes/look-before-write'
import { pinToolArgsToWorkspace } from '@/local-copilot/lib/writes/pin-ids'
import { assertExpectedRevision } from '@/local-copilot/lib/writes/revision'
import {
  type CreatedWorkflowThisTurn,
  createTurnMutations,
  type LocalCopilotTurnMutations,
  rememberCreatedFile,
  rememberCreatedWorkflow,
  reuseCreatedFile,
  reuseCreatedWorkflow,
} from '@/local-copilot/lib/writes/turn-mutations'
import {
  assertWorkflowWritableInWorkspace,
  loadWorkflowRevision,
} from '@/local-copilot/lib/writes/workflow-access'

const logger = createLogger('LocalCopilotToolExecutor')

let handlersRegistered = false

async function ensureHandlersReady() {
  if (handlersRegistered) return
  const loadStartedAt = Date.now()
  logger.info('Arena Copilot ensuring handlers registered', {
    memory: getLocalCopilotMemorySnapshot(),
  })
  const { ensureHandlersRegistered } = await import(
    '@/lib/mothership/tool-executor/register-handlers'
  )
  ensureHandlersRegistered()
  handlersRegistered = true
  logger.info('Arena Copilot handlers ready', {
    durationMs: Date.now() - loadStartedAt,
    memory: getLocalCopilotMemorySnapshot(),
  })
}

export interface ToolExecutionContext {
  userId: string
  workspaceId: string
  workflowId?: string
  chatId?: string
  /** Scopes workspace_file → edit_content intents for this user turn. */
  messageId?: string
  abortSignal?: AbortSignal
  userPermission?: string
  /**
   * Frozen workspace payer snapshot from mothership admission. Required for
   * delegated workflow runs (`run_workflow`, etc.) that call `executeWorkflow`.
   */
  billingAttribution?: BillingAttributionSnapshot
  structuredContext: LocalCopilotStructuredContext
  selectedBlockId?: string
  /** Latest user message — used to preserve variation counts for generate_image. */
  lastUserMessage?: string
  /** Optional live-status callback for long-running tools (fire-and-forget). */
  onProgress?: (message: string) => void
  /**
   * Per-turn cache of get_blocks_metadata results keyed by block type id.
   * Avoids repeated identical/overlapping metadata fetches in one agent turn.
   */
  blocksMetadataByType?: Map<string, unknown>
  /** CAS token from workflow.updatedAt for the active workflow. */
  workflowRevision?: string
  /** Turn-scoped idempotency cache for create/deploy/invoke. */
  mutationIdempotency?: Map<string, ToolExecutionResult>
  /** Integration tool ids returned by list_integration_tools this turn. */
  listedIntegrationToolIds?: Set<string>
  /**
   * Canonical `files/...` paths successfully `read` this turn (without `/content`).
   * Full-replace HTML/text updates must follow a read of the same file.
   */
  readVfsPaths?: Set<string>
  /** Workflow ids created earlier in this turn (membership bypass until refresh). */
  allowedWorkflowIds?: Set<string>
  /** Active tool_use id for idempotency keying. */
  activeToolCallId?: string
  /**
   * Scopes workspace_file → edit_content Redis intents. File Agent passes seed
   * this with the specialist tool-call id (same id as the subagent span);
   * parent-lane writes fall back to the `workspace_file` call id.
   */
  fileIntentChannelId?: string
  /** Turn-scoped store for oversized tool-result artifacts. */
  artifactStore?: import('@/local-copilot/lib/context/artifacts').ArtifactStore
  /**
   * Nested so `{ ...toolCtx }` copies still share create reuse across parent
   * and parallel specialists.
   */
  turnMutations?: LocalCopilotTurnMutations
  /**
   * Loaded workspace skill bodies for this turn. Specialists inject this as a
   * system message so they follow the same playbook as the parent.
   */
  relevantSkillGuidance?: string
  /** First successful create_workflow this turn — later creates must reuse it. */
  createdWorkflowThisTurn?: {
    workflowId: string
    startBlockId?: string
    workflowName?: string
  }
  /**
   * Turn-scoped model-egress secret registry. Required by server tools that
   * project queries/results through secret provenance (e.g. knowledge_base query).
   */
  resolvedSecretTraceRegistry?: ResolvedSecretTraceRegistry
}

export interface ToolExecutionResult {
  toolName: string
  success: boolean
  result: unknown
  error?: string
  patch?: WorkflowPatch
  /** Resources to open in the mothership panel (e.g. open_resource, generate_image). */
  resources?: MothershipResource[]
  /** Set when create_workflow succeeds — subsequent tools use this workflow. */
  createdWorkflowId?: string
  /**
   * Trusted billing metadata for Local turn aggregation. Prefer this over
   * scraping arbitrary user-facing tool output.
   */
  billing?: LocalToolBillingMetadata
}

async function runLoadUserSkill(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  try {
    const { assertPermissionsAllowed } = await import('@/ee/access-control/utils/permission-check')
    await assertPermissionsAllowed({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      toolKind: 'skill',
    })
  } catch (error) {
    const message = getErrorMessage(error, 'Skills are not allowed')
    const { LOCAL_OPS_COUNTERS, recordLocalOpsEvent } = await import(
      '@/local-copilot/lib/ops/metrics'
    )
    recordLocalOpsEvent({
      counter: LOCAL_OPS_COUNTERS.authDenied,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      workflowId: ctx.workflowId,
      chatId: ctx.chatId,
      metadata: { toolName: LOAD_USER_SKILL_TOOL_NAME },
    })
    return {
      toolName: LOAD_USER_SKILL_TOOL_NAME,
      success: false,
      error: message,
      result: { error: message },
    }
  }

  const skillName = typeof args.skill_name === 'string' ? args.skill_name.trim() : ''
  const loaded = await executeLoadUserSkill(skillName, ctx.workspaceId)
  if (!loaded.success) {
    return {
      toolName: LOAD_USER_SKILL_TOOL_NAME,
      success: false,
      error: loaded.error,
      result: { error: loaded.error },
    }
  }

  return {
    toolName: LOAD_USER_SKILL_TOOL_NAME,
    success: true,
    result: { content: loaded.content },
  }
}

function reusedWorkflowResult(existing: CreatedWorkflowThisTurn): ToolExecutionResult {
  return {
    toolName: 'create_workflow',
    success: true,
    createdWorkflowId: existing.workflowId,
    resources: [
      {
        type: 'workflow',
        id: existing.workflowId,
        title: existing.workflowName?.trim() || 'Workflow',
      },
    ],
    result: {
      success: true,
      alreadyCreatedThisTurn: true,
      workflowId: existing.workflowId,
      startBlockId: existing.startBlockId,
      workflowName: existing.workflowName,
      message:
        'Workflow already created this turn. Do not create another. Call get_blocks_metadata once if needed, then edit_workflow to add blocks.',
    },
  }
}

async function runCreateWorkflowOnce(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const mutation = await runCreateWorkflowTool(args, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workflowId: ctx.workflowId,
    chatId: ctx.chatId,
    abortSignal: ctx.abortSignal,
    activeToolCallId: ctx.activeToolCallId,
  })
  const output = mutation.output as Record<string, unknown> | undefined
  const createdWorkflowId = typeof output?.workflowId === 'string' ? output.workflowId : undefined
  if (createdWorkflowId) {
    ctx.allowedWorkflowIds?.add(createdWorkflowId)
    ctx.workflowId = createdWorkflowId
    const created = {
      workflowId: createdWorkflowId,
      ...(typeof output?.startBlockId === 'string' && output.startBlockId.trim()
        ? { startBlockId: output.startBlockId.trim() }
        : {}),
      ...(typeof output?.workflowName === 'string' && output.workflowName.trim()
        ? { workflowName: output.workflowName.trim() }
        : {}),
    }
    ctx.createdWorkflowThisTurn = created
    const turnMutations = ctx.turnMutations ?? createTurnMutations()
    ctx.turnMutations = turnMutations
    rememberCreatedWorkflow(turnMutations, created)
  }
  const created: ToolExecutionResult = {
    toolName: 'create_workflow',
    success: mutation.success,
    result: mutation.output ?? { error: mutation.error },
    error: mutation.error,
    ...(createdWorkflowId
      ? {
          createdWorkflowId,
          resources: [
            {
              type: 'workflow',
              id: createdWorkflowId,
              title:
                (typeof output?.workflowName === 'string' && output.workflowName.trim()) ||
                'Workflow',
            },
          ],
        }
      : {}),
  }
  if (created.success) {
    rememberIdempotentResult(
      ctx.mutationIdempotency ?? new Map(),
      buildIdempotencyKey('create_workflow', args, ctx.activeToolCallId),
      created
    )
  }
  return created
}

export async function executeLocalCopilotTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  try {
    return await executeLocalCopilotToolInner(toolName, args, ctx)
  } catch (error) {
    const message = getErrorMessage(error, 'Tool execution failed')
    logger.error('Arena Copilot tool threw', { toolName, error: message })
    return {
      toolName,
      success: false,
      error: message,
      result: { error: message },
    }
  }
}

async function executeLocalCopilotToolInner(
  requestedToolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const resolvedName = resolveLocalCopilotToolName(requestedToolName)
  if (resolvedName.kind === 'unsupported') {
    return {
      toolName: requestedToolName,
      success: false,
      error: resolvedName.message,
      result: { error: resolvedName.message },
    }
  }
  const toolName = resolvedName.name

  args = pinToolArgsToWorkspace(args, ctx.workspaceId)
  ctx.mutationIdempotency ??= new Map()
  ctx.listedIntegrationToolIds ??= new Set()
  ctx.readVfsPaths ??= new Set()
  ctx.allowedWorkflowIds ??= new Set()
  ctx.turnMutations ??= createTurnMutations()

  if (toolSupportsIdempotency(toolName)) {
    const key = buildIdempotencyKey(toolName, args, ctx.activeToolCallId)
    const cached = getIdempotentResult(ctx.mutationIdempotency, key)
    if (cached) return cached
  }

  // load_user_skill is registered dynamically per workspace when skills exist.
  if (toolName === LOAD_USER_SKILL_TOOL_NAME) {
    logger.info('Executing Arena Copilot tool', { toolName, workflowId: ctx.workflowId })
    return runLoadUserSkill(args, ctx)
  }

  // Cloud agents call load_integration_tool after listing; Arena uses invoke_integration_tool.
  if (toolName === 'load_integration_tool') {
    const message =
      'load_integration_tool is Cloud-only. Call list_integration_tools then invoke_integration_tool({ toolId: "<id>", params: { ... } }) with the listed tool id (e.g. gmail_draft_v2).'
    return {
      toolName,
      success: false,
      error: message,
      result: { error: message },
    }
  }

  const definition = getToolDefinition(toolName)
  if (!definition) {
    throw new Error(`Unknown tool: ${toolName}`)
  }

  // Normalize alias shapes before any handler path (direct call or invoke redirect).
  if (toolName === 'get_blocks_metadata') {
    args = normalizeBlockIdsArgs(args)
  }

  logger.info('Executing Arena Copilot tool', { toolName, workflowId: ctx.workflowId })

  if (isMothershipDelegatedTool(toolName)) {
    if (toolName === 'create_file') {
      const existingFile = reuseCreatedFile<ToolExecutionResult>(
        ctx.turnMutations,
        canonicalCreateFilePath(args)
      )
      if (existingFile) {
        return {
          ...existingFile,
          result:
            existingFile.result && typeof existingFile.result === 'object'
              ? {
                  ...(existingFile.result as Record<string, unknown>),
                  alreadyCreatedThisTurn: true,
                  message:
                    'File already created this turn at this path. Do not create_file again — edit the existing file instead.',
                }
              : existingFile.result,
        }
      }
    }
    const delegated = attachToolBilling(await executeMothershipDelegatedTool(toolName, args, ctx))
    if (toolName === 'list_integration_tools' && delegated.success) {
      rememberListedIntegrationTools(ctx, delegated.result)
    }
    if (toolName === 'read' && delegated.success) {
      rememberReadVfsPath(ctx, args)
    }
    if (toolName === 'create_file' && delegated.success && ctx.turnMutations) {
      rememberCreatedFile(ctx.turnMutations, canonicalCreateFilePath(args), {
        ...delegated,
      })
    }
    if (toolSupportsIdempotency(toolName) && delegated.success) {
      rememberIdempotentResult(
        ctx.mutationIdempotency,
        buildIdempotencyKey(toolName, args, ctx.activeToolCallId),
        delegated
      )
    }
    return delegated
  }

  switch (toolName) {
    case 'create_workflow': {
      const existing = reuseCreatedWorkflow(ctx.turnMutations) ?? ctx.createdWorkflowThisTurn
      if (existing) {
        return reusedWorkflowResult(existing)
      }

      const inFlight = ctx.turnMutations?.createWorkflowInFlight as
        | Promise<ToolExecutionResult>
        | undefined
      if (inFlight) {
        const raced = await inFlight
        const after = reuseCreatedWorkflow(ctx.turnMutations) ?? ctx.createdWorkflowThisTurn
        return after ? reusedWorkflowResult(after) : raced
      }

      const pending = runCreateWorkflowOnce(args, ctx)
      if (ctx.turnMutations) {
        ctx.turnMutations.createWorkflowInFlight = pending
      }
      try {
        return await pending
      } finally {
        if (ctx.turnMutations?.createWorkflowInFlight === pending) {
          ctx.turnMutations.createWorkflowInFlight = undefined
        }
      }
    }

    case 'edit_workflow': {
      const enrichedArgs = normalizeEditWorkflowArgs(await enrichEditWorkflowArgs(args, ctx))
      const operations = Array.isArray(enrichedArgs.operations) ? enrichedArgs.operations : []
      if (operations.length === 0) {
        return {
          toolName,
          success: false,
          error:
            'operations are required and must be a non-empty array — pass { operations: [{ block_id, operation_type, params }] }',
          result: {
            success: false,
            error:
              'operations are required and must be a non-empty array — pass { operations: [{ block_id, operation_type, params }] }',
          },
        }
      }

      enrichedArgs.operations = normalizeLocalEditConnections(operations, {
        blocks: ctx.structuredContext.workflow?.blocks,
        edges: ctx.structuredContext.workflow?.edges,
        availableBlocks: ctx.structuredContext.availableBlocks,
      })

      const lookBefore = assertEditWorkflowLookBeforeWrite({
        operations: enrichedArgs.operations,
        blocksMetadataByType: ctx.blocksMetadataByType,
      })
      if (!lookBefore.ok) {
        return {
          toolName,
          success: false,
          error: lookBefore.error,
          result: { success: false, error: lookBefore.error },
        }
      }

      const targetWorkflowId =
        (typeof enrichedArgs.workflowId === 'string' && enrichedArgs.workflowId.trim()) ||
        ctx.workflowId
      if (!targetWorkflowId) {
        const workflows = ctx.structuredContext.workspaceWorkflows ?? []
        const error =
          workflows.length === 0
            ? 'workflowId is required — create a workflow first with create_workflow'
            : `workflowId is required on home chat. Pass workflowId from workspaceWorkflows. Available: ${workflows
                .map((workflow) => `"${workflow.name}" (${workflow.id})`)
                .join(', ')}`
        return {
          toolName,
          success: false,
          error,
          result: {
            success: false,
            error,
            availableWorkflows: workflows.map((workflow) => ({
              id: workflow.id,
              name: workflow.name,
            })),
          },
        }
      }

      if (shouldPreviewEditWorkflow(enrichedArgs)) {
        return {
          toolName,
          success: true,
          result: buildEditWorkflowDryRunResult({
            operations: Array.isArray(enrichedArgs.operations)
              ? enrichedArgs.operations
              : operations,
            workflowId: targetWorkflowId,
          }),
        }
      }

      const access = await assertWorkflowWritableInWorkspace({
        workflowId: targetWorkflowId,
        workspaceId: ctx.workspaceId,
        allowedWorkflowIds: ctx.allowedWorkflowIds,
      })
      if (!access.ok) {
        return {
          toolName,
          success: false,
          error: access.error,
          result: { success: false, error: access.error },
        }
      }

      const expectedRevision =
        (typeof enrichedArgs.expectedRevision === 'string' &&
          enrichedArgs.expectedRevision.trim()) ||
        ctx.workflowRevision
      const revisionCheck = assertExpectedRevision({
        expectedRevision,
        currentRevision: access.revision || undefined,
      })
      if (!revisionCheck.ok) {
        // Sync turn state to the live revision so a follow-up get_workflow_context /
        // edit_workflow can succeed. Without this, CAS stays stuck on the turn-start token.
        if (access.revision) {
          ctx.workflowRevision = access.revision
        }
        const refreshed = await reloadLocalCopilotWorkflowContext({
          previous: ctx.structuredContext,
          workflowId: targetWorkflowId,
        })
        if (refreshed.workflow) {
          ctx.structuredContext = refreshed
          ctx.workflowId = refreshed.workflow.id
        }
        return {
          toolName,
          success: false,
          error: revisionCheck.error,
          result: {
            success: false,
            error: revisionCheck.error,
            currentRevision: access.revision || ctx.workflowRevision,
            hint: 'Workflow was reloaded into this turn. Call get_workflow_context (or get_blocks_metadata for new types), then edit_workflow again.',
          },
        }
      }

      const mutation = await runEditWorkflowTool(enrichedArgs, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        workflowId: ctx.workflowId,
        chatId: ctx.chatId,
        abortSignal: ctx.abortSignal,
        activeToolCallId: ctx.activeToolCallId,
      })

      if (mutation.success) {
        const next = await assertWorkflowWritableInWorkspace({
          workflowId: targetWorkflowId,
          workspaceId: ctx.workspaceId,
          allowedWorkflowIds: ctx.allowedWorkflowIds,
        })
        if (next.ok && next.revision) {
          ctx.workflowRevision = next.revision
        }
      }

      const output =
        mutation.output && typeof mutation.output === 'object'
          ? {
              ...(mutation.output as Record<string, unknown>),
              workflowId: targetWorkflowId,
              ...(ctx.workflowRevision ? { revision: ctx.workflowRevision } : {}),
            }
          : mutation.output

      return {
        toolName,
        success: mutation.success,
        result: output ?? { error: mutation.error },
        error: mutation.error,
      }
    }

    case 'get_workflow_context': {
      const blockIds = Array.isArray(args.blockIds)
        ? args.blockIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : []
      const blockNames = Array.isArray(args.blockNames)
        ? args.blockNames.filter(
            (name): name is string => typeof name === 'string' && name.trim().length > 0
          )
        : []

      // Always reload — this tool is the recovery path after stale-revision
      // edit_workflow failures. Returning the turn cache would leave workflowRevision
      // stuck and make every retry fail the same CAS check.
      const resolved = await resolveWorkflowStateForLocalTool(ctx, args, { forceReload: true })
      if (!resolved.ok) {
        return {
          toolName,
          success: false,
          error: resolved.error,
          result: { workflow: null, error: resolved.error },
        }
      }

      return {
        toolName,
        success: true,
        result: {
          ...buildGetWorkflowContextResult(ctx.structuredContext, { blockIds, blockNames }),
          ...(ctx.workflowRevision ? { revision: ctx.workflowRevision } : {}),
        },
      }
    }

    case LOAD_COPILOT_ARTIFACT_TOOL_NAME:
    case 'load_copilot_artifact': {
      const artifactId = typeof args.artifactId === 'string' ? args.artifactId.trim() : ''
      if (!artifactId) {
        return {
          toolName,
          success: false,
          error: 'artifactId is required',
          result: { error: 'artifactId is required' },
        }
      }

      const fromTurn = ctx.artifactStore?.artifacts.get(artifactId)
      if (fromTurn) {
        return {
          toolName,
          success: true,
          result: truncateArtifactBodyForModel(fromTurn.body),
        }
      }

      if (!ctx.chatId) {
        return {
          toolName,
          success: false,
          error: 'Artifact not found in this turn and no chatId for durable lookup',
          result: { error: 'Artifact not found' },
        }
      }

      const persisted = await loadArtifacts(ctx.chatId, ctx.userId)
      const artifact = persisted.get(artifactId)
      if (!artifact) {
        const legacy = loadArtifactFromRecord(Object.fromEntries(persisted), artifactId)
        if (!legacy) {
          return {
            toolName,
            success: false,
            error: `Unknown artifactId: ${artifactId}`,
            result: { error: `Unknown artifactId: ${artifactId}` },
          }
        }
        return {
          toolName,
          success: true,
          result: truncateArtifactBodyForModel(legacy.body),
        }
      }
      return {
        toolName,
        success: true,
        result: truncateArtifactBodyForModel(artifact.body),
      }
    }

    case 'get_available_blocks': {
      const category =
        typeof args.category === 'string' && args.category.trim() ? args.category.trim() : undefined
      const blocks = ctx.structuredContext.availableBlocks.filter(
        (block) => !category || block.category === category
      )
      return { toolName, success: true, result: { blocks } }
    }

    case 'get_blocks_metadata': {
      const blockIds = resolveBlockIdsArg(args)
      if (blockIds.length === 0) {
        return {
          toolName,
          success: false,
          error:
            'blockIds is required — pass { blockIds: ["agent","start_trigger"] } (object with blockIds array, not a bare array).',
          result: {},
        }
      }

      const cache = ctx.blocksMetadataByType ?? new Map<string, unknown>()
      ctx.blocksMetadataByType = cache
      const normalizedIds = [
        ...new Set(blockIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ]
      const missingIds = normalizedIds.filter((id) => !cache.has(id.toLowerCase()))

      if (missingIds.length === 0) {
        const metadata: Record<string, unknown> = {}
        for (const id of normalizedIds) {
          metadata[id] = cache.get(id.toLowerCase())
        }
        return {
          toolName,
          success: true,
          result: {
            metadata,
            cached: true,
            hint: 'Reused block metadata from earlier this turn. Do not call get_blocks_metadata again for these types.',
          },
        }
      }

      await ensureHandlersReady()
      const { createServerToolHandler } = await import(
        '@/lib/mothership/tools/registry/server-tool-adapter'
      )
      const handler = createServerToolHandler('get_blocks_metadata')
      const metadataResult = await handler(
        { blockIds: missingIds },
        toCopilotServerToolContext(ctx)
      )

      if (
        metadataResult.success &&
        metadataResult.output &&
        typeof metadataResult.output === 'object'
      ) {
        const output = metadataResult.output as Record<string, unknown>
        const fetched =
          output.metadata && typeof output.metadata === 'object'
            ? (output.metadata as Record<string, unknown>)
            : output
        for (const [key, value] of Object.entries(fetched)) {
          cache.set(key.toLowerCase(), value)
        }
      }

      const metadata: Record<string, unknown> = {}
      for (const id of normalizedIds) {
        const cached = cache.get(id.toLowerCase())
        if (cached !== undefined) metadata[id] = cached
      }

      const unresolvedIds = normalizedIds.filter((id) => !(id in metadata))
      return {
        toolName,
        success: metadataResult.success,
        result: metadataResult.success
          ? {
              metadata,
              ...(missingIds.length < normalizedIds.length ? { partiallyCached: true } : {}),
              ...(unresolvedIds.length > 0
                ? {
                    unresolvedBlockIds: unresolvedIds,
                    hint: `No metadata for [${unresolvedIds.join(', ')}]. Those may be sunset/legacy ids — retry with current successors (e.g. image_generator → image_generator_v2). To attach Image/Chart/Exa to an Agent, edit that Agent's tools array — do not add them as canvas blocks.`,
                  }
                : {
                    hint: 'Call get_blocks_metadata only once with every block type you need. Do not re-fetch these types. To attach tools to an Agent, edit Agent.tools — do not add tool types as canvas blocks.',
                  }),
            }
          : (metadataResult.output ??
            (metadataResult.error ? { error: metadataResult.error } : {})),
        error: metadataResult.error,
      }
    }

    case 'get_available_integrations':
      return {
        toolName,
        success: true,
        result: {
          integrations: ctx.structuredContext.availableIntegrations,
          connectedIntegrations: ctx.structuredContext.connectedIntegrations,
          envVariables: ctx.structuredContext.envVariables,
          hostedKeysAvailable: ctx.structuredContext.hostedKeysAvailable,
        },
      }

    case 'invoke_integration_tool': {
      const finishInvoke = (result: ToolExecutionResult): ToolExecutionResult => {
        if (result.success) {
          rememberIdempotentResult(
            ctx.mutationIdempotency!,
            buildIdempotencyKey(toolName, args, ctx.activeToolCallId),
            result
          )
        }
        return result
      }

      const toolId =
        typeof args.toolId === 'string'
          ? args.toolId.trim()
          : typeof args.tool_id === 'string'
            ? args.tool_id.trim()
            : ''
      if (!toolId) {
        return {
          toolName,
          success: false,
          error: 'toolId is required — call list_integration_tools first',
          result: {},
        }
      }

      const resolvedInvoke = resolveLocalCopilotToolName(toolId)
      if (resolvedInvoke.kind === 'unsupported') {
        return {
          toolName,
          success: false,
          error: resolvedInvoke.message,
          result: { toolId, output: { error: resolvedInvoke.message } },
        }
      }
      const resolvedToolId = resolvedInvoke.name

      const knownToolIds = new Set<string>()
      if (isMothershipDelegatedTool(resolvedToolId) || getToolDefinition(resolvedToolId)) {
        knownToolIds.add(resolvedToolId)
      }
      const invokeGate = assertInvokeLookBeforeWrite({
        toolId: resolvedToolId,
        listedIntegrationToolIds: ctx.listedIntegrationToolIds,
        knownToolIds,
      })
      if (!invokeGate.ok) {
        return {
          toolName,
          success: false,
          error: invokeGate.error,
          result: { toolId, output: { error: invokeGate.error } },
        }
      }

      const rawParams =
        args.params && typeof args.params === 'object' && !Array.isArray(args.params)
          ? (args.params as Record<string, unknown>)
          : { ...args }

      // Model sometimes passes Arena/mothership tool ids here (e.g. search_online,
      // get_blocks_metadata, edit_workflow). Route those through the local executor
      // instead of shared executeTool → @/tools ("Built-in tool not found").
      if (resolvedToolId === 'invoke_integration_tool') {
        return {
          toolName,
          success: false,
          error: 'invoke_integration_tool cannot nest itself — pass a concrete toolId.',
          result: {},
        }
      }

      if (isMothershipDelegatedTool(resolvedToolId) || getToolDefinition(resolvedToolId)) {
        const redirected = await executeLocalCopilotTool(resolvedToolId, rawParams, ctx)
        return finishInvoke(
          attachToolBilling({
            toolName,
            success: redirected.success,
            result: {
              toolId,
              output: redirected.result ?? (redirected.error ? { error: redirected.error } : {}),
            },
            error: redirected.error,
            resources: redirected.resources,
            ...(redirected.billing ? { billing: redirected.billing } : {}),
          })
        )
      }

      await ensureHandlersReady()
      const { hasHandler } = await import('@/lib/mothership/tool-executor/executor')
      if (hasHandler(toolId)) {
        const { createServerToolHandler } = await import(
          '@/lib/mothership/tools/registry/server-tool-adapter'
        )
        const handler = createServerToolHandler(toolId)
        const normalizedParams =
          toolId === 'get_blocks_metadata'
            ? { ...rawParams, blockIds: resolveBlockIdsArg(rawParams) }
            : rawParams
        if (
          toolId === 'get_blocks_metadata' &&
          (!Array.isArray(normalizedParams.blockIds) || normalizedParams.blockIds.length === 0)
        ) {
          return {
            toolName,
            success: false,
            error:
              'blockIds is required — pass { blockIds: ["agent","start_trigger"] } (object with blockIds array).',
            result: { toolId, output: { error: 'blockIds is required' } },
          }
        }
        const serverResult = await handler(normalizedParams, toCopilotServerToolContext(ctx))
        return attachToolBilling({
          toolName,
          success: serverResult.success,
          result: {
            toolId,
            output:
              serverResult.output ?? (serverResult.error ? { error: serverResult.error } : {}),
          },
          error: serverResult.error,
        })
      }

      let params = enrichLocalIntegrationToolParams(
        toolId,
        rawParams,
        ctx.structuredContext.connectedIntegrations
      )
      params = await injectWorkspaceEnvApiKeyIfNeeded(toolId, params, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      })

      await ensureHandlersReady()
      const { executeTool: executeCopilotRegistryTool } = await import(
        '@/lib/mothership/tool-executor/executor'
      )

      const executionContext = {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        workflowId: ctx.workflowId ?? '',
        chatId: ctx.chatId,
        abortSignal: ctx.abortSignal,
        copilotToolExecution: true,
        userPermission: ctx.userPermission,
        ...(ctx.activeToolCallId?.trim() ? { toolCallId: ctx.activeToolCallId.trim() } : {}),
      }

      const separateRecipients = params[SEPARATE_DRAFT_RECIPIENTS_KEY]
      if (Array.isArray(separateRecipients) && separateRecipients.length > 1) {
        const drafts: Array<{ to: string; success: boolean; output: unknown; error?: string }> = []
        for (const recipient of separateRecipients) {
          if (typeof recipient !== 'string' || !recipient.trim()) continue
          const { [SEPARATE_DRAFT_RECIPIENTS_KEY]: _ignored, ...perRecipient } = params
          const draftResult = await executeCopilotRegistryTool(
            toolId,
            { ...perRecipient, to: recipient.trim() },
            executionContext
          )
          drafts.push({
            to: recipient.trim(),
            success: draftResult.success,
            output: draftResult.output ?? { error: draftResult.error },
            ...(draftResult.error ? { error: draftResult.error } : {}),
          })
        }

        const allSucceeded = drafts.length > 0 && drafts.every((draft) => draft.success)
        return finishInvoke({
          toolName,
          success: allSucceeded,
          result: {
            toolId,
            separateDrafts: true,
            drafts,
            output: {
              content: allSucceeded
                ? `Created ${drafts.length} separate drafts`
                : 'One or more separate drafts failed',
              drafts,
            },
          },
          ...(allSucceeded
            ? {}
            : {
                error:
                  drafts.find((draft) => draft.error)?.error ?? 'Separate draft fan-out failed',
              }),
        })
      }

      const { [SEPARATE_DRAFT_RECIPIENTS_KEY]: _ignored, ...cleanParams } = params
      const integrationResult = await executeCopilotRegistryTool(
        toolId,
        cleanParams,
        executionContext
      )

      return finishInvoke(
        attachToolBilling({
          toolName,
          success: integrationResult.success,
          result: {
            toolId,
            output: integrationResult.output ?? { error: integrationResult.error },
          },
          error: integrationResult.error,
        })
      )
    }

    case 'validate_workflow': {
      const override =
        args.workflowJson &&
        typeof args.workflowJson === 'object' &&
        !Array.isArray(args.workflowJson)
          ? (args.workflowJson as Partial<WorkflowState>)
          : undefined

      let state: Partial<WorkflowState>
      let resolvedWorkflowId: string | undefined
      if (override?.blocks) {
        state = override
      } else {
        const resolved = await resolveWorkflowStateForLocalTool(ctx, args)
        if (!resolved.ok) {
          return {
            toolName,
            success: false,
            error: resolved.error,
            result: { error: resolved.error },
          }
        }
        state = resolved.workflow
        resolvedWorkflowId = resolved.workflow.id
      }

      const validation = validateWorkflowState({
        blocks: state.blocks ?? {},
        edges: state.edges ?? [],
        loops: state.loops ?? {},
        parallels: state.parallels ?? {},
        variables: state.variables ?? {},
      })

      const { formatWorkflowLintMessage, hasWorkflowLintIssues, lintEditedWorkflowState } =
        await import('@/lib/workflows/editing/lint')
      const workflowLint = lintEditedWorkflowState({
        blocks: state.blocks ?? {},
        edges: state.edges ?? [],
      })
      const workflowLintMessage = hasWorkflowLintIssues(workflowLint)
        ? formatWorkflowLintMessage(workflowLint)
        : undefined

      return {
        toolName,
        success: true,
        result: {
          ...validation,
          ...(resolvedWorkflowId ? { workflowId: resolvedWorkflowId } : {}),
          workflowLint,
          ...(workflowLintMessage ? { workflowLintMessage } : {}),
        },
      }
    }

    case 'generate_workflow_patch': {
      const resolved = await resolveWorkflowStateForLocalTool(ctx, args)
      if (!resolved.ok) {
        return {
          toolName,
          success: false,
          error: resolved.error,
          result: { error: resolved.error },
        }
      }
      const userRequest = String(args.userRequest ?? '')
      const targetBlockId =
        typeof args.targetBlockId === 'string' ? args.targetBlockId : ctx.selectedBlockId
      const patch = await generateWorkflowPatchFromRequest({
        context: ctx.structuredContext,
        userRequest,
        targetBlockId,
      })
      return { toolName, success: true, result: patch, patch }
    }

    case 'get_execution_logs': {
      const limit = typeof args.limit === 'number' ? args.limit : 10
      const executionId = typeof args.executionId === 'string' ? args.executionId : undefined
      const { readLogs } = await import('@/lib/logs/list-logs')
      const logs = await readLogs({
        workspaceId: ctx.workspaceId,
        ...(ctx.workflowId ? { workflowIds: ctx.workflowId } : {}),
        limit,
        executionId,
        sortBy: 'date',
        sortOrder: 'desc',
        hideCostInfo: false,
      })
      return { toolName, success: true, result: logs }
    }

    case 'explain_error': {
      const errorMessage = String(args.errorMessage ?? ctx.structuredContext.execution.error ?? '')
      const blockId =
        typeof args.blockId === 'string'
          ? args.blockId
          : (ctx.structuredContext.execution.failedBlockId ?? undefined)
      const executionId =
        typeof args.executionId === 'string'
          ? args.executionId
          : ctx.structuredContext.execution.executionId

      let logDetail = null
      if (executionId) {
        const { readLogDetail } = await import('@/lib/logs/fetch-log-detail')
        logDetail = await readLogDetail({
          viewerUserId: ctx.userId,
          workspaceId: ctx.workspaceId,
          lookupColumn: 'executionId',
          lookupValue: executionId,
          hideCostInfo: false,
        })
      }

      return {
        toolName,
        success: true,
        result: {
          errorMessage,
          blockId,
          executionId,
          analysis: buildErrorAnalysis(errorMessage, blockId, ctx.structuredContext),
          logDetail,
        },
      }
    }

    case 'search_docs': {
      const query = String(args.query ?? '').toLowerCase()
      const { getAllBlocks } = await import('@/blocks/registry')
      const matches = getAllBlocks()
        .filter(
          (block) =>
            block.name.toLowerCase().includes(query) ||
            block.description.toLowerCase().includes(query) ||
            block.type.toLowerCase().includes(query)
        )
        .slice(0, 10)
        .map((block) => ({
          type: block.type,
          name: block.name,
          description: block.description,
          docsLink: block.docsLink,
          category: block.category,
        }))
      return { toolName, success: true, result: { query: args.query, matches } }
    }

    case 'propose_workflow_patch': {
      const resolved = await resolveWorkflowStateForLocalTool(ctx, args)
      if (!resolved.ok) {
        return {
          toolName,
          success: false,
          error: resolved.error,
          result: { error: resolved.error },
        }
      }
      const workflowState = resolved.workflow
      const patch: WorkflowPatch = {
        type: 'workflow_patch',
        summary: String(args.summary ?? 'Workflow changes'),
        changes: Array.isArray(args.changes) ? (args.changes as WorkflowPatch['changes']) : [],
        requiresConfirmation: true,
        warnings: Array.isArray(args.warnings) ? (args.warnings as string[]) : undefined,
        recommendations: Array.isArray(args.recommendations)
          ? (args.recommendations as string[])
          : undefined,
      }
      const validation = validateWorkflowPatch(patch, workflowState)
      if (!validation.valid) {
        return {
          toolName,
          success: false,
          result: { error: 'Patch validation failed', validation },
          error: 'Patch validation failed',
        }
      }
      return { toolName, success: true, result: patch, patch }
    }

    default:
      throw new Error(`Unhandled tool: ${toolName}`)
  }
}

function attachToolBilling(result: ToolExecutionResult): ToolExecutionResult {
  if (result.billing) return result
  const fromResult = extractLocalToolBillingMetadata(result.result)
  if (fromResult) {
    return { ...result, billing: fromResult }
  }
  // Integration tools nest the payload under `output`.
  if (result.result && typeof result.result === 'object') {
    const nested = (result.result as { output?: unknown }).output
    const fromNested = extractLocalToolBillingMetadata(nested)
    if (fromNested) {
      return { ...result, billing: fromNested }
    }
  }
  return result
}

function buildErrorAnalysis(
  errorMessage: string,
  blockId: string | undefined,
  context: LocalCopilotStructuredContext
): Record<string, unknown> {
  const block = blockId ? context.workflow?.blocks[blockId] : undefined
  const lower = errorMessage.toLowerCase()

  const rootCause =
    lower.includes('credential') || lower.includes('unauthorized')
      ? 'Credential or authentication issue'
      : lower.includes('rate limit')
        ? 'API rate limit exceeded'
        : lower.includes('variable') || lower.includes('undefined')
          ? 'Missing or invalid variable reference'
          : lower.includes('timeout')
            ? 'Request timeout'
            : 'Block execution failure'

  return {
    rootCause,
    failingBlock: block
      ? { id: blockId, type: block.type, name: block.name }
      : blockId
        ? { id: blockId }
        : null,
    suggestedFixes: suggestFixes(lower, block?.type),
    testSteps: [
      'Verify credentials are connected for required integrations',
      'Check block configuration and required inputs',
      'Run a single-block test if available',
      'Review execution logs for the failing step',
    ],
  }
}

function suggestFixes(errorLower: string, blockType?: string): string[] {
  const fixes: string[] = []
  if (errorLower.includes('credential') || errorLower.includes('unauthorized')) {
    fixes.push('Reconnect or select the correct credential in workspace settings')
  }
  if (errorLower.includes('rate limit')) {
    fixes.push('Add retry logic or reduce request frequency')
  }
  if (errorLower.includes('variable')) {
    fixes.push('Ensure referenced variables exist and match expected types')
  }
  if (blockType) {
    fixes.push(`Review ${blockType} block configuration against integration docs`)
  }
  if (fixes.length === 0) {
    fixes.push('Inspect block inputs and upstream data shape')
  }
  return fixes
}

function rememberListedIntegrationTools(ctx: ToolExecutionContext, result: unknown): void {
  ctx.listedIntegrationToolIds ??= new Set()
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
  const tools = Array.isArray(record?.tools) ? record.tools : []
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as Record<string, unknown>).id
    if (typeof id === 'string' && id.trim()) ctx.listedIntegrationToolIds.add(id.trim())
  }
}

function rememberReadVfsPath(ctx: ToolExecutionContext, args: Record<string, unknown>): void {
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  if (!path) return
  const canonical = normalizeWorkspaceFileReadPath(path)
  if (!canonical) return
  ctx.readVfsPaths ??= new Set()
  ctx.readVfsPaths.add(canonical)
}

/**
 * Fills workflowId for home-chat edits when the model omits it but the workspace
 * has an obvious target (open workflow, name match, single workflow, or DB lookup).
 */
async function enrichEditWorkflowArgs(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<Record<string, unknown>> {
  const next = { ...args }
  let workflowId = resolveWorkflowIdForDelegatedTool(next, ctx)
  if (!workflowId && ctx.workspaceId) {
    workflowId = await resolveWorkflowIdFromDatabase(ctx.workspaceId, next)
  }
  if (workflowId) {
    next.workflowId = workflowId
  }
  return next
}

export async function refreshToolContext(
  params: ToolExecutionContext & { selectedBlockId?: string }
): Promise<ToolExecutionContext> {
  const structuredContext = await reloadLocalCopilotWorkflowContext({
    previous: params.structuredContext,
    workflowId: params.workflowId,
    selectedBlockId: params.selectedBlockId,
  })
  let workflowRevision = params.workflowRevision
  if (params.workflowId) {
    const loaded = await loadWorkflowRevision(params.workflowId, params.workspaceId)
    if (loaded) workflowRevision = loaded.revision
  }
  return { ...params, structuredContext, workflowRevision }
}
