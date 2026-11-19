import { chat, db, user, workflow, workflowExecutionLogs, workflowStatsDaily } from '@sim/db'
import { createLogger } from '@sim/logger'
import { and, count, eq, gte, inArray, lte } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/auth/internal'
import { generateRequestId } from '@/lib/core/utils/request'

export const dynamic = 'force-dynamic'

const logger = createLogger('WorkflowStatsDailyPopulateAPI')

/**
 * Result of processing stats for a single date
 */
interface ProcessDateResult {
  processedWorkflows: number
  totalWorkflows: number
  skippedWorkflows: number
  insertedCount: number
}

/**
 * Processes workflow execution stats for a specific date.
 * Aggregates external chat executions and inserts into workflow_stats_daily.
 *
 * @param targetDate - The date to process (UTC, will be used as the full day)
 * @param requestId - Request ID for logging
 * @param skipExisting - If true, skip dates that already have stats
 * @returns Processing result with counts
 */
async function processDateStats(
  targetDate: Date,
  requestId: string,
  skipExisting = true
): Promise<ProcessDateResult> {
  // Calculate date range for the target date (UTC)
  const startDate = new Date(targetDate)
  startDate.setUTCHours(0, 0, 0, 0)

  const endDate = new Date(targetDate)
  endDate.setUTCHours(23, 59, 59, 999)

  // Format date as YYYY-MM-DD for PostgreSQL DATE type
  const executionDate = `${targetDate.getUTCFullYear()}-${String(targetDate.getUTCMonth() + 1).padStart(2, '0')}-${String(targetDate.getUTCDate()).padStart(2, '0')}`

  // Check if stats already exist for this date (if skipExisting is true)
  if (skipExisting) {
    const existingStats = await db
      .select({ id: workflowStatsDaily.id })
      .from(workflowStatsDaily)
      .where(eq(workflowStatsDaily.executionDate, executionDate))
      .limit(1)

    if (existingStats.length > 0) {
      logger.info(`[${requestId}] Stats already exist for ${executionDate}, skipping`)
      return {
        processedWorkflows: 0,
        totalWorkflows: 0,
        skippedWorkflows: 0,
        insertedCount: 0,
      }
    }
  }

  logger.info(
    `[${requestId}] Processing stats for ${executionDate} (${startDate.toISOString()} to ${endDate.toISOString()})`
  )

  // Fetch workflow execution logs for the target date where is_external_chat is true
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
        gte(workflowExecutionLogs.startedAt, startDate),
        lte(workflowExecutionLogs.startedAt, endDate)
      )
    )
    .groupBy(workflowExecutionLogs.workflowId, workflowExecutionLogs.userId)

  logger.info(
    `[${requestId}] Found ${executionStats.length} workflows with external chat executions for ${executionDate}`
  )

  if (executionStats.length === 0) {
    return {
      processedWorkflows: 0,
      totalWorkflows: 0,
      skippedWorkflows: 0,
      insertedCount: 0,
    }
  }

  // Extract all workflow IDs from executionStats
  const workflowIds = executionStats.map((stat) => stat.workflowId).filter(Boolean) as string[]
  const executedUserIds = executionStats.map((stat) => stat.userId).filter(Boolean) as string[]
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

  // Fetch all workflows for these workflow IDs in one query
  const allWorkflows = await db
    .select({
      id: workflow.id,
      userId: workflow.userId,
    })
    .from(workflow)
    .where(inArray(workflow.id, workflowIds))

  // Create a Map<workflowId, workflow> for quick lookup
  const workflowMap = new Map<string, { userId: string }>()
  for (const workflowRecord of allWorkflows) {
    if (workflowRecord.id && workflowRecord.userId) {
      workflowMap.set(workflowRecord.id, {
        userId: workflowRecord.userId,
      })
    }
  }

  // Extract all user IDs from workflows
  const userIds = Array.from(workflowMap.values())
    .map((w) => w.userId)
    .filter(Boolean) as string[]

  // Fetch all users for these user IDs in one query
  const allUsers = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
    })
    .from(user)
    .where(inArray(user.id, userIds))

  // Create a Map<userId, user> for quick lookup
  const userMap = new Map<string, { name: string | null }>()
  for (const authorUser of allUsers) {
    if (authorUser.id) {
      userMap.set(authorUser.id, {
        name: authorUser.name,
      })
    }
  }

  logger.info(
    `[${requestId}] Fetched ${allDeployedChats.length} templates, ${allWorkflows.length} workflows, and ${allUsers.length} users for ${executionDate}`
  )

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

    // Get workflow info from the map
    const workflowRecord = workflowMap.get(stat.workflowId)

    if (!workflowRecord) {
      logger.warn(`[${requestId}] Workflow ${stat.workflowId} not found, skipping`)
      continue
    }

    // Get User from the map
    const authorUser = userMap.get(workflowRecord.userId)
    if (!authorUser) {
      logger.warn(
        `[${requestId}] User ${workflowRecord.userId} not found for workflow ${stat.workflowId}, skipping`
      )
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
      workflowAuthorUserName: authorUser.name,
      executionUserName: executedUser.name,
      executionUserId: stat.userId,
    })
  }

  logger.info(
    `[${requestId}] Prepared ${statsToInsert.length} stats records to insert for ${executionDate}`
  )

  // Insert stats into workflow_stats_daily
  let insertedCount = 0
  if (statsToInsert.length > 0) {
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

    insertedCount = statsToInsert.length
    logger.info(
      `[${requestId}] Successfully inserted ${insertedCount} stats records for ${executionDate}`
    )
  }

  return {
    processedWorkflows: statsToInsert.length,
    totalWorkflows: executionStats.length,
    skippedWorkflows: executionStats.length - statsToInsert.length,
    insertedCount,
  }
}

/**
 * Generates an array of dates between startDate and endDate (inclusive).
 *
 * @param startDate - Start date (inclusive)
 * @param endDate - End date (inclusive)
 * @returns Array of Date objects, one per day
 */
function getDateRange(startDate: Date, endDate: Date): Date[] {
  const dates: Date[] = []
  const current = new Date(startDate)
  current.setUTCHours(0, 0, 0, 0)

  const end = new Date(endDate)
  end.setUTCHours(0, 0, 0, 0)

  while (current <= end) {
    dates.push(new Date(current))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return dates
}

/**
 * GET /api/stats/populate/daily
 * Backfills workflow execution stats for external chat executions for a date range.
 *
 * Query parameters (required):
 * - startDate: ISO date string (YYYY-MM-DD) - start date for backfill (inclusive)
 * - endDate: ISO date string (YYYY-MM-DD) - end date for backfill (inclusive)
 * - skipExisting: boolean (default: true) - skip dates that already have stats
 *
 * Example:
 * GET /api/stats/populate/daily?startDate=2025-01-01&endDate=2025-01-31
 */
export async function GET(request: NextRequest) {
  const requestId = generateRequestId()
  logger.info(
    `[${requestId}] Workflow stats daily populate/backfill triggered at ${new Date().toISOString()}`
  )

  const authError = verifyCronAuth(request, 'Workflow stats daily populate')
  if (authError) {
    return authError
  }

  try {
    const { searchParams } = new URL(request.url)
    const startDateParam = searchParams.get('startDate')
    const endDateParam = searchParams.get('endDate')
    const skipExistingParam = searchParams.get('skipExisting')

    // Validate required parameters
    if (!startDateParam || !endDateParam) {
      return NextResponse.json(
        { error: 'Both startDate and endDate query parameters are required (format: YYYY-MM-DD)' },
        { status: 400 }
      )
    }

    const skipExisting = skipExistingParam !== 'false' // Default to true unless explicitly false

    // Parse dates
    const startDate = new Date(`${startDateParam}T00:00:00Z`)
    const endDate = new Date(`${endDateParam}T00:00:00Z`)

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD' }, { status: 400 })
    }

    if (startDate > endDate) {
      return NextResponse.json(
        { error: 'startDate must be before or equal to endDate' },
        { status: 400 }
      )
    }

    // Generate date range
    const datesToProcess = getDateRange(startDate, endDate)

    logger.info(
      `[${requestId}] Backfill mode: Processing ${datesToProcess.length} days from ${startDateParam} to ${endDateParam} (skipExisting: ${skipExisting})`
    )

    // Process each date
    const results: ProcessDateResult[] = []
    let totalProcessed = 0
    let totalInserted = 0
    let totalSkipped = 0
    let totalErrors = 0
    const errorDates: string[] = []

    for (let i = 0; i < datesToProcess.length; i++) {
      const date = datesToProcess[i]
      const dateStr = date.toISOString().split('T')[0]

      try {
        logger.info(`[${requestId}] Processing date ${i + 1}/${datesToProcess.length}: ${dateStr}`)

        const result = await processDateStats(date, requestId, skipExisting)
        results.push(result)

        totalProcessed += result.processedWorkflows
        totalInserted += result.insertedCount
        totalSkipped += result.skippedWorkflows

        if (result.insertedCount === 0 && skipExisting) {
          logger.info(`[${requestId}] Date ${dateStr} skipped (already exists)`)
        }
      } catch (error: any) {
        totalErrors++
        errorDates.push(dateStr)
        logger.error(`[${requestId}] Error processing date ${dateStr}`, error)
        // Continue processing other dates even if one fails
      }
    }

    const summary = {
      message: 'Workflow stats daily backfill completed',
      datesProcessed: datesToProcess.length,
      totalProcessedWorkflows: totalProcessed,
      totalInsertedRecords: totalInserted,
      totalSkippedWorkflows: totalSkipped,
      totalErrors,
      errorDates: errorDates.length > 0 ? errorDates : undefined,
      dateRange: {
        start: startDateParam,
        end: endDateParam,
      },
      dates: datesToProcess.map((d) => d.toISOString().split('T')[0]),
    }

    logger.info(`[${requestId}] Backfill completed`, summary)

    return NextResponse.json(summary)
  } catch (error: any) {
    logger.error(`[${requestId}] Error in workflow stats daily backfill`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
