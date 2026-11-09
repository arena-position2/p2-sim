import { db, workflowStatsDaily, workflowStatsMonthly } from '@sim/db'
import { createLogger } from '@sim/logger'
import { and, eq, gte, lte, sql } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { statsPopulateMonthlyContract } from '@/lib/api/contracts/stats'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { verifyCronAuth } from '@/lib/auth/internal'
import { generateRequestId } from '@/lib/core/utils/request'

export const dynamic = 'force-dynamic'

const logger = createLogger('WorkflowStatsMonthlyPopulateAPI')

/**
 * Result of processing stats for a single month
 */
interface ProcessMonthResult {
  processedWorkflows: number
  totalWorkflows: number
  skippedWorkflows: number
  insertedCount: number
}

/**
 * Processes workflow execution stats for a specific month.
 * Aggregates from workflow_stats_daily and inserts into workflow_stats_monthly.
 *
 * @param targetMonth - The month to process (Date object representing the first day of the month)
 * @param requestId - Request ID for logging
 * @param skipExisting - If true, skip months that already have stats
 * @returns Processing result with counts
 */
async function processMonthStats(
  targetMonth: Date,
  requestId: string,
  skipExisting = true
): Promise<ProcessMonthResult> {
  // Calculate month's date range (first day to last day)
  const firstDayOfMonth = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1)
  firstDayOfMonth.setHours(0, 0, 0, 0)

  const lastDayOfMonth = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0)
  lastDayOfMonth.setHours(23, 59, 59, 999)

  // Format dates as YYYY-MM-DD for comparison with execution_date (DATE column)
  const startExecutionDate = `${firstDayOfMonth.getFullYear()}-${String(firstDayOfMonth.getMonth() + 1).padStart(2, '0')}-${String(firstDayOfMonth.getDate()).padStart(2, '0')}`
  const endExecutionDate = `${lastDayOfMonth.getFullYear()}-${String(lastDayOfMonth.getMonth() + 1).padStart(2, '0')}-${String(lastDayOfMonth.getDate()).padStart(2, '0')}`

  // Calculate execution month (YYYYMM format, e.g., 202501 for January 2025)
  const executionMonth = firstDayOfMonth.getFullYear() * 100 + (firstDayOfMonth.getMonth() + 1)

  // Check if stats already exist for this month (if skipExisting is true)
  if (skipExisting) {
    const existingStats = await db
      .select({ id: workflowStatsMonthly.id })
      .from(workflowStatsMonthly)
      .where(eq(workflowStatsMonthly.executionMonth, executionMonth))
      .limit(1)

    if (existingStats.length > 0) {
      logger.info(
        `[${requestId}] Stats already exist for month ${executionMonth} (${startExecutionDate} to ${endExecutionDate}), skipping`
      )
      return {
        processedWorkflows: 0,
        totalWorkflows: 0,
        skippedWorkflows: 0,
        insertedCount: 0,
      }
    }
  }

  logger.info(
    `[${requestId}] Processing stats for month ${executionMonth} (${startExecutionDate} to ${endExecutionDate})`
  )

  // Fetch and aggregate workflow_stats_daily records for the target month
  // Group by workflow_id and sum executionCount
  // Filter by execution_date column
  const monthlyStats = await db
    .select({
      workflowId: workflowStatsDaily.workflowId,
      workflowName: sql<string | null>`MAX(${workflowStatsDaily.workflowName})`,
      workflowAuthorId: sql<string | null>`MAX(${workflowStatsDaily.workflowAuthorId})`,
      workflowAuthorUserName: sql<string | null>`MAX(${workflowStatsDaily.workflowAuthorUserName})`,
      category: sql<string | null>`MAX(${workflowStatsDaily.category})`,
      executionCount: sql<number>`SUM(${workflowStatsDaily.executionCount})`,
      executionUserName: sql<string | null>`MAX(${workflowStatsDaily.executionUserName})`,
      executionUserId: sql<string | null>`MAX(${workflowStatsDaily.executionUserId})`,
    })
    .from(workflowStatsDaily)
    .where(
      and(
        gte(workflowStatsDaily.executionDate, startExecutionDate),
        lte(workflowStatsDaily.executionDate, endExecutionDate)
      )
    )
    .groupBy(workflowStatsDaily.workflowId)

  logger.info(
    `[${requestId}] Found ${monthlyStats.length} workflows with daily stats to aggregate for month ${executionMonth}`
  )

  if (monthlyStats.length === 0) {
    return {
      processedWorkflows: 0,
      totalWorkflows: 0,
      skippedWorkflows: 0,
      insertedCount: 0,
    }
  }

  // Prepare stats to insert into workflow_stats_monthly
  const statsToInsert = monthlyStats
    .filter((stat) => stat.workflowId !== null)
    .map((stat) => ({
      id: crypto.randomUUID(),
      workflowId: stat.workflowId,
      workflowName: stat.workflowName,
      workflowAuthorId: stat.workflowAuthorId,
      workflowAuthorUserName: stat.workflowAuthorUserName,
      category: stat.category,
      executionCount: stat.executionCount,
      executionMonth,
      executionUserName: stat.executionUserName,
      executionUserId: stat.executionUserId,
    }))

  logger.info(
    `[${requestId}] Prepared ${statsToInsert.length} monthly stats records to insert for month ${executionMonth}`
  )

  // Insert stats into workflow_stats_monthly
  let insertedCount = 0
  if (statsToInsert.length > 0) {
    // If we're not skipping existing records, clear any existing stats for this month first
    if (!skipExisting) {
      await db
        .delete(workflowStatsMonthly)
        .where(eq(workflowStatsMonthly.executionMonth, executionMonth))
    }

    await db.insert(workflowStatsMonthly).values(
      statsToInsert.map((stat) => ({
        id: stat.id,
        workflowId: stat.workflowId,
        workflowName: stat.workflowName,
        workflowAuthorId: stat.workflowAuthorId,
        workflowAuthorUserName: stat.workflowAuthorUserName,
        category: stat.category,
        executionCount: stat.executionCount,
        executionMonth: stat.executionMonth,
        executionUserName: stat.executionUserName,
        executionUserId: stat.executionUserId,
        createdAt: sql`now()`,
        updatedAt: sql`now()`,
      }))
    )

    insertedCount = statsToInsert.length
    logger.info(
      `[${requestId}] Successfully inserted ${insertedCount} monthly stats records for month ${executionMonth}`
    )
  }

  return {
    processedWorkflows: statsToInsert.length,
    totalWorkflows: monthlyStats.length,
    skippedWorkflows: monthlyStats.length - statsToInsert.length,
    insertedCount,
  }
}

/**
 * Generates an array of months between startDate and endDate (inclusive).
 * Each date represents the first day of that month.
 *
 * @param startDate - Start date (inclusive)
 * @param endDate - End date (inclusive)
 * @returns Array of Date objects, one per month (first day of each month)
 */
function getMonthRange(startDate: Date, endDate: Date): Date[] {
  const months: Date[] = []
  const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1)
  current.setHours(0, 0, 0, 0)

  const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1)
  end.setHours(0, 0, 0, 0)

  while (current <= end) {
    months.push(new Date(current))
    // Move to first day of next month
    current.setMonth(current.getMonth() + 1)
  }

  return months
}

/**
 * GET /api/stats/populate/monthly
 * Backfills workflow execution stats for external chat executions for a month range.
 *
 * Query parameters (required):
 * - startDate: ISO date string (YYYY-MM-DD) - start date for backfill (inclusive)
 * - endDate: ISO date string (YYYY-MM-DD) - end date for backfill (inclusive)
 * - skipExisting: boolean (default: true) - skip months that already have stats
 *
 * Example:
 * GET /api/stats/populate/monthly?startDate=2025-01-01&endDate=2025-03-31
 * This will process January, February, and March 2025.
 */
export async function GET(request: NextRequest) {
  const requestId = generateRequestId()
  logger.info(
    `[${requestId}] Workflow stats monthly populate/backfill triggered at ${new Date().toISOString()}`
  )

  const authError = verifyCronAuth(request, 'Workflow stats monthly populate')
  if (authError) {
    return authError
  }

  try {
    const parsed = await parseRequest(statsPopulateMonthlyContract, request, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json({ error: getValidationErrorMessage(error) }, { status: 400 }),
    })
    if (!parsed.success) return parsed.response
    const {
      startDate: startDateParam,
      endDate: endDateParam,
      skipExisting: skipExistingParam,
    } = parsed.data.query

    const skipExisting = skipExistingParam !== 'false' // Default to true unless explicitly false

    const startDate = new Date(`${startDateParam}T00:00:00Z`)
    const endDate = new Date(`${endDateParam}T00:00:00Z`)

    if (startDate > endDate) {
      return NextResponse.json(
        { error: 'startDate must be before or equal to endDate' },
        { status: 400 }
      )
    }

    // Generate month range
    const monthsToProcess = getMonthRange(startDate, endDate)

    logger.info(
      `[${requestId}] Backfill mode: Processing ${monthsToProcess.length} months from ${startDateParam} to ${endDateParam} (skipExisting: ${skipExisting})`
    )

    // Process each month
    const results: ProcessMonthResult[] = []
    let totalProcessed = 0
    let totalInserted = 0
    let totalSkipped = 0
    let totalErrors = 0
    const errorMonths: string[] = []

    for (let i = 0; i < monthsToProcess.length; i++) {
      const month = monthsToProcess[i]
      const monthStr = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`
      const executionMonth = month.getFullYear() * 100 + (month.getMonth() + 1)

      try {
        logger.info(
          `[${requestId}] Processing month ${i + 1}/${monthsToProcess.length}: ${monthStr} (${executionMonth})`
        )

        const result = await processMonthStats(month, requestId, skipExisting)
        results.push(result)

        totalProcessed += result.processedWorkflows
        totalInserted += result.insertedCount
        totalSkipped += result.skippedWorkflows

        if (result.insertedCount === 0 && skipExisting) {
          logger.info(
            `[${requestId}] Month ${monthStr} (${executionMonth}) skipped (already exists)`
          )
        }
      } catch (error: any) {
        totalErrors++
        errorMonths.push(`${monthStr} (${executionMonth})`)
        logger.error(`[${requestId}] Error processing month ${monthStr} (${executionMonth})`, error)
        // Continue processing other months even if one fails
      }
    }

    const summary = {
      message: 'Workflow stats monthly backfill completed',
      monthsProcessed: monthsToProcess.length,
      totalProcessedWorkflows: totalProcessed,
      totalInsertedRecords: totalInserted,
      totalSkippedWorkflows: totalSkipped,
      totalErrors,
      errorMonths: errorMonths.length > 0 ? errorMonths : undefined,
      dateRange: {
        start: startDateParam,
        end: endDateParam,
      },
      months: monthsToProcess.map((m) => {
        const executionMonth = m.getFullYear() * 100 + (m.getMonth() + 1)
        return {
          month: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`,
          executionMonth,
        }
      }),
    }

    logger.info(`[${requestId}] Backfill completed`, summary)

    return NextResponse.json(summary)
  } catch (error: any) {
    logger.error(`[${requestId}] Error in workflow stats monthly backfill`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
