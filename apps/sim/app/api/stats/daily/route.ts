import { chat, db, user, workflow, workflowExecutionLogs, workflowStatsDaily } from '@sim/db'
import { createLogger } from '@sim/logger'
import { and, count, eq, gte, inArray, lte } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/auth/internal'
import { generateRequestId } from '@/lib/core/utils/request'

export const dynamic = 'force-dynamic'

const logger = createLogger('WorkflowStatsDailyAPI')

/**
 * GET /api/workflows/stats/daily
 * Aggregates workflow execution stats for external chat executions from yesterday
 * and updates the workflow_stats_daily table.
 */
export async function GET(request: NextRequest) {
  const requestId = generateRequestId()
  logger.info(
    `[${requestId}] Workflow stats daily aggregation triggered at ${new Date().toISOString()}`
  )

  const authError = verifyCronAuth(request, 'Workflow stats daily aggregation')
  if (authError) {
    return authError
  }

  try {
    // Calculate yesterday's date range (UTC to match database timestamps)
    const yesterday = new Date()
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    yesterday.setUTCHours(0, 0, 0, 0)

    const endDate = new Date(yesterday)
    endDate.setUTCHours(23, 59, 59, 999)

    logger.info(
      `[${requestId}] Fetching external chat executions from ${yesterday.toISOString()} to ${endDate.toISOString()}`
    )

    // Fetch workflow execution logs for yesterday where is_external_chat is true
    // Group by workflow_id and count executions
    const executionStats = await db
      .select({
        workflowId: workflowExecutionLogs.workflowId,
        executionCount: count(workflowExecutionLogs.id),
        userId: workflowExecutionLogs.userId,
      })
      .from(workflowExecutionLogs)
      .where(
        and(
          eq(workflowExecutionLogs.isExternalChat, true),
          gte(workflowExecutionLogs.startedAt, yesterday),
          lte(workflowExecutionLogs.startedAt, endDate)
        )
      )
      .groupBy(workflowExecutionLogs.workflowId, workflowExecutionLogs.userId)

    logger.info(
      `[${requestId}] Found ${executionStats.length} workflows with external chat executions`
    )

    // Extract all workflow IDs from executionStats
    const workflowIds = executionStats.map((stat) => stat.workflowId).filter(Boolean) as string[]

    // Fetch all templates for these workflow IDs in one query
    const allDeployedChats = await db
      .select({
        workflowId: chat.workflowId,
        name: chat.title,
        details: chat.remarks,
        department: chat.department,
      })
      .from(chat)
      .where(inArray(chat.workflowId, workflowIds))

    // Create a Map<workflowId, template> for quick lookup
    const deployedChatMap = new Map<
      string,
      { name: string; details: any; department: string | null }
    >()
    for (const deployedChat of allDeployedChats) {
      if (deployedChat.workflowId) {
        deployedChatMap.set(deployedChat.workflowId, {
          name: deployedChat.name,
          details: deployedChat.details,
          department: deployedChat.department,
        })
      }
    }

    logger.info(
      `[${requestId}] Fetched ${allDeployedChats.length} templates for ${workflowIds.length} workflows`
    )

    const executedUserIds = executionStats
      .map((stat) => stat.userId as string)
      .filter(Boolean) as string[]
    const executedUsers = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
      })
      .from(user)
      .where(inArray(user.id, executedUserIds))

    const executedUsersMap = new Map<string, { name: string | null }>()
    for (const executedUser of executedUsers) {
      if (executedUser.id) {
        executedUsersMap.set(executedUser.id, {
          name: executedUser.name,
        })
      }
    }

    const statsToInsert: Array<{
      id: string
      workflowId: string | null
      workflowName: string | null
      workflowAuthorId: string | null
      category: string | null
      executionCount: number
      workflowAuthorUserName: string | null
      executionUserName: string | null
      executionUserId: string | null
    }> = []

    // For each workflow, get template info and workflow info
    for (const stat of executionStats) {
      if (!stat.workflowId) continue

      // Fetch template from the map
      const deployedChat = deployedChatMap.get(stat.workflowId)

      // If template doesn't exist, skip this workflow
      if (!deployedChat) {
        logger.debug(`[${requestId}] Skipping workflow ${stat.workflowId} - no template found`)
        continue
      }

      // Get workflow info for user_id
      const [workflowRecord] = await db
        .select({
          userId: workflow.userId,
        })
        .from(workflow)
        .where(eq(workflow.id, stat.workflowId))
        .limit(1)

      if (!workflowRecord) {
        logger.warn(`[${requestId}] Workflow ${stat.workflowId} not found, skipping`)
        continue
      }

      // Get User from workflow record
      const [authorUser] = await db
        .select({
          userId: user.id,
          userName: user.name,
          userEmail: user.email,
        })
        .from(user)
        .where(eq(user.id, workflowRecord.userId))
        .limit(1)

      if (!authorUser) {
        logger.warn(`[${requestId}] Workflow ${stat.workflowId} not found, skipping`)
        continue
      }
      const executedUser = executedUsersMap.get(stat.userId as string)
      if (!executedUser) {
        logger.warn(`[${requestId}] User ${stat.userId} not found, skipping`)
        continue
      }

      statsToInsert.push({
        id: crypto.randomUUID(),
        workflowId: stat.workflowId,
        workflowName: deployedChat.name,
        workflowAuthorId: workflowRecord.userId,
        category: deployedChat.department,
        executionCount: stat.executionCount,
        workflowAuthorUserName: authorUser.userName,
        executionUserName: executedUser.name,
        executionUserId: stat.userId,
      })
    }

    logger.info(`[${requestId}] Prepared ${statsToInsert.length} stats records to insert`)

    // Insert stats into workflow_stats_daily
    if (statsToInsert.length > 0) {
      // Format yesterday date as YYYY-MM-DD for PostgreSQL DATE type
      const executionDate = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(yesterday.getUTCDate()).padStart(2, '0')}`

      await db.insert(workflowStatsDaily).values(
        statsToInsert.map((stat) => ({
          id: stat.id,
          workflowId: stat.workflowId,
          workflowName: stat.workflowName,
          workflowAuthorId: stat.workflowAuthorId,
          workflowAuthorUserName: stat.workflowAuthorUserName,
          category: stat.category,
          executionCount: stat.executionCount,
          executionDate,
          executionUserName: stat.executionUserName,
          executionUserId: stat.executionUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        }))
      )

      logger.info(`[${requestId}] Successfully inserted ${statsToInsert.length} stats records`)
    }

    return NextResponse.json({
      message: 'Workflow stats daily aggregation completed',
      processedWorkflows: statsToInsert.length,
      totalWorkflows: executionStats.length,
      skippedWorkflows: executionStats.length - statsToInsert.length,
    })
  } catch (error: any) {
    logger.error(`[${requestId}] Error in workflow stats daily aggregation`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
