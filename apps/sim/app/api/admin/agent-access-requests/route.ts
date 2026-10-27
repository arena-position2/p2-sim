import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { type NextRequest, NextResponse } from 'next/server'
import { executeSimAgentWorkflow } from '@/lib/agent-access-requests/execute-workflow'
import {
  type ApproveAgentAccessRequestsResponse,
  agentAccessRequestRowSchema,
  approveAgentAccessRequestsContract,
  type ListAgentAccessRequestsResponse,
  listAgentAccessRequestsContract,
} from '@/lib/api/contracts/agent-access-requests'
import { parseRequest } from '@/lib/api/server'
import { getSession } from '@/lib/auth'
import { env } from '@/lib/core/config/env'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { isPlatformAdminEmail } from '@/lib/permissions/platform-admin-emails'

const logger = createLogger('AdminAgentAccessRequestsAPI')

interface UpstreamListOutput {
  rows?: unknown
  rowCount?: number
  message?: string
}

interface UpstreamExecuteResponse {
  data?: {
    status?: string
    output?: UpstreamListOutput
    error?: string | null
  }
  error?: unknown
}

async function requirePlatformAdminEmail() {
  const session = await getSession()
  if (!session?.user?.email || !isPlatformAdminEmail(session.user.email)) {
    return null
  }
  return session.user.email
}

/**
 * Lists agent access requests for a workspace by executing the configured list workflow.
 * Restricted to emails in `NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS`.
 */
export const GET = withRouteHandler(async (request: NextRequest) => {
  if (!(await requirePlatformAdminEmail())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = await parseRequest(listAgentAccessRequestsContract, request, {})
  if (!parsed.success) return parsed.response

  const workflowId = env.SIM_GET_REQUEST_AGENTS_APPROVAL_WORKFLOW_ID
  if (!workflowId) {
    logger.error('SIM_GET_REQUEST_AGENTS_APPROVAL_WORKFLOW_ID is not configured')
    return NextResponse.json(
      { error: 'Agent access request listing is not configured' },
      { status: 500 }
    )
  }

  try {
    const workspaceId = parsed.data.query.workspaceId
    const result = await executeSimAgentWorkflow({
      workflowId,
      input: workspaceId ? { workspace_id: workspaceId } : {},
      signal: request.signal,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    const payload = result.payload as UpstreamExecuteResponse
    const output = payload.data?.output
    const rawRows = Array.isArray(output?.rows) ? output.rows : []
    const rows = agentAccessRequestRowSchema.array().parse(rawRows)

    const body: ListAgentAccessRequestsResponse = {
      success: true,
      rows,
      rowCount: typeof output?.rowCount === 'number' ? output.rowCount : rows.length,
    }

    return NextResponse.json(body, { status: 200 })
  } catch (error: unknown) {
    logger.error('Error listing agent access requests', { error: getErrorMessage(error) })
    return NextResponse.json({ error: 'Failed to load agent access requests' }, { status: 500 })
  }
})

/**
 * Applies done/cancelled status to selected agent access requests.
 * Restricted to emails in `NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS`.
 */
export const POST = withRouteHandler(async (request: NextRequest) => {
  const sessionEmail = await requirePlatformAdminEmail()
  if (!sessionEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = await parseRequest(approveAgentAccessRequestsContract, request, {})
  if (!parsed.success) return parsed.response

  const workflowId = env.SIM_APPROVE_REQUEST_AGENTS_WORKFLOW_ID
  if (!workflowId) {
    logger.error('SIM_APPROVE_REQUEST_AGENTS_WORKFLOW_ID is not configured')
    return NextResponse.json(
      { error: 'Agent access request approval is not configured' },
      { status: 500 }
    )
  }

  /** Prefer the authenticated session email; fall back to the client-provided value. */
  const approvedBy = sessionEmail.trim() || parsed.data.body.approvedBy.trim()
  if (!approvedBy) {
    return NextResponse.json({ error: 'approved_by email is required' }, { status: 400 })
  }

  const giveAccessList = parsed.data.body.giveAccessList.map((entry) => ({
    access_id: entry.accessId,
    status: entry.status,
  }))

  try {
    logger.info('Approving agent access requests', {
      approvedBy,
      count: giveAccessList.length,
      workflowId,
    })

    const result = await executeSimAgentWorkflow({
      workflowId,
      input: {
        give_access_list: giveAccessList,
        approved_by: approvedBy,
      },
      signal: request.signal,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    const body: ApproveAgentAccessRequestsResponse = { success: true }
    return NextResponse.json(body, { status: 200 })
  } catch (error: unknown) {
    logger.error('Error approving agent access requests', { error: getErrorMessage(error) })
    return NextResponse.json({ error: 'Failed to update agent access requests' }, { status: 500 })
  }
})
