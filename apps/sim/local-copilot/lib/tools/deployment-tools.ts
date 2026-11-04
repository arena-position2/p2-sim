import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { generateRequestId } from '@/lib/core/utils/request'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { listLiveWorkflowMcpToolsForWorkflow } from '@/lib/mcp/queries'
import { buildWorkflowMcpApiEndpoint } from '@/lib/mcp/urls'
import {
  executeCopilotWorkflowUseCase,
  messageForCopilotWorkflowError,
} from '@/lib/mothership/application/execute-workflow-use-case'
import { deployWorkflowChat } from '@/lib/workflows/application/chat-deployments'
import {
  activateWorkflowVersion,
  deployWorkflow,
  readWorkflowDeploymentStatus,
  revertWorkflowVersion,
  undeployWorkflow,
  updateWorkflowVersion,
} from '@/lib/workflows/application/deployments'
import { listWorkflowVersions } from '@/lib/workflows/application/list-workflow-versions'
import { readWorkflowDefinition } from '@/lib/workflows/application/read-workflow-definition'
import { generateWorkflowDiffSummary } from '@/lib/workflows/comparison'
import { getWorkflowDeploymentVersion } from '@/lib/workflows/persistence/utils'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import {
  getCopilotDeploymentIdempotencyKey,
  getHistoricalDeploymentAttemptError,
  getUnconfirmedDeploymentError,
} from '@/local-copilot/lib/tools/deployment-idempotency'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotDeploymentTools')

const MAX_DIFF_VALUE_BYTES = 2000

export const DEPLOYMENT_TOOL_NAMES = [
  'check_deployment_status',
  'deploy_api',
  'deploy_chat',
  'redeploy',
  'get_deployment_log',
  'diff_workflows',
  'load_deployment',
  'promote_to_live',
  'update_deployment_version',
] as const

export type DeploymentToolName = (typeof DEPLOYMENT_TOOL_NAMES)[number]

export function isDeploymentToolName(toolName: string): toolName is DeploymentToolName {
  return (DEPLOYMENT_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface DeploymentToolResult {
  success: boolean
  output?: unknown
  error?: string
}

/**
 * Arena Local Copilot deployment family. Cloud deleted mothership
 * `deployment/{manage,deploy}` handlers; keep these under local-copilot.
 */
export async function executeDeploymentTool(
  toolName: DeploymentToolName,
  rawParams: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  try {
    switch (toolName) {
      case 'check_deployment_status':
        return await executeCheckDeploymentStatus(rawParams, ctx)
      case 'deploy_api':
        return await executeDeployApi(rawParams, ctx)
      case 'deploy_chat':
        return await executeDeployChat(rawParams, ctx)
      case 'redeploy':
        return await executeRedeploy(rawParams, ctx)
      case 'get_deployment_log':
        return await executeGetDeploymentLog(rawParams, ctx)
      case 'diff_workflows':
        return await executeDiffWorkflows(rawParams, ctx)
      case 'load_deployment':
        return await executeLoadDeployment(rawParams, ctx)
      case 'promote_to_live':
        return await executePromoteToLive(rawParams, ctx)
      case 'update_deployment_version':
        return await executeUpdateDeploymentVersion(rawParams, ctx)
    }
  } catch (error) {
    logger.error(`local ${toolName} failed`, {
      error: toError(error).message,
      workspaceId: ctx.workspaceId,
    })
    return {
      success: false,
      error: messageForCopilotWorkflowError(error, getErrorMessage(error, `${toolName} failed`)),
    }
  }
}

async function executeCheckDeploymentStatus(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }

  const toolContext = toCopilotServerToolContext(ctx)
  const deployment = await executeCopilotWorkflowUseCase(
    toolContext,
    readWorkflowDeploymentStatus,
    {
      workflowId,
      assertedWorkspaceId: ctx.workspaceId,
    }
  )

  const isApiDeployed = deployment.isDeployed
  const apiDetails = {
    isDeployed: isApiDeployed,
    deployedAt: deployment.workflow.deployedAt || null,
    endpoint: isApiDeployed ? `/api/workflows/${workflowId}/execute` : null,
    apiKey: deployment.workspaceId ? 'Workspace API keys' : 'Personal API keys',
    needsRedeployment: deployment.needsRedeployment,
    activeDeployment: deployment.activeDeployment,
    latestDeploymentAttempt: deployment.latestDeploymentAttempt,
    currentDeploymentAttempt: deployment.latestDeploymentAttempt?.isCurrent
      ? deployment.latestDeploymentAttempt
      : null,
    warnings: [] as string[],
  }

  const mcpTools = await listLiveWorkflowMcpToolsForWorkflow(workflowId)
  const mcpDetails = {
    isDeployed: mcpTools.length > 0,
    servers: mcpTools.map((tool) => ({
      serverId: tool.serverId,
      toolName: tool.toolName,
    })),
  }

  return {
    success: true,
    output: {
      isDeployed: apiDetails.isDeployed || mcpDetails.isDeployed,
      api: apiDetails,
      mcp: mcpDetails,
    },
  }
}

async function executeDeployApi(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }

  const toolContext = toCopilotServerToolContext(ctx)
  const action = stringArg(params, 'action') === 'undeploy' ? 'undeploy' : 'deploy'

  if (action === 'undeploy') {
    const result = await executeCopilotWorkflowUseCase(toolContext, undeployWorkflow, {
      workflowId,
      assertedWorkspaceId: ctx.workspaceId,
      requestId: generateRequestId(),
    })
    if (!result.success) {
      return { success: false, error: result.error || 'Failed to undeploy workflow' }
    }
    return { success: true, output: buildApiDeployOutput(workflowId, false, null) }
  }

  const versionDescription = stringArg(params, 'versionDescription')
  if (!versionDescription) {
    return {
      success: false,
      error:
        'versionDescription is required when deploying. Provide a concise summary of what changed (call diff_workflows with ref1 "live" and ref2 "draft" if unsure).',
    }
  }
  const versionName = stringArg(params, 'versionName')
  if (!versionName) {
    return {
      success: false,
      error:
        'versionName is required when deploying. Provide a short label for this deployment version.',
    }
  }

  const result = await executeCopilotWorkflowUseCase(toolContext, deployWorkflow, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    description: versionDescription,
    name: versionName,
    requestId: generateRequestId(),
    idempotencyKey: getCopilotDeploymentIdempotencyKey(ctx, 'deploy_as_api'),
  })
  if (!result.success) {
    return { success: false, error: result.error || 'Failed to deploy workflow' }
  }
  const historicalAttemptError = getHistoricalDeploymentAttemptError(
    result.latestDeploymentAttempt,
    'deploy'
  )
  if (historicalAttemptError) return { success: false, error: historicalAttemptError }
  const unconfirmed = getUnconfirmedDeploymentError(result, 'Deployment')
  if (unconfirmed) return { success: false, error: unconfirmed }

  return {
    success: true,
    output: buildApiDeployOutput(workflowId, Boolean(result.activeDeployment), result),
  }
}

async function executeRedeploy(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }

  const versionDescription = stringArg(params, 'versionDescription')
  if (!versionDescription) {
    return {
      success: false,
      error:
        'versionDescription is required. Provide a concise summary of what changed (call diff_workflows with ref1 "live" and ref2 "draft" if unsure).',
    }
  }
  const versionName = stringArg(params, 'versionName')
  if (!versionName) {
    return {
      success: false,
      error: 'versionName is required. Provide a short label for this deployment version.',
    }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotWorkflowUseCase(toolContext, deployWorkflow, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    description: versionDescription,
    name: versionName,
    requestId: generateRequestId(),
    idempotencyKey: getCopilotDeploymentIdempotencyKey(ctx, 'deploy_as_api'),
  })
  if (!result.success) {
    return { success: false, error: result.error || 'Failed to redeploy workflow' }
  }
  const historicalAttemptError = getHistoricalDeploymentAttemptError(
    result.latestDeploymentAttempt,
    'redeploy'
  )
  if (historicalAttemptError) return { success: false, error: historicalAttemptError }
  const unconfirmed = getUnconfirmedDeploymentError(result, 'Redeployment')
  if (unconfirmed) return { success: false, error: unconfirmed }

  return {
    success: true,
    output: buildApiDeployOutput(workflowId, Boolean(result.activeDeployment), result),
  }
}

async function executeDeployChat(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }

  if (stringArg(params, 'action') === 'undeploy') {
    return {
      success: false,
      error:
        'Chat undeploy is not available via Arena Local Copilot yet. Undeploy the chat from workspace settings, or redeploy with updated settings.',
    }
  }

  const versionDescription = stringArg(params, 'versionDescription')
  if (!versionDescription) {
    return {
      success: false,
      error:
        'versionDescription is required when deploying. Provide a concise summary of what changed (distinct from the chat-facing description).',
    }
  }
  const versionName = stringArg(params, 'versionName')
  if (!versionName) {
    return {
      success: false,
      error:
        'versionName is required when deploying. Provide a short label for this deployment version (distinct from the chat title).',
    }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotWorkflowUseCase(toolContext, deployWorkflowChat, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    identifier: stringArg(params, 'identifier'),
    title: stringArg(params, 'title'),
    description: stringArg(params, 'description'),
    versionDescription,
    versionName,
    authType:
      (stringArg(params, 'authType') as 'public' | 'password' | 'email' | undefined) ?? undefined,
    password: stringArg(params, 'password') ?? null,
    allowedEmails: stringArrayArg(params, 'allowedEmails'),
    includeThinking: booleanArg(params, 'includeThinking'),
    includeToolCalls: booleanArg(params, 'includeToolCalls'),
    requestId: generateRequestId(),
    idempotencyKey: getCopilotDeploymentIdempotencyKey(ctx, 'deploy_chat'),
  })

  return {
    success: true,
    output: {
      workflowId,
      action: 'deploy',
      isChatDeployed: true,
      chatId: result.chatId,
      chatUrl: result.chatUrl,
      identifier: result.identifier,
      title: result.title,
      deploymentType: 'chat',
    },
  }
}

async function executeGetDeploymentLog(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }

  const toolContext = toCopilotServerToolContext(ctx)
  const { versions: rows } = await executeCopilotWorkflowUseCase(
    toolContext,
    listWorkflowVersions,
    {
      workflowId,
      assertedWorkspaceId: ctx.workspaceId,
    }
  )

  const versions = rows.map((row) => ({
    id: row.id,
    version: row.version,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    isActive: row.isActive,
    latestOperationStatus: row.latestOperationStatus ?? undefined,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ?? undefined,
  }))

  return { success: true, output: { workflowId, count: versions.length, versions } }
}

async function executeDiffWorkflows(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }
  if (params.ref1 === undefined || params.ref2 === undefined) {
    return { success: false, error: 'ref1 and ref2 are required' }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  // Authorize via a workflow read first.
  await executeCopilotWorkflowUseCase(toolContext, readWorkflowDeploymentStatus, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
  })

  const side1 = await loadWorkflowRefState(workflowId, params.ref1, toolContext, ctx)
  const side2 = await loadWorkflowRefState(workflowId, params.ref2, toolContext, ctx)
  if (!side1.ok) return { success: false, error: side1.error }
  if (!side2.ok) return { success: false, error: side2.error }

  const summary = generateWorkflowDiffSummary(side2.state, side1.state)
  const diff = {
    ...summary,
    modifiedBlocks: summary.modifiedBlocks.map((block) => ({
      ...block,
      changes: block.changes.map((change) => ({
        field: change.field,
        oldValue: guardDiffValue(change.oldValue),
        newValue: guardDiffValue(change.newValue),
      })),
    })),
  }

  return {
    success: true,
    output: {
      workflowId,
      ref1: { ref: side1.ref, version: side1.version, isActive: side1.isActive },
      ref2: { ref: side2.ref, version: side2.version, isActive: side2.isActive },
      diff,
    },
  }
}

async function executeLoadDeployment(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }
  if (params.version === undefined || params.version === null) {
    return { success: false, error: 'version is required' }
  }
  const target = resolveLoadVersion(params.version)
  if (!target.ok) return { success: false, error: target.error }

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotWorkflowUseCase(toolContext, revertWorkflowVersion, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    version: target.version,
  })

  const label = target.version === 'active' ? 'the live deployment' : `version ${target.version}`
  return {
    success: true,
    output: {
      workflowId,
      message: `Loaded ${label} into the workflow draft`,
      lastSaved: result.lastSaved,
    },
  }
}

async function executePromoteToLive(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }
  if (params.version === undefined || params.version === null) {
    return { success: false, error: 'version is required' }
  }
  const version = normalizePromoteVersion(params.version)
  if (version === null) {
    return {
      success: false,
      error:
        'version must be a deployment version number (use load_deployment to change the draft; "live" is already live)',
    }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotWorkflowUseCase(toolContext, activateWorkflowVersion, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    version,
    transition: 'activate',
    requestId: generateRequestId(),
    idempotencyKey: getCopilotDeploymentIdempotencyKey(ctx, 'promote_to_live'),
  })

  if (!result.success) {
    return { success: false, error: result.error || 'Failed to promote version' }
  }
  const historicalAttemptError = getHistoricalDeploymentAttemptError(
    result.latestDeploymentAttempt,
    'promotion'
  )
  if (historicalAttemptError) return { success: false, error: historicalAttemptError }

  const isActive = result.activeDeployment?.version === version
  if (!isActive) {
    const detail =
      result.warnings?.[0] ??
      `Promotion of version ${version} is ${result.latestDeploymentAttempt?.status ?? 'unknown'}, not active.`
    return {
      success: false,
      error: `${detail} Do not submit a new promotion; check the existing attempt's status.`,
    }
  }

  return {
    success: true,
    output: {
      workflowId,
      version,
      message: `Promoted version ${version} to live`,
      deployedAt: result.deployedAt ? new Date(result.deployedAt).toISOString() : undefined,
      lifecycleStatus: result.latestDeploymentAttempt?.status ?? null,
      readiness: result.latestDeploymentAttempt?.readiness ?? null,
      error: result.latestDeploymentAttempt?.error ?? null,
      warnings: result.warnings,
    },
  }
}

async function executeUpdateDeploymentVersion(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<DeploymentToolResult> {
  const workflowId = resolveWorkflowId(params, ctx)
  if (!workflowId) return { success: false, error: 'workflowId is required' }
  if (params.version === undefined || params.version === null) {
    return { success: false, error: 'version is required' }
  }
  const version = normalizePromoteVersion(params.version)
  if (version === null) {
    return {
      success: false,
      error: 'version must be a deployment version number (use get_deployment_log to find it)',
    }
  }

  const name = typeof params.name === 'string' ? params.name.trim() : undefined
  const description = typeof params.description === 'string' ? params.description.trim() : undefined
  if (name === undefined && description === undefined) {
    return { success: false, error: 'Provide a name and/or description to update' }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const updated = await executeCopilotWorkflowUseCase(toolContext, updateWorkflowVersion, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    version,
    ...(name !== undefined ? { name: name || null } : {}),
    ...(description !== undefined ? { description: description || null } : {}),
  })

  return {
    success: true,
    output: { workflowId, version, name: updated.name, description: updated.description },
  }
}

function buildApiDeployOutput(
  workflowId: string,
  isDeployed: boolean,
  result: {
    deployedAt?: Date | string | null
    version?: number
    latestDeploymentAttempt?: { status?: string; readiness?: string; error?: string } | null
    warnings?: string[]
  } | null
) {
  const baseUrl = getBaseUrl()
  const apiEndpoint = buildWorkflowMcpApiEndpoint(workflowId)
  return {
    workflowId,
    isDeployed,
    deployedAt: result?.deployedAt ?? null,
    version: result?.version,
    lifecycleStatus: result?.latestDeploymentAttempt?.status ?? null,
    readiness: result?.latestDeploymentAttempt?.readiness ?? null,
    error: result?.latestDeploymentAttempt?.error ?? null,
    warnings: result?.warnings ?? [],
    apiEndpoint,
    baseUrl,
    deploymentType: 'api',
    deploymentStatus: {
      api: {
        isDeployed,
        endpoint: apiEndpoint,
        deployedAt: result?.deployedAt ?? null,
        version: result?.version,
      },
    },
    deploymentConfig: {
      api: buildWorkflowApiConfig(baseUrl, apiEndpoint),
    },
    examples: {
      api: {
        curl: buildWorkflowApiExamples(baseUrl, apiEndpoint),
      },
    },
  }
}

function buildWorkflowApiConfig(baseUrl: string, apiEndpoint: string) {
  return {
    endpoint: apiEndpoint,
    authentication: {
      type: 'api_key',
      acceptedHeaders: ['X-API-Key: YOUR_API_KEY', 'Authorization: Bearer YOUR_API_KEY'],
    },
    modes: {
      sync: {
        method: 'POST',
        transport: 'json',
        stream: false,
        body: { input: { key: 'value' } },
      },
      stream: {
        method: 'POST',
        transport: 'sse',
        stream: true,
        body: { stream: true, input: { key: 'value' } },
      },
      async: {
        method: 'POST',
        transport: 'json',
        stream: false,
        body: { async: true, input: { key: 'value' } },
        runStatusEndpointTemplate: `${apiEndpoint.slice(0, -'/execute'.length)}/runs/{runId}`,
      },
    },
    baseUrl,
  }
}

function buildWorkflowApiExamples(_baseUrl: string, apiEndpoint: string) {
  return {
    sync: `curl -X POST "${apiEndpoint}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-API-Key: YOUR_API_KEY" \\\n  -d '{"input":{"key":"value"}}'`,
    stream: `curl -N -X POST "${apiEndpoint}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-API-Key: YOUR_API_KEY" \\\n  -d '{"stream":true,"input":{"key":"value"}}'`,
    async: `curl -X POST "${apiEndpoint}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-API-Key: YOUR_API_KEY" \\\n  -d '{"async":true,"input":{"key":"value"}}'`,
  }
}

async function loadWorkflowRefState(
  workflowId: string,
  rawRef: unknown,
  toolContext: ReturnType<typeof toCopilotServerToolContext>,
  ctx: ToolExecutionContext
): Promise<
  | {
      ok: true
      state: Parameters<typeof generateWorkflowDiffSummary>[0]
      ref: string
      version?: number
      isActive?: boolean
    }
  | { ok: false; error: string }
> {
  try {
    const ref = parseWorkflowRef(rawRef)
    if (ref === 'draft') {
      const { state } = await executeCopilotWorkflowUseCase(toolContext, readWorkflowDefinition, {
        workflowId,
        assertedWorkspaceId: ctx.workspaceId,
        state: 'draft',
      })
      if (!state) return { ok: false, error: 'Workflow has no draft state' }
      // double-cast-allowed: NormalizedWorkflowData is structurally compatible with WorkflowState for diffing
      return {
        ok: true,
        state: state as Parameters<typeof generateWorkflowDiffSummary>[0],
        ref: 'draft',
      }
    }

    const row = await getWorkflowDeploymentVersion(workflowId, ref === 'live' ? 'active' : ref)
    if (!row?.state) return { ok: false, error: 'Deployment version not found' }
    return {
      ok: true,
      // double-cast-allowed: stored deployment state is WorkflowState-shaped for generateWorkflowDiffSummary
      state: row.state as Parameters<typeof generateWorkflowDiffSummary>[0],
      ref: ref === 'live' ? 'live' : String(ref),
      version: row.version,
      isActive: row.isActive,
    }
  } catch (error) {
    return { ok: false, error: getErrorMessage(error, 'Failed to resolve workflow ref') }
  }
}

function parseWorkflowRef(raw: unknown): number | 'live' | 'draft' {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase()
    if (trimmed === 'live' || trimmed === 'active') return 'live'
    if (trimmed === 'draft' || trimmed === 'current') return 'draft'
    if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
  }
  throw new Error(`Invalid ref "${String(raw)}": expected a version number, "live", or "draft"`)
}

function resolveLoadVersion(
  raw: unknown
): { ok: true; version: number | 'active' } | { ok: false; error: string } {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, version: raw }
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase()
    if (trimmed === 'live' || trimmed === 'active') return { ok: true, version: 'active' }
    if (trimmed === 'draft' || trimmed === 'current') {
      return {
        ok: false,
        error: 'Cannot load "draft" — load_deployment restores a deployed version into the draft',
      }
    }
    if (/^\d+$/.test(trimmed)) return { ok: true, version: Number.parseInt(trimmed, 10) }
  }
  return {
    ok: false,
    error: `Invalid version "${String(raw)}": expected a version number or "live"`,
  }
}

function normalizePromoteVersion(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10)
  return null
}

function guardDiffValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value)
    if (json && json.length > MAX_DIFF_VALUE_BYTES) {
      return { elided: true, bytes: json.length }
    }
  } catch {
    return { elided: true, reason: 'unserializable' }
  }
  return value
}

function resolveWorkflowId(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): string | undefined {
  return stringArg(params, 'workflowId') ?? ctx.workflowId
}

function stringArg(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function booleanArg(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}

function stringArrayArg(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}
