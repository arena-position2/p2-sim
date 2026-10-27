import { db } from '@sim/db'
import { user, workflow, workflowExecutionLogs, workspace } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import type { WorkflowState } from '@sim/workflow-types/workflow'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { generateWorkspaceSnapshot } from '@/lib/mothership/chat/workspace-snapshot'
import type { VfsSnapshotV1 } from '@/lib/mothership/generated/vfs-snapshot-v1'
import { loadUserMemoriesForContext } from '@/lib/mothership/tools/server/other/user-memory'
import { loadWorkflowFromNormalizedTables } from '@/lib/workflows/persistence/utils'
import { getAllBlocks } from '@/blocks/registry'
import type { BlockConfig } from '@/blocks/types'
import { getLocalCopilotConfig, isSelfHostedDeployment } from '@/local-copilot/lib/config'
import { buildContextPromptPayload } from '@/local-copilot/lib/context/context-budget'
import { getLocalCopilotE2bCapabilities } from '@/local-copilot/lib/context/e2b-capabilities'
import {
  loadWorkspaceIntegrations,
  mapSnapshotToWorkspaceIntegrations,
  oauthIntegrationsToCredentialMetadata,
} from '@/local-copilot/lib/context/load-workspace-integrations'
import { loadWorkspaceResourceSummaries } from '@/local-copilot/lib/context/load-workspace-resources'
import { rewriteSnapshotSkillsForLocalCopilot } from '@/local-copilot/lib/context/relevant-skills'
import {
  type StampedWorkspaceSnapshotBundle,
  stampWorkspaceSnapshotBundle,
} from '@/local-copilot/lib/context/snapshot-freshness'
import {
  type LocalCopilotSkillSummary,
  loadWorkspaceSkillSummaries,
} from '@/local-copilot/lib/tools/user-skills'
import type {
  LocalCopilotBlockSummary,
  LocalCopilotStructuredContext,
} from '@/local-copilot/lib/types'

const logger = createLogger('LocalCopilotContext')

/** Prebuilt workspace inventory bundle from {@link generateWorkspaceSnapshot}. */
export type WorkspaceSnapshotBundle = StampedWorkspaceSnapshotBundle

export interface BuildContextParams {
  userId: string
  workspaceId: string
  workflowId?: string
  selectedBlockId?: string
  executionId?: string
  /**
   * Prebuilt workspace snapshot. The mothership lifecycle already fetches this in
   * `post.ts`, so it is threaded through to avoid a second identical DB fetch.
   * When omitted, this builder fetches its own snapshot.
   */
  workspaceSnapshot?: WorkspaceSnapshotBundle | null
}

type SnapshotResourceContext = Pick<
  LocalCopilotStructuredContext,
  'knowledgeBases' | 'tables' | 'workspaceFiles'
>

/** Maps a typed workspace snapshot into Local structured resource summaries. */
export function mapSnapshotResources(snapshot: VfsSnapshotV1): SnapshotResourceContext {
  return {
    knowledgeBases: (snapshot.knowledgeBases ?? []).map((kb) => ({
      id: kb.id,
      name: kb.name,
      description: kb.description ?? null,
      ...(kb.connectorTypes && kb.connectorTypes.length > 0
        ? { connectorTypes: kb.connectorTypes }
        : {}),
    })),
    tables: (snapshot.tables ?? []).map((table) => ({
      id: table.id,
      name: table.name,
      description: table.description ?? null,
    })),
    workspaceFiles: (snapshot.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      path: file.path,
      type: file.type ?? '',
      size: file.size ?? 0,
    })),
  }
}

/** Maps a typed workspace snapshot into the Local `workspaceWorkflows` inventory. */
export function mapSnapshotWorkflows(
  snapshot: VfsSnapshotV1
): NonNullable<LocalCopilotStructuredContext['workspaceWorkflows']> {
  return (snapshot.workflows ?? []).map((wf) => ({
    id: wf.id,
    name: wf.name,
    isDeployed: wf.isDeployed ?? false,
    ...(wf.path ? { path: wf.path } : {}),
    ...(wf.folderPath ? { folderPath: wf.folderPath } : {}),
  }))
}

/**
 * Resolves the workspace snapshot, preferring a caller-supplied bundle and
 * falling back to a fresh fetch. Returns null when the snapshot is unavailable
 * so callers can degrade to the legacy per-resource loaders.
 */
async function resolveWorkspaceSnapshot(
  params: BuildContextParams
): Promise<WorkspaceSnapshotBundle | null> {
  if (params.workspaceSnapshot) {
    const stampStartedAt = Date.now()
    const stamped = stampWorkspaceSnapshotBundle(params.workspaceSnapshot)
    logger.info('Arena Copilot context snapshot reused from caller', {
      workspaceId: params.workspaceId,
      snapshotSource: 'caller',
      stampMs: Date.now() - stampStartedAt,
      markdownChars: params.workspaceSnapshot.markdown.length,
    })
    return stamped
  }
  const snapshotStartedAt = Date.now()
  try {
    const generated = await generateWorkspaceSnapshot(params.workspaceId, params.userId)
    logger.info('Arena Copilot context snapshot generated', {
      workspaceId: params.workspaceId,
      snapshotSource: generated ? 'generated' : 'unavailable',
      durationMs: Date.now() - snapshotStartedAt,
    })
    if (!generated) return null
    return stampWorkspaceSnapshotBundle(generated)
  } catch (error) {
    logger.warn('Failed to load workspace snapshot; falling back to legacy loaders', {
      workspaceId: params.workspaceId,
      snapshotSource: 'generated_failed',
      durationMs: Date.now() - snapshotStartedAt,
      error: getErrorMessage(error, 'snapshot failed'),
    })
    return null
  }
}

interface LegacyWorkspaceInventory {
  resources: SnapshotResourceContext
  skills: LocalCopilotSkillSummary[]
  workspaceWorkflows: NonNullable<LocalCopilotStructuredContext['workspaceWorkflows']>
}

async function loadWorkspaceRow(
  workspaceId: string
): Promise<{ id: string; name: string } | undefined> {
  const [workspaceRow] = await db
    .select({ id: workspace.id, name: workspace.name })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1)
  return workspaceRow
}

async function loadLegacyWorkspaceInventory(
  workspaceId: string
): Promise<LegacyWorkspaceInventory> {
  const [resources, skills, workflowRows] = await Promise.all([
    loadWorkspaceResourceSummaries(workspaceId),
    loadWorkspaceSkillSummaries(workspaceId),
    db
      .select({
        id: workflow.id,
        name: workflow.name,
        isDeployed: workflow.isDeployed,
        lastRunAt: workflow.lastRunAt,
      })
      .from(workflow)
      .where(and(eq(workflow.workspaceId, workspaceId), isNull(workflow.archivedAt)))
      .orderBy(desc(workflow.updatedAt))
      .limit(50),
  ])

  return {
    resources,
    skills,
    workspaceWorkflows: workflowRows.map((row) => ({
      id: row.id,
      name: row.name ?? 'Untitled workflow',
      isDeployed: row.isDeployed,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
    })),
  }
}

export async function buildLocalCopilotContext(
  params: BuildContextParams
): Promise<LocalCopilotStructuredContext> {
  const { userId, workspaceId, workflowId, selectedBlockId, executionId } = params
  const buildStartedAt = Date.now()
  const hasCallerSnapshot = Boolean(params.workspaceSnapshot)
  const timed = async <T>(
    _label: string,
    work: () => Promise<T>
  ): Promise<{ value: T; ms: number }> => {
    const started = Date.now()
    const value = await work()
    return { value, ms: Date.now() - started }
  }

  // Snapshot is often the slowest call. Kick off everything that does not need it
  // in the same wave so integrations / user / memories / open-workflow overlap it.
  // When mothership already passed a snapshot, map integrations from it — do not
  // re-run OAuth + env decrypt (that was a multi-second cost on top of stamp).
  const snapshotPromise = timed('snapshot', () => resolveWorkspaceSnapshot(params))
  const integrationsPromise = hasCallerSnapshot
    ? null
    : timed('integrations', () => loadWorkspaceIntegrations(workspaceId, userId))
  const currentUserPromise = timed('currentUser', () =>
    db
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
      .then((rows) => rows[0])
  )
  const userMemoriesPromise = timed('userMemories', () =>
    loadUserMemoriesForContext(userId, workspaceId)
  )
  // Skip the workspace SELECT when the caller already stamped workspace onto the snapshot.
  const workspaceRowFallbackPromise = params.workspaceSnapshot?.snapshot.workspace
    ? null
    : timed('workspaceRow', () => loadWorkspaceRow(workspaceId))
  const openWorkflowPromise = workflowId
    ? timed('openWorkflow', () =>
        Promise.all([
          db
            .select({ id: workflow.id, name: workflow.name, variables: workflow.variables })
            .from(workflow)
            .where(eq(workflow.id, workflowId))
            .limit(1)
            .then((rows) => rows[0]),
          loadWorkflowFromNormalizedTables(workflowId),
          loadExecutionContext({
            workflowId,
            executionId,
          }),
        ])
      )
    : null

  const snapshotTimed = await snapshotPromise
  const snapshotBundle = snapshotTimed.value
  const snapshot = snapshotBundle?.snapshot ?? null
  const inventoryMarkdown = snapshotBundle?.markdown
    ? rewriteSnapshotSkillsForLocalCopilot(snapshotBundle.markdown)
    : snapshotBundle?.markdown
  const snapshotWorkspace = snapshot?.workspace

  const [
    workspaceTimed,
    integrationsTimed,
    currentUserTimed,
    userMemoriesTimed,
    legacyTimed,
    openWorkflowTimed,
  ] = await Promise.all([
    snapshotWorkspace
      ? Promise.resolve({
          value: { id: snapshotWorkspace.id, name: snapshotWorkspace.name },
          ms: 0,
        })
      : (workspaceRowFallbackPromise ?? timed('workspaceRow', () => loadWorkspaceRow(workspaceId))),
    hasCallerSnapshot && snapshot
      ? Promise.resolve({ value: mapSnapshotToWorkspaceIntegrations(snapshot), ms: 0 })
      : (integrationsPromise ??
        timed('integrations', () => loadWorkspaceIntegrations(workspaceId, userId))),
    currentUserPromise,
    userMemoriesPromise,
    snapshot
      ? Promise.resolve({ value: null, ms: 0 })
      : timed('legacyInventory', () => loadLegacyWorkspaceInventory(workspaceId)),
    openWorkflowPromise ?? Promise.resolve({ value: null, ms: 0 }),
  ])

  const workspaceRow = workspaceTimed.value
  const integrations = integrationsTimed.value
  const currentUserRow = currentUserTimed.value
  const userMemories = userMemoriesTimed.value
  const legacyInventory = legacyTimed.value
  const openWorkflow = openWorkflowTimed.value

  logger.info('Arena Copilot context build timings', {
    workspaceId,
    hasCallerSnapshot,
    inventorySource: snapshot ? 'snapshot' : 'legacy',
    workflowId: workflowId ?? null,
    totalMs: Date.now() - buildStartedAt,
    snapshotMs: snapshotTimed.ms,
    workspaceRowMs: workspaceTimed.ms,
    integrationsMs: integrationsTimed.ms,
    integrationsSource: hasCallerSnapshot && snapshot ? 'snapshot' : 'db',
    currentUserMs: currentUserTimed.ms,
    userMemoriesMs: userMemoriesTimed.ms,
    legacyInventoryMs: legacyTimed.ms,
    openWorkflowMs: openWorkflowTimed.ms,
  })

  if (!workspaceRow) {
    throw new Error('Workspace not found')
  }

  const currentUser = currentUserRow?.email?.trim()
    ? {
        email: currentUserRow.email.trim(),
        ...(currentUserRow.name?.trim() ? { name: currentUserRow.name.trim() } : {}),
      }
    : undefined
  const credentials = oauthIntegrationsToCredentialMetadata(integrations.connectedIntegrations)
  let resources: SnapshotResourceContext
  let skills: LocalCopilotSkillSummary[]
  let workspaceWorkflows: NonNullable<LocalCopilotStructuredContext['workspaceWorkflows']>
  if (snapshot) {
    resources = mapSnapshotResources(snapshot)
    skills = (snapshot.skills ?? []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? '',
    }))
    workspaceWorkflows = mapSnapshotWorkflows(snapshot)
  } else {
    if (!legacyInventory) {
      throw new Error('Workspace inventory unavailable')
    }
    resources = legacyInventory.resources
    skills = legacyInventory.skills
    workspaceWorkflows = legacyInventory.workspaceWorkflows
  }
  const availableBlocks = summarizeBlocks(getAllBlocks())
  const availableIntegrations = [...new Set(availableBlocks.map((block) => block.category))].sort()

  const integrationContext = {
    ...(currentUser ? { currentUser } : {}),
    connectedIntegrations: integrations.connectedIntegrations,
    envVariables: integrations.envVariables,
    hostedKeysAvailable: integrations.hostedKeysAvailable,
    e2b: getLocalCopilotE2bCapabilities(),
  }

  const resourceContext = {
    knowledgeBases: resources.knowledgeBases,
    tables: resources.tables,
    workspaceFiles: resources.workspaceFiles,
    ...(inventoryMarkdown ? { inventoryMarkdown } : {}),
    ...(snapshotBundle?.generatedAt && snapshotBundle.contentRevision
      ? {
          snapshotFreshness: {
            generatedAt: snapshotBundle.generatedAt,
            contentRevision: snapshotBundle.contentRevision,
            workspaceId,
          },
          vfsSnapshot: snapshotBundle.snapshot,
        }
      : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(userMemories.length > 0
      ? {
          userMemories: userMemories.map((memory) => ({
            key: memory.key,
            value: memory.value,
            memoryType: memory.memoryType,
            source: memory.source,
            confidence: memory.confidence,
          })),
        }
      : {}),
  }

  const workspaceWorkflowsContext = { workspaceWorkflows }

  if (!workflowId) {
    const context: LocalCopilotStructuredContext = {
      workspace: {
        id: workspaceRow.id,
        name: workspaceRow.name,
        environment: isSelfHostedDeployment() ? 'self_hosted' : 'cloud',
      },
      ...integrationContext,
      ...resourceContext,
      execution: {
        lastRunStatus: 'unknown',
        logs: [],
        failedBlockId: null,
        error: null,
      },
      availableIntegrations,
      availableBlocks,
      ...workspaceWorkflowsContext,
    }

    logger.info('Built Arena Copilot workspace context', {
      workspaceId,
      inventorySource: snapshot ? 'snapshot' : 'legacy',
      workflowCount: workspaceWorkflows.length,
      fileCount: resources.workspaceFiles?.length ?? 0,
      tableCount: resources.tables?.length ?? 0,
      knowledgeBaseCount: resources.knowledgeBases?.length ?? 0,
      skillCount: skills.length,
      userMemoryCount: userMemories.length,
      envVariableCount: integrations.envVariables.length,
      connectedIntegrationCount: integrations.connectedIntegrations.length,
      provider: getLocalCopilotConfig().provider,
    })

    return context
  }

  if (!openWorkflow) {
    throw new Error('Workflow context unavailable')
  }

  const [workflowRow, normalized, execution] = openWorkflow

  if (!workflowRow) {
    throw new Error('Workflow not found')
  }

  if (!normalized) {
    throw new Error('Workflow state not found')
  }

  const variables = (workflowRow.variables ?? {}) as WorkflowState['variables']

  const context: LocalCopilotStructuredContext = {
    workspace: {
      id: workspaceRow.id,
      name: workspaceRow.name,
      environment: isSelfHostedDeployment() ? 'self_hosted' : 'cloud',
    },
    ...integrationContext,
    ...resourceContext,
    ...workspaceWorkflowsContext,
    workflow: {
      id: workflowRow.id,
      name: workflowRow.name ?? 'Untitled workflow',
      blocks: normalized.blocks,
      edges: normalized.edges,
      variables,
      loops: normalized.loops,
      parallels: normalized.parallels,
      credentials,
    },
    execution,
    availableIntegrations,
    availableBlocks,
    selectedBlockId,
  }

  logger.info('Built Arena Copilot context', {
    workflowId,
    inventorySource: snapshot ? 'snapshot' : 'legacy',
    blockCount: Object.keys(normalized.blocks).length,
    workflowCount: workspaceWorkflows.length,
    skillCount: skills.length,
    envVariableCount: integrations.envVariables.length,
    connectedIntegrationCount: integrations.connectedIntegrations.length,
    provider: getLocalCopilotConfig().provider,
  })

  return context
}

export function contextToPromptJson(
  context: LocalCopilotStructuredContext,
  options?: {
    workflowDetail?: 'full' | 'compact'
    inventoryMode?: 'full' | 'delta' | 'unchanged'
    snapshotRevision?: string
  }
): string {
  return buildContextPromptPayload(context, options)
}

async function loadExecutionContext(params: {
  workflowId: string
  executionId?: string
}): Promise<LocalCopilotStructuredContext['execution']> {
  const { workflowId, executionId } = params

  try {
    const logColumns = {
      status: workflowExecutionLogs.status,
      executionId: workflowExecutionLogs.executionId,
      startedAt: workflowExecutionLogs.startedAt,
    } as const

    const [latest] = executionId
      ? await db
          .select(logColumns)
          .from(workflowExecutionLogs)
          .where(eq(workflowExecutionLogs.executionId, executionId))
          .limit(1)
      : await db
          .select(logColumns)
          .from(workflowExecutionLogs)
          .where(eq(workflowExecutionLogs.workflowId, workflowId))
          .orderBy(desc(workflowExecutionLogs.startedAt))
          .limit(1)

    if (!latest) {
      return {
        lastRunStatus: 'unknown',
        logs: [],
        failedBlockId: null,
        error: null,
      }
    }

    const status =
      latest.status === 'success'
        ? 'success'
        : latest.status === 'failed'
          ? 'failed'
          : latest.status === 'running'
            ? 'running'
            : 'unknown'

    return {
      lastRunStatus: status,
      executionId: latest.executionId ?? undefined,
      failedBlockId: null,
      error: latest.status === 'failed' ? `Workflow run ${latest.status}` : null,
      logs: [
        {
          level: status === 'failed' ? 'error' : 'info',
          message: `Last run ${latest.status}`,
          timestamp:
            latest.startedAt instanceof Date
              ? latest.startedAt.toISOString()
              : String(latest.startedAt),
        },
      ],
    }
  } catch (error) {
    logger.warn('Failed to load execution context', { workflowId, error })
    return {
      lastRunStatus: 'unknown',
      logs: [],
      failedBlockId: null,
      error: null,
    }
  }
}

function summarizeBlocks(blocks: BlockConfig[]): LocalCopilotBlockSummary[] {
  return blocks
    .filter((block) => !block.hideFromToolbar)
    .map((block) => ({
      id: block.type,
      name: block.name,
      category: block.category,
      description: block.description,
      authMode: block.authMode,
    }))
}
