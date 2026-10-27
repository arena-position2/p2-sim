import { db } from '@sim/db'
import {
  credential,
  credentialMember,
  defaultUserWorkflows,
  folder,
  user,
  workflow,
} from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import { createFolder } from '@/lib/folders/orchestration'
import {
  type ChatOutputConfigInput,
  DEFAULT_CHAT_AUTH_TYPE,
  DEFAULT_CHAT_DEPARTMENT,
  DEFAULT_CHAT_WELCOME_MESSAGE,
  resolveChatOutputConfigs,
} from '@/lib/workflows/default-user-workflows/chat-deploy-import'
import {
  type PostgresConnectionConfig,
  populatePostgresBlocks,
} from '@/lib/workflows/default-user-workflows/postgres'
import { performChatDeploy, performFullDeploy } from '@/lib/workflows/orchestration'
import {
  loadWorkflowFromNormalizedTables,
  saveWorkflowToNormalizedTables,
} from '@/lib/workflows/persistence/utils'
// import { createFolderRecord, deduplicateWorkflowName } from '@/lib/workflows/utils'
import { deduplicateWorkflowName } from '@/lib/workflows/utils'
import { regenerateWorkflowIds } from '@/stores/workflows/utils'
import type { WorkflowState } from '@/stores/workflows/workflow/types'

const logger = createLogger('DefaultUserWorkflowsService')

const SYSTEM_DEFAULT_WORKFLOWS_FOLDER_NAME = 'System Workflows'

/** Admin provisioned templates are platform writes — no permission-group subject. */
const UNGOVERNED_PERSIST = { workspaceId: null, subjectUserId: null } as const

/**
 * Returns the workspace folder used for admin-provisioned default workflows.
 * Reuses an existing root-level folder with the system name when present.
 */
async function getOrCreateSystemDefaultWorkflowFolder(params: {
  workspaceId: string
  userId: string
}): Promise<string> {
  const [existing] = await db
    .select({ id: folder.id })
    .from(folder)
    .where(
      and(
        eq(folder.workspaceId, params.workspaceId),
        eq(folder.resourceType, 'workflow'),
        eq(folder.name, SYSTEM_DEFAULT_WORKFLOWS_FOLDER_NAME),
        isNull(folder.parentId),
        isNull(folder.deletedAt)
      )
    )
    .orderBy(asc(folder.createdAt))
    .limit(1)

  if (existing) {
    return existing.id
  }

  const created = await createFolder({
    resourceType: 'workflow',
    userId: params.userId,
    workspaceId: params.workspaceId,
    name: SYSTEM_DEFAULT_WORKFLOWS_FOLDER_NAME,
    parentId: null,
  })

  if (!created.success || !created.folder?.id) {
    throw new Error(created.error || 'Failed to create system default workflows folder')
  }

  const folderId = created.folder.id

  logger.info('Created system default workflows folder', {
    folderId,
    workspaceId: params.workspaceId,
    userId: params.userId,
  })

  return folderId
}

const PROVIDER_BY_TOOL_TYPE: Record<string, string> = {
  gmail: 'google-email',
  gmail_v2: 'google-email',
  google_calendar: 'google-calendar',
  google_calendar_v2: 'google-calendar',
  google_drive: 'google-drive',
  slack: 'slack',
} as const

const PROVIDER_BY_TOOL_ID_PREFIX: Array<{ prefix: string; providerId: string }> = [
  { prefix: 'gmail_', providerId: 'google-email' },
  { prefix: 'google_calendar_', providerId: 'google-calendar' },
  { prefix: 'google_drive_', providerId: 'google-drive' },
  { prefix: 'slack_', providerId: 'slack' },
] as const

export interface DefaultWorkflowSourceInput {
  sourceWorkflowId: string
  nameOverride?: string
  /** When false, import provisions the workflow but deploy skips chat (workflow deploy only). */
  deployAsChat: boolean
  /** Per-workflow chat output selections from `chat.outputConfigs` in the import body. */
  chatOutputConfigs?: ChatOutputConfigInput[]
}

export interface CredentialPopulationSummary {
  populatedProviders: string[]
  missingProviders: string[]
}

export interface ProvisionDefaultUserWorkflowParams {
  input: DefaultWorkflowSourceInput
  workspaceId: string
  userId: string
  credentialsByProvider: Map<string, string>
  postgresConnection?: PostgresConnectionConfig
}

export interface ProvisionDefaultUserWorkflowResult {
  workflowId: string
  name: string
  created: boolean
  refreshed: boolean
  credentialPopulation: CredentialPopulationSummary
  postgresBlocksPopulated: number
}

export interface SyncDefaultWorkflowsParams {
  sourceWorkflowId: string
  deploy?: boolean
  /** When true (default), deploy via chat (create or update). When false, workflow deploy only. */
  deployAsChat: boolean
  chatOutputConfigs?: ChatOutputConfigInput[]
  requestId: string
  request: NextRequest
  postgresConnection?: PostgresConnectionConfig
}

export interface SyncDefaultWorkflowUserResult {
  userId: string
  userWorkflowId: string
  updated: boolean
  deployed: boolean
  chatDeployed?: boolean
  chatId?: string
  chatUrl?: string
  postgresBlocksPopulated?: number
  version?: number
  deployedAt?: string
  warnings?: string[]
  error?: string
}

export interface SyncDefaultWorkflowsResult {
  sourceWorkflowId: string
  total: number
  updated: number
  deployed: number
  failed: number
  results: SyncDefaultWorkflowUserResult[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveProviderIdForTool(tool: Record<string, unknown>): string | null {
  const toolType = typeof tool.type === 'string' ? tool.type : ''
  const toolId = typeof tool.toolId === 'string' ? tool.toolId : ''

  if (toolType && PROVIDER_BY_TOOL_TYPE[toolType]) {
    return PROVIDER_BY_TOOL_TYPE[toolType]
  }

  return (
    PROVIDER_BY_TOOL_ID_PREFIX.find(({ prefix }) => toolId.startsWith(prefix))?.providerId ?? null
  )
}

function populateCredentialSubBlocks(subBlocks: Record<string, unknown>, credentialId: string) {
  for (const key of ['credential', 'manualCredential', 'triggerCredentials']) {
    const subBlock = subBlocks[key]
    if (isRecord(subBlock)) {
      subBlock.value = credentialId
    }
  }
}

export function populateWorkflowCredentials(
  workflowData: { blocks: Record<string, unknown> },
  credentialsByProvider: Map<string, string>
): CredentialPopulationSummary {
  const populatedProviders = new Set<string>()
  const missingProviders = new Set<string>()

  for (const block of Object.values(workflowData.blocks)) {
    if (!isRecord(block)) {
      continue
    }

    const blockProviderId =
      typeof block.type === 'string' ? PROVIDER_BY_TOOL_TYPE[block.type] : null
    if (blockProviderId && isRecord(block.subBlocks)) {
      const credentialId = credentialsByProvider.get(blockProviderId)
      if (credentialId) {
        populateCredentialSubBlocks(block.subBlocks, credentialId)
        populatedProviders.add(blockProviderId)
        missingProviders.delete(blockProviderId)
      } else {
        missingProviders.add(blockProviderId)
      }
    }

    if (!isRecord(block.subBlocks)) {
      continue
    }

    for (const subBlock of Object.values(block.subBlocks)) {
      if (!isRecord(subBlock) || !Array.isArray(subBlock.value)) {
        continue
      }

      for (const tool of subBlock.value) {
        if (!isRecord(tool)) {
          continue
        }

        const providerId = resolveProviderIdForTool(tool)
        if (!providerId) {
          continue
        }

        const credentialId = credentialsByProvider.get(providerId)
        if (!credentialId) {
          missingProviders.add(providerId)
          continue
        }

        const toolParams = isRecord(tool.params) ? tool.params : {}
        tool.params = toolParams

        toolParams.credentialId = credentialId
        toolParams.oauthCredential = credentialId
        populatedProviders.add(providerId)
        missingProviders.delete(providerId)
      }
    }
  }

  return {
    populatedProviders: Array.from(populatedProviders).sort(),
    missingProviders: Array.from(missingProviders).sort(),
  }
}

export async function getOldestActiveCredentialsByProvider(params: {
  workspaceId: string
  userId: string
}): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: credential.id,
      providerId: credential.providerId,
    })
    .from(credential)
    .innerJoin(
      credentialMember,
      and(
        eq(credentialMember.credentialId, credential.id),
        eq(credentialMember.userId, params.userId),
        eq(credentialMember.status, 'active')
      )
    )
    .where(and(eq(credential.workspaceId, params.workspaceId), eq(credential.type, 'oauth')))
    .orderBy(asc(credential.createdAt))

  const oldestByProvider = new Map<string, string>()

  for (const row of rows) {
    if (!row.providerId || oldestByProvider.has(row.providerId)) {
      continue
    }
    oldestByProvider.set(row.providerId, row.id)
  }

  return oldestByProvider
}

async function buildWorkflowDataFromSource(input: DefaultWorkflowSourceInput) {
  const [sourceWorkflow] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.id, input.sourceWorkflowId), isNull(workflow.archivedAt)))
    .limit(1)

  if (!sourceWorkflow) {
    throw new Error(`Source workflow not found: ${input.sourceWorkflowId}`)
  }

  const normalizedData = await loadWorkflowFromNormalizedTables(input.sourceWorkflowId)
  if (!normalizedData) {
    throw new Error(`Source workflow has no normalized data: ${input.sourceWorkflowId}`)
  }

  const rawWorkflowData = JSON.parse(
    JSON.stringify({
      blocks: normalizedData.blocks,
      edges: normalizedData.edges,
      loops: normalizedData.loops,
      parallels: normalizedData.parallels,
      metadata: {
        name: input.nameOverride || sourceWorkflow.name,
        description: sourceWorkflow.description ?? undefined,
      },
      variables:
        sourceWorkflow.variables && isRecord(sourceWorkflow.variables)
          ? sourceWorkflow.variables
          : undefined,
    })
  )

  // `workflow_blocks.id` is a global primary key; regenerate block/edge IDs so syncing a
  // shared template into multiple user workflows never collides on existing block IDs.
  const { idMap: _idMap, ...workflowData } = regenerateWorkflowIds(
    rawWorkflowData as WorkflowState,
    { clearTriggerRuntimeValues: false }
  )

  const workflowName = input.nameOverride || sourceWorkflow.name

  return { sourceWorkflow, workflowData, workflowName }
}

function enrichWorkflowDataForProvision(params: {
  workflowData: { blocks: Record<string, unknown> }
  credentialsByProvider: Map<string, string>
  postgresConnection?: PostgresConnectionConfig
}): {
  credentialPopulation: CredentialPopulationSummary
  postgresBlocksPopulated: number
} {
  const credentialPopulation = populateWorkflowCredentials(
    params.workflowData,
    params.credentialsByProvider
  )
  const postgresBlocksPopulated = params.postgresConnection
    ? populatePostgresBlocks(params.workflowData, params.postgresConnection)
    : 0

  return { credentialPopulation, postgresBlocksPopulated }
}

async function applyWorkflowStateToTarget(params: {
  targetWorkflowId: string
  input: DefaultWorkflowSourceInput
  credentialsByProvider: Map<string, string>
  postgresConnection?: PostgresConnectionConfig
}): Promise<{
  name: string
  credentialPopulation: CredentialPopulationSummary
  postgresBlocksPopulated: number
  sourceWorkflow: typeof workflow.$inferSelect
  workflowData: WorkflowState
}> {
  const { sourceWorkflow, workflowData, workflowName } = await buildWorkflowDataFromSource(
    params.input
  )
  const { credentialPopulation, postgresBlocksPopulated } = enrichWorkflowDataForProvision({
    workflowData,
    credentialsByProvider: params.credentialsByProvider,
    postgresConnection: params.postgresConnection,
  })
  const now = new Date()

  const saveResult = await saveWorkflowToNormalizedTables(
    params.targetWorkflowId,
    workflowData,
    UNGOVERNED_PERSIST
  )
  if (!saveResult.success) {
    throw new Error(`Failed to save workflow state: ${saveResult.error}`)
  }

  await db
    .update(workflow)
    .set({
      description: sourceWorkflow.description || 'Imported via Admin API',
      variables: sourceWorkflow.variables ?? {},
      defaultAgent: true,
      lastSynced: now,
      updatedAt: now,
    })
    .where(eq(workflow.id, params.targetWorkflowId))

  const [targetWorkflow] = await db
    .select({ name: workflow.name })
    .from(workflow)
    .where(eq(workflow.id, params.targetWorkflowId))
    .limit(1)

  return {
    name: targetWorkflow?.name ?? workflowName,
    credentialPopulation,
    postgresBlocksPopulated,
    sourceWorkflow,
    workflowData,
  }
}

async function findActiveDefaultUserMapping(params: { userId: string; sourceWorkflowId: string }) {
  const [mapping] = await db
    .select()
    .from(defaultUserWorkflows)
    .where(
      and(
        eq(defaultUserWorkflows.userId, params.userId),
        eq(defaultUserWorkflows.sourceWorkflowId, params.sourceWorkflowId),
        isNull(defaultUserWorkflows.archivedAt)
      )
    )
    .limit(1)

  return mapping ?? null
}

async function upsertDefaultUserMapping(params: {
  id?: string
  userId: string
  sourceWorkflowId: string
  userWorkflowId: string
  userWorkspaceId: string
  lastSyncedAt: Date
  lastDeployedVersion?: number
}) {
  const now = new Date()

  if (params.id) {
    await db
      .update(defaultUserWorkflows)
      .set({
        userWorkflowId: params.userWorkflowId,
        userWorkspaceId: params.userWorkspaceId,
        lastSyncedAt: params.lastSyncedAt,
        ...(params.lastDeployedVersion !== undefined && {
          lastDeployedVersion: params.lastDeployedVersion,
        }),
        updatedAt: now,
      })
      .where(eq(defaultUserWorkflows.id, params.id))
    return
  }

  await db.insert(defaultUserWorkflows).values({
    id: generateId(),
    userId: params.userId,
    sourceWorkflowId: params.sourceWorkflowId,
    userWorkflowId: params.userWorkflowId,
    userWorkspaceId: params.userWorkspaceId,
    lastSyncedAt: params.lastSyncedAt,
    lastDeployedVersion: params.lastDeployedVersion ?? null,
    createdAt: now,
    updatedAt: now,
  })
}

async function createDefaultUserWorkflow(params: {
  input: DefaultWorkflowSourceInput
  workspaceId: string
  userId: string
  systemFolderId: string
  mappingId?: string
  credentialsByProvider: Map<string, string>
  postgresConnection?: PostgresConnectionConfig
}): Promise<ProvisionDefaultUserWorkflowResult> {
  const { sourceWorkflow, workflowData, workflowName } = await buildWorkflowDataFromSource(
    params.input
  )
  const { credentialPopulation, postgresBlocksPopulated } = enrichWorkflowDataForProvision({
    workflowData,
    credentialsByProvider: params.credentialsByProvider,
    postgresConnection: params.postgresConnection,
  })

  const workflowId = generateId()
  const now = new Date()
  const dedupedName = await deduplicateWorkflowName(
    workflowName,
    params.workspaceId,
    params.systemFolderId
  )

  await db.insert(workflow).values({
    id: workflowId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    folderId: params.systemFolderId,
    name: dedupedName,
    description: sourceWorkflow.description || 'Imported via Admin API',
    lastSynced: now,
    createdAt: now,
    updatedAt: now,
    isDeployed: false,
    runCount: 0,
    variables: workflowData.variables ?? sourceWorkflow.variables ?? {},
    defaultAgent: true,
  })

  const saveResult = await saveWorkflowToNormalizedTables(
    workflowId,
    workflowData,
    UNGOVERNED_PERSIST
  )
  if (!saveResult.success) {
    await db.delete(workflow).where(eq(workflow.id, workflowId))
    throw new Error(`Failed to save workflow state: ${saveResult.error}`)
  }

  await upsertDefaultUserMapping({
    ...(params.mappingId ? { id: params.mappingId } : {}),
    userId: params.userId,
    sourceWorkflowId: params.input.sourceWorkflowId,
    userWorkflowId: workflowId,
    userWorkspaceId: params.workspaceId,
    lastSyncedAt: now,
  })

  return {
    workflowId,
    name: dedupedName,
    created: true,
    refreshed: false,
    credentialPopulation,
    postgresBlocksPopulated,
  }
}

/**
 * Records deploy metadata on the default-user workflow mapping after a successful deploy.
 */
export async function recordDefaultUserWorkflowDeploy(params: {
  userId: string
  sourceWorkflowId: string
  version?: number
}) {
  const mapping = await findActiveDefaultUserMapping({
    userId: params.userId,
    sourceWorkflowId: params.sourceWorkflowId,
  })

  if (!mapping) {
    return
  }

  await upsertDefaultUserMapping({
    id: mapping.id,
    userId: mapping.userId,
    sourceWorkflowId: mapping.sourceWorkflowId,
    userWorkflowId: mapping.userWorkflowId,
    userWorkspaceId: mapping.userWorkspaceId,
    lastSyncedAt: mapping.lastSyncedAt ?? new Date(),
    lastDeployedVersion: params.version,
  })
}

/**
 * Creates a new default-agent workflow for the user, or refreshes the existing copy from source.
 */
export async function provisionOrRefreshDefaultUserWorkflow(
  params: ProvisionDefaultUserWorkflowParams
): Promise<ProvisionDefaultUserWorkflowResult> {
  const existingMapping = await findActiveDefaultUserMapping({
    userId: params.userId,
    sourceWorkflowId: params.input.sourceWorkflowId,
  })

  if (!existingMapping) {
    const systemFolderId = await getOrCreateSystemDefaultWorkflowFolder({
      workspaceId: params.workspaceId,
      userId: params.userId,
    })
    return createDefaultUserWorkflow({ ...params, systemFolderId })
  }

  const [existingWorkflow] = await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(and(eq(workflow.id, existingMapping.userWorkflowId), isNull(workflow.archivedAt)))
    .limit(1)

  if (!existingWorkflow) {
    const systemFolderId = await getOrCreateSystemDefaultWorkflowFolder({
      workspaceId: params.workspaceId,
      userId: params.userId,
    })
    return createDefaultUserWorkflow({
      ...params,
      systemFolderId,
      mappingId: existingMapping.id,
    })
  }

  const now = new Date()
  const refreshed = await applyWorkflowStateToTarget({
    targetWorkflowId: existingMapping.userWorkflowId,
    input: params.input,
    credentialsByProvider: params.credentialsByProvider,
    postgresConnection: params.postgresConnection,
  })

  await upsertDefaultUserMapping({
    id: existingMapping.id,
    userId: params.userId,
    sourceWorkflowId: params.input.sourceWorkflowId,
    userWorkflowId: existingMapping.userWorkflowId,
    userWorkspaceId: params.workspaceId,
    lastSyncedAt: now,
    lastDeployedVersion: existingMapping.lastDeployedVersion ?? undefined,
  })

  return {
    workflowId: existingMapping.userWorkflowId,
    name: refreshed.name,
    created: false,
    refreshed: true,
    credentialPopulation: refreshed.credentialPopulation,
    postgresBlocksPopulated: refreshed.postgresBlocksPopulated,
  }
}

/**
 * Overwrites all user copies of a source default workflow and optionally redeploys them.
 */
export async function syncDefaultWorkflowsForSource(
  params: SyncDefaultWorkflowsParams
): Promise<SyncDefaultWorkflowsResult> {
  const mappings = await db
    .select()
    .from(defaultUserWorkflows)
    .where(
      and(
        eq(defaultUserWorkflows.sourceWorkflowId, params.sourceWorkflowId),
        isNull(defaultUserWorkflows.archivedAt)
      )
    )

  const results: SyncDefaultWorkflowUserResult[] = []

  for (const mapping of mappings) {
    try {
      const [targetWorkflow] = await db
        .select({
          id: workflow.id,
          name: workflow.name,
          workspaceId: workflow.workspaceId,
          archivedAt: workflow.archivedAt,
        })
        .from(workflow)
        .where(eq(workflow.id, mapping.userWorkflowId))
        .limit(1)

      if (!targetWorkflow || targetWorkflow.archivedAt || !targetWorkflow.workspaceId) {
        results.push({
          userId: mapping.userId,
          userWorkflowId: mapping.userWorkflowId,
          updated: false,
          deployed: false,
          error: 'Target workflow not found or archived',
        })
        continue
      }

      const credentialsByProvider = await getOldestActiveCredentialsByProvider({
        workspaceId: targetWorkflow.workspaceId,
        userId: mapping.userId,
      })

      const refreshed = await applyWorkflowStateToTarget({
        targetWorkflowId: mapping.userWorkflowId,
        input: { sourceWorkflowId: params.sourceWorkflowId, deployAsChat: true },
        credentialsByProvider,
        postgresConnection: params.postgresConnection,
      })

      const now = new Date()
      let deployed = false
      let version: number | undefined
      let deployedAt: string | undefined
      let warnings: string[] | undefined

      if (params.deploy !== false) {
        const deployOptions = {
          requestId: params.requestId,
          actorId: 'admin-api' as const,
        }

        if (!params.deployAsChat) {
          const deployResult = await performFullDeploy({
            workflowId: mapping.userWorkflowId,
            userId: mapping.userId,
            ...deployOptions,
          })

          if (!deployResult.success) {
            await upsertDefaultUserMapping({
              id: mapping.id,
              userId: mapping.userId,
              sourceWorkflowId: params.sourceWorkflowId,
              userWorkflowId: mapping.userWorkflowId,
              userWorkspaceId: mapping.userWorkspaceId,
              lastSyncedAt: now,
            })

            results.push({
              userId: mapping.userId,
              userWorkflowId: mapping.userWorkflowId,
              updated: true,
              deployed: false,
              chatDeployed: false,
              postgresBlocksPopulated: refreshed.postgresBlocksPopulated,
              error: deployResult.error || 'Failed to deploy workflow',
              warnings: deployResult.warnings,
            })
            continue
          }

          deployed = true
          version = deployResult.version
          deployedAt = deployResult.deployedAt?.toISOString()
          warnings = deployResult.warnings

          await upsertDefaultUserMapping({
            id: mapping.id,
            userId: mapping.userId,
            sourceWorkflowId: params.sourceWorkflowId,
            userWorkflowId: mapping.userWorkflowId,
            userWorkspaceId: mapping.userWorkspaceId,
            lastSyncedAt: now,
            lastDeployedVersion: deployResult.version,
          })

          results.push({
            userId: mapping.userId,
            userWorkflowId: mapping.userWorkflowId,
            updated: true,
            deployed: true,
            chatDeployed: false,
            postgresBlocksPopulated: refreshed.postgresBlocksPopulated,
            version,
            deployedAt,
            warnings,
          })
          continue
        }

        const [targetUser] = await db
          .select({ email: user.email })
          .from(user)
          .where(eq(user.id, mapping.userId))
          .limit(1)

        if (!targetUser?.email) {
          results.push({
            userId: mapping.userId,
            userWorkflowId: mapping.userWorkflowId,
            updated: true,
            deployed: false,
            chatDeployed: false,
            postgresBlocksPopulated: refreshed.postgresBlocksPopulated,
            error: 'User email not found for chat deploy',
          })
          continue
        }

        const [workflowRecord] = await db
          .select({ description: workflow.description })
          .from(workflow)
          .where(eq(workflow.id, mapping.userWorkflowId))
          .limit(1)

        const outputConfigs = await resolveChatOutputConfigs(
          mapping.userWorkflowId,
          params.chatOutputConfigs ?? []
        )

        const chatDeployResult = await performChatDeploy({
          workflowId: mapping.userWorkflowId,
          userId: mapping.userId,
          identifier: mapping.userWorkflowId,
          title: refreshed.name,
          description: workflowRecord?.description ?? '',
          department: DEFAULT_CHAT_DEPARTMENT,
          customizations: { welcomeMessage: DEFAULT_CHAT_WELCOME_MESSAGE },
          authType: DEFAULT_CHAT_AUTH_TYPE,
          allowedEmails: [targetUser.email],
          outputConfigs,
          workspaceId: targetWorkflow.workspaceId,
          requestId: deployOptions.requestId,
          actorId: deployOptions.actorId,
        })

        if (!chatDeployResult.success) {
          await upsertDefaultUserMapping({
            id: mapping.id,
            userId: mapping.userId,
            sourceWorkflowId: params.sourceWorkflowId,
            userWorkflowId: mapping.userWorkflowId,
            userWorkspaceId: mapping.userWorkspaceId,
            lastSyncedAt: now,
          })

          results.push({
            userId: mapping.userId,
            userWorkflowId: mapping.userWorkflowId,
            updated: true,
            deployed: false,
            chatDeployed: false,
            postgresBlocksPopulated: refreshed.postgresBlocksPopulated,
            error: chatDeployResult.error || 'Failed to deploy chat',
          })
          continue
        }

        deployed = true
        version = chatDeployResult.version
        deployedAt = chatDeployResult.deployedAt?.toISOString()

        await upsertDefaultUserMapping({
          id: mapping.id,
          userId: mapping.userId,
          sourceWorkflowId: params.sourceWorkflowId,
          userWorkflowId: mapping.userWorkflowId,
          userWorkspaceId: mapping.userWorkspaceId,
          lastSyncedAt: now,
          lastDeployedVersion: chatDeployResult.version,
        })

        results.push({
          userId: mapping.userId,
          userWorkflowId: mapping.userWorkflowId,
          updated: true,
          deployed: true,
          chatDeployed: true,
          chatId: chatDeployResult.chatId,
          chatUrl: chatDeployResult.chatUrl,
          postgresBlocksPopulated: refreshed.postgresBlocksPopulated,
          version,
          deployedAt,
        })
        continue
      }
      await upsertDefaultUserMapping({
        id: mapping.id,
        userId: mapping.userId,
        sourceWorkflowId: params.sourceWorkflowId,
        userWorkflowId: mapping.userWorkflowId,
        userWorkspaceId: mapping.userWorkspaceId,
        lastSyncedAt: now,
      })

      results.push({
        userId: mapping.userId,
        userWorkflowId: mapping.userWorkflowId,
        updated: true,
        deployed,
        postgresBlocksPopulated: refreshed.postgresBlocksPopulated,
        version,
        deployedAt,
        warnings,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to sync default workflow for user', {
        userId: mapping.userId,
        userWorkflowId: mapping.userWorkflowId,
        sourceWorkflowId: params.sourceWorkflowId,
        error: message,
      })
      results.push({
        userId: mapping.userId,
        userWorkflowId: mapping.userWorkflowId,
        updated: false,
        deployed: false,
        error: message,
      })
    }
  }

  return {
    sourceWorkflowId: params.sourceWorkflowId,
    total: mappings.length,
    updated: results.filter((result) => result.updated).length,
    deployed: results.filter((result) => result.deployed).length,
    failed: results.filter((result) => result.error).length,
    results,
  }
}
