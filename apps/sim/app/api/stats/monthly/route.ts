import { db, workflowStatsDaily, workflowStatsMonthly } from '@sim/db'
import { createLogger } from '@sim/logger'
import { and, gte, lte, sql } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { statsMonthlyContract } from '@/lib/api/contracts/stats'
import { parseRequest } from '@/lib/api/server'
import { verifyCronAuth } from '@/lib/auth/internal'
import { generateRequestId } from '@/lib/core/utils/request'

export const dynamic = 'force-dynamic'

const logger = createLogger('WorkflowStatsMonthlyAPI')

/**
 * GET /api/stats/monthly
 * Aggregates workflow stats from workflow_stats_daily for last month
 * and updates the workflow_stats_monthly table.
 */
export async function GET(request: NextRequest) {
  const requestId = generateRequestId()
  logger.info(
    `[${requestId}] Workflow stats monthly aggregation triggered at ${new Date().toISOString()}`
  )

  const authError = verifyCronAuth(request, 'Workflow stats monthly aggregation')
  if (authError) {
    return authError
  }

  const parsed = await parseRequest(statsMonthlyContract, request, {})
  if (!parsed.success) return parsed.response

  try {
    // Calculate last month's date range
    const now = new Date()
    const firstDayOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    firstDayOfLastMonth.setHours(0, 0, 0, 0)

    const lastDayOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0)
    lastDayOfLastMonth.setHours(23, 59, 59, 999)

    // Format dates as YYYY-MM-DD for comparison with execution_date (DATE column)
    const startExecutionDate = `${firstDayOfLastMonth.getFullYear()}-${String(firstDayOfLastMonth.getMonth() + 1).padStart(2, '0')}-${String(firstDayOfLastMonth.getDate()).padStart(2, '0')}`
    const endExecutionDate = `${lastDayOfLastMonth.getFullYear()}-${String(lastDayOfLastMonth.getMonth() + 1).padStart(2, '0')}-${String(lastDayOfLastMonth.getDate()).padStart(2, '0')}`

    logger.info(
      `[${requestId}] Fetching daily stats with execution_date from ${startExecutionDate} to ${endExecutionDate}`
    )

    // Fetch and aggregate workflow_stats_daily records from last month
    // Group by workflow_id and sum executionCount
    // Filter by execution_date column instead of createdAt
    const monthlyStats = await db
      .select({
        workflowId: workflowStatsDaily.workflowId,
        workflowName: sql<string | null>`MAX(${workflowStatsDaily.workflowName})`,
        workflowAuthorId: sql<string | null>`MAX(${workflowStatsDaily.workflowAuthorId})`,
        workflowAuthorUserName: sql<
          string | null
        >`MAX(${workflowStatsDaily.workflowAuthorUserName})`,
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
      `[${requestId}] Found ${monthlyStats.length} workflows with daily stats to aggregate`
    )

    // Calculate execution month (YYYYMM format, e.g., 202501 for January 2025)
    const executionMonth =
      firstDayOfLastMonth.getFullYear() * 100 + (firstDayOfLastMonth.getMonth() + 1)

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

    logger.info(`[${requestId}] Prepared ${statsToInsert.length} monthly stats records to insert`)

    // Insert stats into workflow_stats_monthly
    if (statsToInsert.length > 0) {
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

      logger.info(
        `[${requestId}] Successfully inserted ${statsToInsert.length} monthly stats records`
      )
    }

    return NextResponse.json({
      message: 'Workflow stats monthly aggregation completed',
      processedWorkflows: statsToInsert.length,
      totalWorkflows: monthlyStats.length,
      dateRange: {
        start: firstDayOfLastMonth.toISOString(),
        end: lastDayOfLastMonth.toISOString(),
      },
    })
  } catch (error: any) {
    logger.error(`[${requestId}] Error in workflow stats monthly aggregation`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
