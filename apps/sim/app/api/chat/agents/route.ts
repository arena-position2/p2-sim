import { db } from '@sim/db'
import { chat, user, workflow } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { chatAgentsContract } from '@/lib/api/contracts/arena-chat'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { getAgentDepartmentLabelMap, labelFromDepartmentMap } from '@/lib/chat/arena-departments'

const logger = createLogger('ChatAgentsAPI')

/**
 * GET /api/chat/agents
 * Fetch all chats accessible by a user based on their email
 *
 * Query Parameters:
 * - emailId: User's email address (required)
 *
 * Access Rules:
 * 1. User must exist in the user table
 * 2. Returns chats where:
 *    - user_id matches the user's id, OR
 *    - user's email is in the allowed_emails array, OR
 *    - user's email domain matches a domain pattern in allowed_emails (e.g., '@example.com')
 *
 * Response includes:
 * - From chat table: title, workflow_id, subdomain
 * - From workflow table: name, description, workspace_id
 *
 * Chat deployments remain listable even when the same workflow also has an
 * active schedule or webhook.
 */
export async function GET(request: NextRequest) {
  try {
    // Extract emailId from query parameters
    const parsed = await parseRequest(chatAgentsContract, request, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json(
          { success: false, error: getValidationErrorMessage(error) },
          { status: 400 }
        ),
    })
    if (!parsed.success) return parsed.response
    const { emailId } = parsed.data.query

    logger.info(`Fetching chats for email: ${emailId}`)

    // Step 1: Verify user exists and get their ID
    const userRecord = await db
      .select({
        id: user.id,
        email: user.email,
      })
      .from(user)
      .where(eq(user.email, emailId))
      .limit(1)

    if (userRecord.length === 0) {
      logger.warn(`User not found with email: ${emailId}`)
      return NextResponse.json(
        {
          success: false,
          error: 'User not found',
        },
        { status: 404 }
      )
    }

    const foundUser = userRecord[0]
    const userId = foundUser.id
    const userEmailDomain = emailId.substring(emailId.indexOf('@'))

    logger.info(`User found: ${userId}, email domain: ${userEmailDomain}`)

    // Step 2: Fetch chats with workflow details that have matching templates
    // We only fetch chats where there's a corresponding template entry
    // We need to check:
    // 1. userId matches
    // 2. email is in allowedEmails
    // 3. domain pattern matches (e.g., '@example.com' in allowedEmails)
    const chats = await db
      .select({
        chatId: chat.id,
        title: chat.title,
        workflowId: chat.workflowId,
        subdomain: chat.identifier,
        userId: chat.userId,
        authorEmail: user.email,
        allowedEmails: chat.allowedEmails,
        name: chat.title,
        author: chat.userId,
        workflowName: workflow.name,
        workflowDescription: chat.remarks,
        templateDescription: chat.remarks,
        department: chat.department,
        workspaceId: workflow.workspaceId,
        createdAt: chat.createdAt,
      })
      .from(chat)
      .innerJoin(workflow, eq(chat.workflowId, workflow.id))
      .innerJoin(user, eq(user.id, chat.userId))
      .where(eq(chat.isActive, true))

    // Step 3: Filter chats based on access rules
    const accessibleChats = chats.filter((chatRecord) => {
      // Rule 1: User owns the chat
      // if (chatRecord.userId === userId) {
      //   return true
      // }

      // Rule 2 & 3: Check allowedEmails array
      if (chatRecord.allowedEmails) {
        const allowedEmailsList = Array.isArray(chatRecord.allowedEmails)
          ? chatRecord.allowedEmails
          : []

        for (const allowedEmail of allowedEmailsList) {
          if (typeof allowedEmail === 'string') {
            // Exact email match
            if (allowedEmail === emailId) {
              return true
            }
            // Domain pattern match (e.g., '@example.com')
            if (allowedEmail.startsWith('@') && userEmailDomain === allowedEmail) {
              return true
            }
          }
        }
      }

      return false
    })

    // Step 4: Format response
    const departmentLabelMap = await getAgentDepartmentLabelMap()
    const agentList = accessibleChats.map((chatRecord) => ({
      title: chatRecord.name,
      author_email: chatRecord.authorEmail,
      workflow_id: chatRecord.workflowId,
      subdomain: chatRecord.subdomain,
      workflow_name: chatRecord.name,
      workflow_description: chatRecord.templateDescription || chatRecord.workflowDescription,
      workspace_id: chatRecord.workspaceId,
      department: labelFromDepartmentMap(departmentLabelMap, chatRecord.department),
      created_at: chatRecord.createdAt.toISOString(),
    }))

    logger.info(`Found ${agentList.length} accessible chats for user ${userId}`)

    return NextResponse.json(
      {
        success: true,
        agentList: agentList,
        count: agentList.length,
      },
      { status: 200 }
    )
  } catch (error: any) {
    logger.error('Error fetching chats:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error',
      },
      { status: 500 }
    )
  }
}
