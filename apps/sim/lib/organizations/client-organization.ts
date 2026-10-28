/**
 * Ensure a Sim user belongs to the organization mapped to an external client id,
 * then provision personal + shared (non-personal) org workspaces.
 *
 * First caller for a client creates the org (user = owner), mapping, personal WS,
 * and `{clientName} Workspace`. Later callers join as members, get a personal WS,
 * and receive admin on every non-personal workspace in the org.
 */

import { db } from '@sim/db'
import {
  clientOrganization,
  member,
  organization,
  permissions,
  user,
  workspace,
} from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { generateId } from '@sim/utils/id'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { applySessionPolicyToNewMember } from '@/lib/auth/session-policy'
import { isArenaBilling, provisionClientOrgStarterBilling } from '@/lib/billing/arena'
import { getOrganizationSubscription } from '@/lib/billing/core/billing'
import { syncUsageLimitsFromSubscription } from '@/lib/billing/core/usage'
import {
  createOrganizationWithOwnerTx,
  validateOrganizationSlugOrThrow,
} from '@/lib/billing/organizations/create-organization'
import {
  ensureUserInOrganizationTx,
  type MembershipAdditionFailureCode,
} from '@/lib/billing/organizations/membership'
import { reconcileOrganizationSeats } from '@/lib/billing/organizations/seats'
import { isEnterprise } from '@/lib/billing/plan-helpers'
import { isBillingEnabled } from '@/lib/core/config/env-flags'
import type { DbOrTx, DbTransaction } from '@/lib/db/types'
import { acquireInvitationMutationLocks } from '@/lib/invitations/locks'
import { createWorkspace } from '@/lib/workspaces/create-workspace'
import {
  attachOwnedWorkspacesToOrganizationTx,
  ownedAttachableWorkspacesWhere,
} from '@/lib/workspaces/organization-workspaces'
import { getOrganizationOwnerId, WORKSPACE_MODE } from '@/lib/workspaces/policy'

const logger = createLogger('ClientOrganization')

const CLIENT_ORG_LOCK_TIMEOUT_MS = 10_000

export type EnsureClientOrganizationMemberAction =
  | 'organization_created'
  | 'member_added'
  | 'already_member'

export type EnsureClientOrganizationMemberFailureCode =
  | 'user-not-found'
  | 'already-in-other-organization'
  | 'invalid-organization-name'
  | 'invalid-client-id'
  | 'workspace-set-changed'
  | 'internal-error'
  | MembershipAdditionFailureCode

export interface EnsureClientOrganizationMemberParams {
  clientId: string
  clientName: string
  organizationName: string
  userId: string
}

export type EnsureClientOrganizationMemberResult =
  | {
      success: true
      clientId: string
      clientName: string
      organizationId: string
      memberId: string
      role: 'owner' | 'admin' | 'member'
      action: EnsureClientOrganizationMemberAction
      personalWorkspaceId: string | null
      sharedWorkspaceIds: string[]
      attachedWorkspaceIds: string[]
    }
  | {
      success: false
      error: string
      failureCode: EnsureClientOrganizationMemberFailureCode
      existingOrgId?: string
    }

class WorkspaceSetChangedDuringEnsureError extends Error {
  constructor() {
    super('Owned workspaces changed while ensuring client organization membership')
    this.name = 'WorkspaceSetChangedDuringEnsureError'
  }
}

/**
 * Builds a stable org slug from the external client id.
 * Falls back to a generated suffix when sanitization yields an empty string.
 */
export function slugFromClientId(clientId: string): string {
  const sanitized = clientId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const base = sanitized.length > 0 ? sanitized : `id-${generateId().slice(0, 12)}`
  const slug = `client-${base}`.slice(0, 80)
  validateOrganizationSlugOrThrow(slug)
  return slug
}

export function clientSharedWorkspaceName(clientName: string): string {
  return `${clientName.trim()} Workspace`
}

function personalWorkspaceName(userName?: string | null): string {
  const firstName = userName?.split(' ')[0]?.trim() || null
  return firstName ? `${firstName}'s Workspace` : 'My Workspace'
}

async function acquireClientOrganizationLock(tx: DbOrTx, clientId: string): Promise<void> {
  await tx.execute(
    sql`select set_config('lock_timeout', ${`${CLIENT_ORG_LOCK_TIMEOUT_MS}ms`}, true)`
  )
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`client-organization:${clientId}`}, 0))`
  )
}

async function attachOwnedWorkspacesInTx(
  tx: DbTransaction,
  params: { userId: string; organizationId: string }
): Promise<{ attachedWorkspaceIds: string[]; usageLimitUserIds: string[] }> {
  const { userId, organizationId } = params
  const ownedWorkspaceIds = (
    await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(ownedAttachableWorkspacesWhere({ userId, includeArchived: true }))
  ).map((row) => row.id)

  if (ownedWorkspaceIds.length > 0) {
    await acquireInvitationMutationLocks(tx, {
      invitationIds: [],
      workspaceIds: ownedWorkspaceIds,
    })
  }

  const currentOwnedIds = (
    await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(ownedAttachableWorkspacesWhere({ userId, includeArchived: true }))
  ).map((row) => row.id)

  if ([...currentOwnedIds].sort().join() !== [...ownedWorkspaceIds].sort().join()) {
    throw new WorkspaceSetChangedDuringEnsureError()
  }

  if (ownedWorkspaceIds.length === 0) {
    return { attachedWorkspaceIds: [], usageLimitUserIds: [] }
  }

  const attach = await attachOwnedWorkspacesToOrganizationTx(tx, {
    ownerUserId: userId,
    organizationId,
    workspaceIds: ownedWorkspaceIds,
    externalMemberPolicy: 'external-all',
    ownerMatch: 'owner',
    includeArchived: true,
  })

  return {
    attachedWorkspaceIds: attach.attachedWorkspaceIds,
    usageLimitUserIds: attach.usageLimitUserIds,
  }
}

async function findOwnedPersonalWorkspaceId(
  userId: string,
  organizationId: string
): Promise<string | null> {
  const [row] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(
      and(
        eq(workspace.ownerId, userId),
        eq(workspace.isPersonal, true),
        eq(workspace.organizationId, organizationId),
        isNull(workspace.archivedAt)
      )
    )
    .limit(1)

  return row?.id ?? null
}

async function listNonPersonalOrgWorkspaceIds(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(
      and(
        eq(workspace.organizationId, organizationId),
        eq(workspace.isPersonal, false),
        isNull(workspace.archivedAt)
      )
    )

  return rows.map((row) => row.id)
}

async function grantWorkspaceAdmin(userId: string, workspaceIds: string[]): Promise<void> {
  if (workspaceIds.length === 0) return

  const now = new Date()
  await db
    .insert(permissions)
    .values(
      workspaceIds.map((workspaceId) => ({
        id: generateId(),
        userId,
        entityType: 'workspace' as const,
        entityId: workspaceId,
        permissionType: 'admin' as const,
        createdAt: now,
        updatedAt: now,
      }))
    )
    .onConflictDoUpdate({
      target: [permissions.userId, permissions.entityType, permissions.entityId],
      set: { permissionType: 'admin', updatedAt: now },
    })
}

/**
 * Creates an org-attached personal workspace when the user does not already own one
 * in this organization (e.g. signup created a standalone personal WS that was attached).
 */
async function ensurePersonalWorkspace(params: {
  userId: string
  userName: string | null
  organizationId: string
  billedAccountUserId: string
}): Promise<{ personalWorkspaceId: string | null; created: boolean }> {
  const existing = await findOwnedPersonalWorkspaceId(params.userId, params.organizationId)
  if (existing) {
    return { personalWorkspaceId: existing, created: false }
  }

  const created = await createWorkspace({
    userId: params.userId,
    name: personalWorkspaceName(params.userName),
    organizationId: params.organizationId,
    workspaceMode: WORKSPACE_MODE.ORGANIZATION,
    billedAccountUserId: params.billedAccountUserId,
    isPersonal: true,
  })

  return { personalWorkspaceId: created.id, created: true }
}

/**
 * Ensures at least one non-personal shared workspace exists for the client org,
 * then grants the user admin on every non-personal org workspace.
 */
async function ensureSharedWorkspaces(params: {
  userId: string
  clientName: string
  organizationId: string
  billedAccountUserId: string
  createIfMissing: boolean
}): Promise<{ sharedWorkspaceIds: string[]; createdClientWorkspaceId: string | null }> {
  let sharedWorkspaceIds = await listNonPersonalOrgWorkspaceIds(params.organizationId)
  let createdClientWorkspaceId: string | null = null

  if (sharedWorkspaceIds.length === 0 && params.createIfMissing) {
    const created = await createWorkspace({
      userId: params.userId,
      name: clientSharedWorkspaceName(params.clientName),
      organizationId: params.organizationId,
      workspaceMode: WORKSPACE_MODE.ORGANIZATION,
      billedAccountUserId: params.billedAccountUserId,
      isPersonal: false,
    })
    createdClientWorkspaceId = created.id
    sharedWorkspaceIds = [created.id]
  }

  await grantWorkspaceAdmin(params.userId, sharedWorkspaceIds)

  return { sharedWorkspaceIds, createdClientWorkspaceId }
}

/**
 * Idempotent: creates the client→org mapping + org on first call, then adds users
 * as members. Concurrent first calls for the same clientId serialize on an advisory lock.
 * After membership, provisions personal + shared workspaces.
 */
export async function ensureClientOrganizationMember(
  params: EnsureClientOrganizationMemberParams
): Promise<EnsureClientOrganizationMemberResult> {
  const clientId = params.clientId.trim()
  const clientName = params.clientName.trim()
  const organizationName = params.organizationName.trim()
  const { userId } = params

  if (!clientId) {
    return { success: false, error: 'clientId is required', failureCode: 'invalid-client-id' }
  }
  if (!organizationName) {
    return {
      success: false,
      error: 'organizationName is required',
      failureCode: 'invalid-organization-name',
    }
  }

  try {
    const membershipResult = await db.transaction(async (tx) => {
      await acquireClientOrganizationLock(tx, clientId)

      const [userRow] = await tx
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1)

      if (!userRow) {
        return {
          success: false as const,
          error: 'User not found',
          failureCode: 'user-not-found' as const,
        }
      }

      const [mapping] = await tx
        .select({
          id: clientOrganization.id,
          clientName: clientOrganization.clientName,
          organizationId: clientOrganization.organizationId,
        })
        .from(clientOrganization)
        .where(eq(clientOrganization.clientId, clientId))
        .limit(1)

      if (!mapping) {
        const [existingMembership] = await tx
          .select({ organizationId: member.organizationId })
          .from(member)
          .where(eq(member.userId, userId))
          .limit(1)

        if (existingMembership) {
          return {
            success: false as const,
            error:
              'User is already a member of another organization. Users can only belong to one organization at a time.',
            failureCode: 'already-in-other-organization' as const,
            existingOrgId: existingMembership.organizationId,
          }
        }

        const slug = slugFromClientId(clientId)
        const created = await createOrganizationWithOwnerTx(tx, {
          ownerUserId: userId,
          name: organizationName,
          slug,
          metadata: { clientId, clientName },
        })

        if (isBillingEnabled && isArenaBilling()) {
          await provisionClientOrgStarterBilling(tx, {
            organizationId: created.organizationId,
            clientId,
          })
        }

        const now = new Date()
        const resolvedClientName = clientName || organizationName
        await tx.insert(clientOrganization).values({
          id: generateId(),
          clientId,
          clientName: resolvedClientName,
          organizationId: created.organizationId,
          createdAt: now,
          updatedAt: now,
        })

        const attach = await attachOwnedWorkspacesInTx(tx, {
          userId,
          organizationId: created.organizationId,
        })

        return {
          success: true as const,
          clientId,
          clientName: resolvedClientName,
          organizationId: created.organizationId,
          memberId: created.memberId,
          role: 'owner' as const,
          action: 'organization_created' as const,
          userName: userRow.name,
          attachedWorkspaceIds: attach.attachedWorkspaceIds,
          usageLimitUserIds: attach.usageLimitUserIds,
        }
      }

      if (clientName && clientName !== mapping.clientName) {
        await tx
          .update(clientOrganization)
          .set({ clientName, updatedAt: new Date() })
          .where(eq(clientOrganization.id, mapping.id))
      }

      const [orgRow] = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, mapping.organizationId))
        .limit(1)

      if (!orgRow) {
        return {
          success: false as const,
          error: 'Mapped organization no longer exists',
          failureCode: 'organization-not-found' as const,
        }
      }

      const resolvedClientName = clientName || mapping.clientName

      const [existingMember] = await tx
        .select({ id: member.id, role: member.role, organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, userId))
        .limit(1)

      if (existingMember) {
        if (existingMember.organizationId !== mapping.organizationId) {
          return {
            success: false as const,
            error:
              'User is already a member of another organization. Users can only belong to one organization at a time.',
            failureCode: 'already-in-other-organization' as const,
            existingOrgId: existingMember.organizationId,
          }
        }

        const attach = await attachOwnedWorkspacesInTx(tx, {
          userId,
          organizationId: mapping.organizationId,
        })

        return {
          success: true as const,
          clientId,
          clientName: resolvedClientName,
          organizationId: mapping.organizationId,
          memberId: existingMember.id,
          role: (existingMember.role === 'owner' || existingMember.role === 'admin'
            ? existingMember.role
            : 'member') as 'owner' | 'admin' | 'member',
          action: 'already_member' as const,
          userName: userRow.name,
          attachedWorkspaceIds: attach.attachedWorkspaceIds,
          usageLimitUserIds: attach.usageLimitUserIds,
        }
      }

      const organizationSubscription = isBillingEnabled
        ? await getOrganizationSubscription(mapping.organizationId, { executor: tx })
        : null
      /**
       * Only Enterprise has a hard seat cap. Arena Starter / flat Team plans are
       * org-priced (not per-seat); validating against `getEffectiveSeats` would
       * reject every add because Starter capacity resolves to 0 and Team seats
       * equal the current member count. Matches admin members + invitation paths.
       */
      const organizationHasFixedSeats = isEnterprise(organizationSubscription?.plan)

      const membership = await ensureUserInOrganizationTx(tx, {
        userId,
        organizationId: mapping.organizationId,
        role: 'member',
        skipBillingLogic: !isBillingEnabled,
        skipSeatValidation: isBillingEnabled && !organizationHasFixedSeats,
      })

      if (!membership.success || !membership.memberId) {
        return {
          success: false as const,
          error: membership.error || 'Failed to add member',
          failureCode: (membership.failureCode ||
            'no-seats-available') as EnsureClientOrganizationMemberFailureCode,
          existingOrgId: membership.existingOrgId,
        }
      }

      const attach = await attachOwnedWorkspacesInTx(tx, {
        userId,
        organizationId: mapping.organizationId,
      })

      return {
        success: true as const,
        clientId,
        clientName: resolvedClientName,
        organizationId: mapping.organizationId,
        memberId: membership.memberId,
        role: 'member' as const,
        action: 'member_added' as const,
        userName: userRow.name,
        attachedWorkspaceIds: attach.attachedWorkspaceIds,
        usageLimitUserIds: attach.usageLimitUserIds,
      }
    })

    if (!membershipResult.success) {
      return membershipResult
    }

    if (
      membershipResult.action === 'member_added' ||
      membershipResult.action === 'organization_created'
    ) {
      try {
        await applySessionPolicyToNewMember(userId, membershipResult.organizationId)
      } catch (error) {
        logger.error('Failed to apply session policy after client org ensure', {
          userId,
          organizationId: membershipResult.organizationId,
          error,
        })
      }
    }

    if (isBillingEnabled && membershipResult.action === 'member_added') {
      try {
        await reconcileOrganizationSeats({
          organizationId: membershipResult.organizationId,
          reason: 'client-organization-member-added',
        })
      } catch (seatError) {
        logger.error('Failed to reconcile seats after client org member add', {
          userId,
          organizationId: membershipResult.organizationId,
          error: seatError,
        })
      }
    }

    for (const limitUserId of new Set(membershipResult.usageLimitUserIds)) {
      try {
        await syncUsageLimitsFromSubscription(limitUserId)
      } catch (syncError) {
        logger.error('Failed to sync usage limits after client org ensure', {
          userId: limitUserId,
          organizationId: membershipResult.organizationId,
          error: syncError,
        })
      }
    }

    const billedAccountUserId =
      (await getOrganizationOwnerId(membershipResult.organizationId)) ?? userId

    const personal = await ensurePersonalWorkspace({
      userId,
      userName: membershipResult.userName,
      organizationId: membershipResult.organizationId,
      billedAccountUserId,
    })

    const shared = await ensureSharedWorkspaces({
      userId,
      clientName: membershipResult.clientName,
      organizationId: membershipResult.organizationId,
      billedAccountUserId,
      // Create the client shared workspace on first provision, or recover if it
      // was missing after a crash between org create and workspace create.
      createIfMissing: true,
    })

    logger.info('Ensured client organization membership and workspaces', {
      clientId: membershipResult.clientId,
      organizationId: membershipResult.organizationId,
      userId,
      action: membershipResult.action,
      role: membershipResult.role,
      personalWorkspaceId: personal.personalWorkspaceId,
      sharedWorkspaceIds: shared.sharedWorkspaceIds,
      createdClientWorkspaceId: shared.createdClientWorkspaceId,
      personalCreated: personal.created,
    })

    return {
      success: true,
      clientId: membershipResult.clientId,
      clientName: membershipResult.clientName,
      organizationId: membershipResult.organizationId,
      memberId: membershipResult.memberId,
      role: membershipResult.role,
      action: membershipResult.action,
      personalWorkspaceId: personal.personalWorkspaceId,
      sharedWorkspaceIds: shared.sharedWorkspaceIds,
      attachedWorkspaceIds: membershipResult.attachedWorkspaceIds,
    }
  } catch (error) {
    if (error instanceof WorkspaceSetChangedDuringEnsureError) {
      return {
        success: false,
        error: error.message,
        failureCode: 'workspace-set-changed',
      }
    }

    logger.error('Failed to ensure client organization member', {
      clientId,
      userId,
      error,
    })

    return {
      success: false,
      error: getErrorMessage(error, 'Failed to ensure client organization member'),
      failureCode: 'internal-error',
    }
  }
}
