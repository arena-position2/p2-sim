import { db, requestedAgentAccess } from '@sim/db'
import { desc, eq } from 'drizzle-orm'
import {
  type AgentAccessRequestRow,
  agentAccessRequestRowSchema,
} from '@/lib/api/contracts/agent-access-requests'

function serializeTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return value
}

/**
 * Lists agent access requests from `requested_agent_access`, newest first.
 * When `workspaceId` is set, scopes to that workspace; otherwise returns all rows.
 */
export async function listRequestedAgentAccess(workspaceId?: string): Promise<{
  rows: AgentAccessRequestRow[]
  rowCount: number
}> {
  const base = db
    .select({
      id: requestedAgentAccess.id,
      agent_name: requestedAgentAccess.agentName,
      requested_user_email: requestedAgentAccess.requestedUserEmail,
      workflow_id: requestedAgentAccess.workflowId,
      requested_user_name: requestedAgentAccess.requestedUserName,
      workspace_id: requestedAgentAccess.workspaceId,
      status: requestedAgentAccess.status,
      created_at: requestedAgentAccess.createdAt,
      updated_at: requestedAgentAccess.updatedAt,
      approved_by: requestedAgentAccess.approvedBy,
    })
    .from(requestedAgentAccess)

  const records = workspaceId
    ? await base
        .where(eq(requestedAgentAccess.workspaceId, workspaceId))
        .orderBy(desc(requestedAgentAccess.createdAt))
    : await base.orderBy(desc(requestedAgentAccess.createdAt))

  const rows = agentAccessRequestRowSchema.array().parse(
    records.map((row) => ({
      ...row,
      created_at: serializeTimestamp(row.created_at),
      updated_at: serializeTimestamp(row.updated_at),
    }))
  )

  return { rows, rowCount: rows.length }
}
