import { db } from '@sim/db'
import { chat, workflow } from '@sim/db/schema'
import { authorizeWorkflowByWorkspacePermission } from '@sim/platform-authz/workflow'
import { and, eq, isNull } from 'drizzle-orm'
import type { NextRequest, NextResponse } from 'next/server'
import { isDev } from '@/lib/core/config/env-flags'
import {
  type DeploymentAuthResource,
  setDeploymentAuthCookie,
  validateAuthToken,
} from '@/lib/core/security/deployment'
import {
  type DeploymentAuthBody,
  type DeploymentAuthResult,
  validateDeploymentAuth,
} from '@/lib/core/security/deployment-auth'

export async function setChatAuthCookie(
  response: NextResponse,
  deployment: DeploymentAuthResource,
  verifiedEmail?: string
): Promise<void> {
  await setDeploymentAuthCookie({
    response,
    cookiePrefix: 'chat',
    resource: deployment,
    verifiedEmail,
  })
}

/**
 * Whether a GET for an agent-generated image may proceed without a session.
 * Deployed chat visitors use `chat_auth_*` cookies, not a session; an image request cannot send a Bearer token or API key.
 */
export async function canAccessAgentGeneratedImageViaDeployedChat(
  request: NextRequest,
  workflowId: string
): Promise<boolean> {
  const deployments = await db
    .select({
      id: chat.id,
      authType: chat.authType,
      password: chat.password,
      allowedEmails: chat.allowedEmails,
    })
    .from(chat)
    .where(and(eq(chat.workflowId, workflowId), eq(chat.isActive, true)))

  if (deployments.length === 0) {
    return false
  }

  for (const d of deployments) {
    if (d.authType === 'public') {
      return true
    }
    const authCookie = request.cookies.get(`chat_auth_${d.id}`)
    if (authCookie?.value && (await validateAuthToken({ token: authCookie.value, resource: d }))) {
      return true
    }
  }

  return false
}

export function addCorsHeaders(response: NextResponse, request: NextRequest) {
  const origin = request.headers.get('origin') || ''

  if (isDev && origin.includes('localhost')) {
    response.headers.set('Access-Control-Allow-Origin', origin)
    response.headers.set('Access-Control-Allow-Credentials', 'true')
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With')
  }

  return response
}

/**
 * Check if user has access to view/edit/delete a specific chat
 */
export async function checkChatAccess(
  chatId: string,
  userId: string
): Promise<{ hasAccess: boolean; chat?: any; workspaceId?: string }> {
  const chatData = await db
    .select({
      chat: chat,
      workflowWorkspaceId: workflow.workspaceId,
    })
    .from(chat)
    .innerJoin(workflow, eq(chat.workflowId, workflow.id))
    .where(and(eq(chat.id, chatId), isNull(chat.archivedAt)))
    .limit(1)

  if (chatData.length === 0) {
    return { hasAccess: false }
  }

  const { chat: chatRecord, workflowWorkspaceId } = chatData[0]
  if (!workflowWorkspaceId) {
    return { hasAccess: false }
  }

  const authorization = await authorizeWorkflowByWorkspacePermission({
    workflowId: chatRecord.workflowId,
    userId,
    action: 'admin',
  })

  return authorization.allowed
    ? { hasAccess: true, chat: chatRecord, workspaceId: workflowWorkspaceId }
    : { hasAccess: false }
}

/**
 * Validates auth for a deployed chat. Thin wrapper over the shared
 * {@link validateDeploymentAuth} with the `'chat'` cookie/rate-limit namespace.
 */
export async function validateChatAuth(
  requestId: string,
  deployment: DeploymentAuthResource,
  request: NextRequest,
  parsedBody?: DeploymentAuthBody
): Promise<DeploymentAuthResult> {
  return validateDeploymentAuth(requestId, deployment, request, parsedBody, 'chat')
}
