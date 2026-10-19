import { db } from '@sim/db'
import { userArenaDetails, workflow } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { getHumanArenaAccessToken } from '@/lib/arena/tokens'
import type { WorkflowTokenLookup } from '@/app/api/tools/arena/utils/types'

/**
 * Interactive fallback: human SSO access token for a workflow's owner.
 */
export async function getArenaTokenByWorkflowId(workflowId: string): Promise<WorkflowTokenLookup> {
  const wf = await db
    .select({
      id: workflow.id,
      userId: workflow.userId,
    })
    .from(workflow)
    .where(eq(workflow.id, workflowId))
    .limit(1)

  if (wf.length === 0) {
    return { found: false, reason: 'Workflow not found' }
  }

  const { userId } = wf[0]

  if (!userId) {
    return { found: false, reason: 'Workflow has no userId' }
  }

  const details = await db
    .select({
      timezone: userArenaDetails.timezone,
      persona: userArenaDetails.persona,
    })
    .from(userArenaDetails)
    .where(eq(userArenaDetails.userIdRef, userId))
    .limit(1)

  const arenaToken = await getHumanArenaAccessToken(userId)
  if (!arenaToken) {
    return { found: false, reason: 'Arena token not found for user' }
  }

  return {
    found: true,
    workflowId,
    userId,
    arenaToken,
    timezone: details[0]?.timezone ?? null,
    persona: details[0]?.persona ?? null,
  }
}
