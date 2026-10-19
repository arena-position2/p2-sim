import { db } from '@sim/db'
import { chat, user, workflow } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, eq, isNull } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/auth/internal'
import { hasAgentEmailAccess } from '@/lib/chat/agent-email-access'
import { getAgentDepartmentLabel } from '@/lib/chat/arena-departments'
import { withLoggedInEmailOnVideoAgentUrl } from '@/lib/chat/video-agent-redirect'
import { getUniqueBlockNamesByWorkflowId } from '@/lib/chat/workflow-block-names'
import { getBaseUrl } from '@/lib/core/utils/urls'

const logger = createLogger('DeployedChatAgentDetailAPI')

/**
 * GET /api/chat/agentsList/[id]
 * Returns a single agent (chat deployment) by id, using the same response shape
 * as one item from GET /api/chat/agentsList. Auth matches the list endpoint.
 * `emailId` is optional. When it is present, `disabled` matches list behavior:
 * `false` when emailId or the user's domain is in allowedEmails, otherwise `true`.
 * When it is missing, the agent is still returned and the saved redirect URL is unchanged.
 * Chat deployments remain fetchable even when the workflow also has an active
 * schedule or webhook.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authError = verifyCronAuth(request, 'Schedule execution')
  if (authError) {
    return authError
  }

  try {
    const { id } = await params
    const agentId = id?.trim()
    const emailId = new URL(request.url).searchParams.get('emailId')?.trim()

    if (!agentId) {
      return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 })
    }

    const rows = await db
      .select({
        chatId: chat.id,
        title: chat.title,
        workflowId: chat.workflowId,
        department: chat.department,
        createdAt: chat.createdAt,
        allowedEmails: chat.allowedEmails,
        workflowName: workflow.name,
        workspaceId: workflow.workspaceId,
        authorEmail: user.email,
        description: chat.description,
        identifier: chat.identifier,
        deploymentType: chat.deploymentType,
        redirectUrl: chat.redirectUrl,
        arenaPath: chat.arenaPath,
      })
      .from(chat)
      .innerJoin(workflow, eq(chat.workflowId, workflow.id))
      .innerJoin(user, eq(workflow.userId, user.id))
      .where(and(eq(chat.id, agentId), eq(chat.isActive, true), isNull(chat.archivedAt)))
      .limit(1)

    if (rows.length === 0) {
      logger.warn(`Agent not found for id: ${agentId}`)
      return NextResponse.json({ success: false, error: 'Agent not found' }, { status: 404 })
    }

    const row = rows[0]
    const appRedirectUrl = row.deploymentType === 'app' && row.redirectUrl ? row.redirectUrl : null
    const blockNamesByWorkflowId = await getUniqueBlockNamesByWorkflowId([row.workflowId])

    const agent = {
      id: row.chatId,
      title: row.title,
      author_email: row.authorEmail,
      workflow_id: row.workflowId,
      workflow_name: row.workflowName,
      workspace_id: row.workspaceId,
      department: await getAgentDepartmentLabel(row.department),
      created_at: row.createdAt.toISOString(),
      workflow_description: row.description,
      status: 'published',
      identifier: row.identifier,
      deployment_type: row.deploymentType === 'app' ? 'app' : 'chat',
      redirect_url: appRedirectUrl
        ? withLoggedInEmailOnVideoAgentUrl(appRedirectUrl, emailId)
        : `${getBaseUrl()}/chat/${row.identifier || row.workflowId}?workspaceId=${row.workspaceId}`,
      arena_path: row.arenaPath?.trim() || null,
      block_names: blockNamesByWorkflowId.get(row.workflowId) ?? [],
      disabled: !hasAgentEmailAccess(row.allowedEmails, emailId ?? ''),
    }

    return NextResponse.json({ success: true, agent }, { status: 200 })
  } catch (error: unknown) {
    logger.error('Error fetching agent detail:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    )
  }
}
