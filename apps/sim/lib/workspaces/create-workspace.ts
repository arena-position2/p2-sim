import { db } from '@sim/db'
import { permissions, type WorkspaceMode, workflow, workspace } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { generateId } from '@sim/utils/id'
import { ensureUserInOrganization } from '@/lib/billing/organizations/membership'
import { PlatformEvents } from '@/lib/core/telemetry'
import { seedGeneralSkillsIntoWorkspace } from '@/lib/skill-share/repository'
import { buildDefaultWorkflowArtifacts } from '@/lib/workflows/defaults'
import { saveWorkflowToNormalizedTables } from '@/lib/workflows/persistence/utils'
import { getRandomWorkspaceColor } from '@/lib/workspaces/colors'
import {
  getOrganizationOwnerId,
  getWorkspaceInvitePolicy,
  userHasPersonalWorkspace,
  WORKSPACE_MODE,
} from '@/lib/workspaces/policy'

const logger = createLogger('CreateWorkspace')

export interface CreateWorkspaceParams {
  userId: string
  name: string
  skipDefaultWorkflow?: boolean
  explicitColor?: string
  organizationId: string | null
  workspaceMode: WorkspaceMode
  billedAccountUserId: string
  isPersonal: boolean
}

/**
 * Creates a workspace with owner admin permission and an optional default workflow.
 */
export async function createWorkspace({
  userId,
  name,
  skipDefaultWorkflow = false,
  explicitColor,
  organizationId,
  workspaceMode,
  billedAccountUserId,
  isPersonal,
}: CreateWorkspaceParams) {
  const workspaceId = generateId()
  const workflowId = generateId()
  const now = new Date()
  const color = explicitColor || getRandomWorkspaceColor()

  try {
    await db.transaction(async (tx) => {
      await tx.insert(workspace).values({
        id: workspaceId,
        name,
        color,
        ownerId: userId,
        organizationId,
        workspaceMode,
        isPersonal,
        billedAccountUserId,
        allowPersonalApiKeys: true,
        createdAt: now,
        updatedAt: now,
      })

      const permissionRows = [
        {
          id: generateId(),
          entityType: 'workspace' as const,
          entityId: workspaceId,
          userId,
          permissionType: 'admin' as const,
          createdAt: now,
          updatedAt: now,
        },
      ]

      if (
        workspaceMode === WORKSPACE_MODE.ORGANIZATION &&
        billedAccountUserId &&
        billedAccountUserId !== userId
      ) {
        permissionRows.push({
          id: generateId(),
          entityType: 'workspace' as const,
          entityId: workspaceId,
          userId: billedAccountUserId,
          permissionType: 'admin' as const,
          createdAt: now,
          updatedAt: now,
        })
      }

      await tx.insert(permissions).values(permissionRows)

      if (!skipDefaultWorkflow) {
        await tx.insert(workflow).values({
          id: workflowId,
          userId,
          workspaceId,
          folderId: null,
          name: 'default-agent',
          description: 'Your first workflow - start building here!',
          lastSynced: now,
          createdAt: now,
          updatedAt: now,
          isDeployed: false,
          runCount: 0,
          variables: {},
        })

        const { workflowState } = buildDefaultWorkflowArtifacts()
        await saveWorkflowToNormalizedTables(
          workflowId,
          workflowState,
          { workspaceId, subjectUserId: null },
          tx
        )
      }

      logger.info(
        skipDefaultWorkflow
          ? `Created ${workspaceMode} workspace ${workspaceId} for user ${userId}`
          : `Created ${workspaceMode} workspace ${workspaceId} with initial workflow ${workflowId} for user ${userId}`
      )
    })
  } catch (error) {
    logger.error(`Failed to create workspace ${workspaceId}:`, error)
    throw error
  }

  try {
    await seedGeneralSkillsIntoWorkspace({
      workspaceId,
      ownerUserId: userId,
    })
  } catch (error) {
    logger.error('Failed to seed general catalog skills into new workspace', {
      workspaceId,
      error,
    })
  }

  try {
    PlatformEvents.workspaceCreated({
      workspaceId,
      userId,
      name,
    })
  } catch {
    // Telemetry should not fail the operation
  }

  const invitePolicy = await getWorkspaceInvitePolicy({
    organizationId,
    workspaceMode,
    billedAccountUserId,
    ownerId: userId,
  })
  const callerIsBilledUser = billedAccountUserId === userId
  const canActOnUpgrade = invitePolicy.upgradeRequired && callerIsBilledUser

  return {
    id: workspaceId,
    name,
    color,
    ownerId: userId,
    organizationId,
    workspaceMode,
    isPersonal,
    billedAccountUserId,
    allowPersonalApiKeys: true,
    createdAt: now,
    updatedAt: now,
    role: 'owner' as const,
    permissions: 'admin' as const,
    inviteMembersEnabled: invitePolicy.allowed,
    inviteDisabledReason: null,
    inviteUpgradeRequired: canActOnUpgrade,
  }
}

/**
 * Creates the default workspace for a user with no workspaces, using the
 * resolved creation policy (typically an org-attached personal workspace).
 */
export async function createDefaultWorkspace(
  userId: string,
  userName: string | null | undefined,
  creationPolicy: {
    organizationId: string | null
    workspaceMode: WorkspaceMode
    billedAccountUserId: string
    isPersonal: boolean
  }
) {
  const firstName = userName?.split(' ')[0] || null
  const workspaceName = firstName ? `${firstName}'s Workspace` : 'My Workspace'
  return createWorkspace({
    userId,
    name: workspaceName,
    organizationId: creationPolicy.organizationId,
    workspaceMode: creationPolicy.workspaceMode,
    billedAccountUserId: creationPolicy.billedAccountUserId,
    isPersonal: creationPolicy.isPersonal,
  })
}

function defaultPersonalWorkspaceName(userName?: string | null): string {
  const firstName = userName?.split(' ')[0]?.trim() || null
  return firstName ? `${firstName}'s Workspace` : 'My Workspace'
}

/**
 * Ensures a personal workspace exists after a successful email/password signup.
 * When `organizationId` is provided, adds the user as an org member and creates
 * an org-attached personal workspace (`isPersonal: true`). Otherwise creates a
 * standalone personal workspace. Idempotent when a personal workspace already exists.
 */
export async function ensurePersonalWorkspaceOnEmailSignup({
  userId,
  userName,
  organizationId,
}: {
  userId: string
  userName?: string | null
  organizationId?: string | null
}) {
  if (await userHasPersonalWorkspace(userId)) {
    logger.info('Skipping personal workspace creation; user already has one', { userId })
    return null
  }

  const workspaceName = defaultPersonalWorkspaceName(userName)
  const trimmedOrganizationId = organizationId?.trim() || null

  if (!trimmedOrganizationId) {
    return createWorkspace({
      userId,
      name: workspaceName,
      organizationId: null,
      workspaceMode: WORKSPACE_MODE.PERSONAL,
      billedAccountUserId: userId,
      isPersonal: true,
    })
  }

  const membership = await ensureUserInOrganization({
    userId,
    organizationId: trimmedOrganizationId,
    role: 'member',
  })

  if (!membership.success) {
    logger.error('Failed to add user to organization during email signup', {
      userId,
      organizationId: trimmedOrganizationId,
      error: membership.error,
      failureCode: membership.failureCode,
    })
    throw new Error(membership.error || 'Failed to add user to organization')
  }

  const billedAccountUserId = (await getOrganizationOwnerId(trimmedOrganizationId)) ?? userId

  return createWorkspace({
    userId,
    name: workspaceName,
    organizationId: trimmedOrganizationId,
    workspaceMode: WORKSPACE_MODE.ORGANIZATION,
    billedAccountUserId,
    isPersonal: true,
  })
}
