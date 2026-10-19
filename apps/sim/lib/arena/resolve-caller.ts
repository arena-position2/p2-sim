import { db } from '@sim/db'
import { user, userArenaDetails, workflow } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { eq } from 'drizzle-orm'
import type { NextRequest } from 'next/server'
import {
  type ArenaAuthMode,
  resolveArenaAuthMode,
  SIM_EXECUTION_ID_HEADER,
  SIM_TRIGGER_TYPE_HEADER,
  SIM_WORKFLOW_ID_HEADER,
} from '@/lib/arena/auth'
import { getSession } from '@/lib/auth'
import { verifyInternalToken } from '@/lib/auth/internal'

const logger = createLogger('ArenaResolveCaller')

const POSITION2_DOMAIN = '@position2.com'

function isAllowedEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(POSITION2_DOMAIN)
}

export type ArenaCaller = {
  mode: ArenaAuthMode
  /** Sim user whose Arena identity is used (SSO tokens or acting sysId lookup). */
  userId: string
  email: string
  name: string
  timezone: string | null
  persona: string | null
  workflowId?: string
  executionId?: string
  triggerType?: string
}

export type ArenaCallerResult =
  | { found: true; caller: ArenaCaller }
  | { found: false; reason: string }

async function resolveAuthorizedUserId(
  req: NextRequest
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const { searchParams } = new URL(req.url)
  const paramUserId = searchParams.get('userId')?.trim()

  const session = await getSession()
  if (session?.user?.id) {
    const sessionUserId = session.user.id
    if (paramUserId && paramUserId !== sessionUserId) {
      return { ok: false, reason: 'userId param must match logged-in user' }
    }
    return { ok: true, userId: sessionUserId }
  }

  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1]
    const verification = await verifyInternalToken(token)
    if (verification.valid) {
      const userId = paramUserId ?? verification.userId
      if (!userId) {
        return { ok: false, reason: 'Missing required param: userId (logged-in user)' }
      }
      return { ok: true, userId }
    }
  }

  return { ok: false, reason: 'Unauthorized - No session or valid internal token' }
}

async function loadUserProfile(userId: string): Promise<{
  email: string
  name: string
  timezone: string | null
  persona: string | null
} | null> {
  const userRow = await db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)

  if (userRow.length === 0 || !userRow[0].email) return null
  if (!isAllowedEmail(userRow[0].email)) {
    logger.warn('Arena caller rejected: email domain not allowed', { userId })
    return null
  }

  const details = await db
    .select({
      timezone: userArenaDetails.timezone,
      persona: userArenaDetails.persona,
    })
    .from(userArenaDetails)
    .where(eq(userArenaDetails.userIdRef, userId))
    .limit(1)

  return {
    email: userRow[0].email,
    name: userRow[0].name ?? '',
    timezone: details[0]?.timezone ?? null,
    persona: details[0]?.persona ?? null,
  }
}

async function resolveWorkflowOwnerUserId(workflowId: string): Promise<string | null> {
  const wf = await db
    .select({ userId: workflow.userId })
    .from(workflow)
    .where(eq(workflow.id, workflowId))
    .limit(1)
  return wf[0]?.userId ?? null
}

/**
 * Resolves who Arena sol should act as for this tool-route request.
 * Schedule/webhook → automation mode with workflow owner identity.
 * Otherwise → human SSO for the authorized Sim user (session / internal JWT).
 */
export async function resolveArenaCaller(
  req: NextRequest,
  workflowId?: string | null
): Promise<ArenaCallerResult> {
  const triggerType =
    req.headers.get(SIM_TRIGGER_TYPE_HEADER)?.trim() ||
    new URL(req.url).searchParams.get('triggerType')?.trim() ||
    undefined
  const executionId =
    req.headers.get(SIM_EXECUTION_ID_HEADER)?.trim() ||
    new URL(req.url).searchParams.get('executionId')?.trim() ||
    undefined
  const headerWorkflowId = req.headers.get(SIM_WORKFLOW_ID_HEADER)?.trim()
  const resolvedWorkflowId = workflowId?.trim() || headerWorkflowId || undefined

  const mode = resolveArenaAuthMode(triggerType)

  if (mode === 'automation') {
    if (!resolvedWorkflowId) {
      return {
        found: false,
        reason: 'workflowId is required for Arena automation (schedule/webhook)',
      }
    }
    const ownerUserId = await resolveWorkflowOwnerUserId(resolvedWorkflowId)
    if (!ownerUserId) {
      return { found: false, reason: 'Workflow not found or has no owner' }
    }
    const profile = await loadUserProfile(ownerUserId)
    if (!profile) {
      return {
        found: false,
        reason: 'Workflow owner not found or email domain not allowed',
      }
    }
    return {
      found: true,
      caller: {
        mode: 'automation',
        userId: ownerUserId,
        email: profile.email,
        name: profile.name,
        timezone: profile.timezone,
        persona: profile.persona,
        workflowId: resolvedWorkflowId,
        executionId,
        triggerType,
      },
    }
  }

  const authorized = await resolveAuthorizedUserId(req)
  let userId: string | null = authorized.ok ? authorized.userId : null

  if (!userId && resolvedWorkflowId) {
    userId = await resolveWorkflowOwnerUserId(resolvedWorkflowId)
  }
  if (!userId) {
    return {
      found: false,
      reason: authorized.ok ? 'User not resolved' : authorized.reason,
    }
  }

  const profile = await loadUserProfile(userId)
  if (!profile) {
    return { found: false, reason: 'User not found or email domain not allowed' }
  }

  return {
    found: true,
    caller: {
      mode: 'human',
      userId,
      email: profile.email,
      name: profile.name,
      timezone: profile.timezone,
      persona: profile.persona,
      workflowId: resolvedWorkflowId,
      executionId,
      triggerType,
    },
  }
}
