import { db } from '@sim/db'
import { clientDetails, overallClientSummary } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { sql } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import {
  arenaOverallClientSummaryBodyContract,
  arenaOverallClientSummaryQueryContract,
} from '@/lib/api/contracts/tools/arena'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'

const logger = createLogger('arena-overall-client-summary-api')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function overallClientSummaryValidationError(
  error: Parameters<typeof getValidationErrorMessage>[0]
) {
  return NextResponse.json(
    { success: false, error: { message: getValidationErrorMessage(error) } },
    { status: 400 }
  )
}

export async function GET(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const parsed = await parseRequest(
      arenaOverallClientSummaryQueryContract,
      request,
      {},
      {
        validationErrorResponse: overallClientSummaryValidationError,
      }
    )
    if (!parsed.success) return parsed.response
    const { cid, type: summaryType } = parsed.data.query

    logger.info(`[${requestId}] Fetching latest overall client summaries`, {
      cid,
      type: summaryType,
    })

    // cid is used as client_id_ref in overall_client_summary table
    // Get the latest run date for this client
    const latestDateResult = await db
      .select({ runDate: overallClientSummary.runDate })
      .from(overallClientSummary)
      .where(
        sql`${overallClientSummary.clientIdRef} = ${cid} AND ${overallClientSummary.type} = ${summaryType}`
      )
      .orderBy(sql`${overallClientSummary.runDate} DESC`)
      .limit(1)

    if (latestDateResult.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            client_id: cid,
            message: 'No overall client summary data found for this client and type',
            summaries: [],
          },
        },
        { status: 200 }
      )
    }

    const latestRunDate = latestDateResult[0].runDate

    // Get clientManager from client_details using client_customer_id (cid is client_customer_id in client_details table)
    let resolvedClientManager: string | null = null
    const clientDetailsResult = await db
      .select({ clientManager: clientDetails.clientManager })
      .from(clientDetails)
      .where(sql`${clientDetails.clientCustomerId} = ${cid}`)
      .limit(1)

    if (clientDetailsResult.length > 0) {
      resolvedClientManager = clientDetailsResult[0].clientManager
    }

    // Get summaries using cid as client_id_ref
    const summaries = await db
      .select({
        id: overallClientSummary.id,
        clientIdRef: overallClientSummary.clientIdRef,
        clientName: overallClientSummary.clientName,
        type: overallClientSummary.type,
        oneDaySummary: overallClientSummary.oneDaySummary,
        sevenDaySummary: overallClientSummary.sevenDaySummary,
        fourteenDaySummary: overallClientSummary.fourteenDaySummary,
        dailySummaryChanges: overallClientSummary.dailySummaryChanges,
        weeklySentiment: overallClientSummary.weeklySentiment,
        runDate: overallClientSummary.runDate,
        status: overallClientSummary.status,
        createdDate: overallClientSummary.createdDate,
        updatedDate: overallClientSummary.updatedDate,
        startTime: overallClientSummary.startTime,
        endTime: overallClientSummary.endTime,
        retryCount: overallClientSummary.retryCount,
      })
      .from(overallClientSummary)
      .where(
        sql`${overallClientSummary.clientIdRef} = ${cid} AND ${overallClientSummary.type} = ${summaryType} AND ${overallClientSummary.runDate} = ${latestRunDate}`
      )
      .orderBy(overallClientSummary.createdDate)

    // Add clientManager to each summary
    const summariesWithManager = summaries.map((summary) => ({
      ...summary,
      clientManager: resolvedClientManager,
    }))

    logger.info(`[${requestId}] Query results sample`, {
      summaryCount: summariesWithManager.length,
      firstSummaryClientManager: summariesWithManager[0]?.clientManager,
      cid,
      resolvedClientManager,
    })

    logger.info(`[${requestId}] Found overall client summaries`, {
      cid,
      runDate: latestRunDate,
      recordCount: summariesWithManager.length,
    })

    return NextResponse.json(
      {
        success: true,
        data: {
          client_id: cid,
          run_date: latestRunDate,
          total_records: summariesWithManager.length,
          summaries: summariesWithManager,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`[${requestId}] Error fetching overall client summaries`, {
      error: errorMessage,
    })

    return NextResponse.json(
      {
        success: false,
        error: { message: errorMessage || 'Failed to fetch overall client summaries' },
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const parsed = await parseRequest(
      arenaOverallClientSummaryBodyContract,
      request,
      {},
      {
        validationErrorResponse: overallClientSummaryValidationError,
      }
    )
    if (!parsed.success) return parsed.response
    const {
      client_id,
      client_name,
      type,
      one_day_summary,
      seven_day_summary,
      fourteen_day_summary,
      daily_summary_changes,
      weekly_sentiment,
      status,
    } = parsed.data.body

    const now = new Date()
    const todayDate = now.toISOString().split('T')[0]
    const runDateValue = todayDate

    logger.info(`[${requestId}] Saving overall client summary`, {
      client_id,
      client_name,
      type,
      hasOneDay: !!one_day_summary,
      hasSevenDay: !!seven_day_summary,
      hasFourteenDay: !!fourteen_day_summary,
      hasDailySummaryChanges: !!daily_summary_changes,
      status: status || 'PENDING',
      run_date: runDateValue,
    })

    const id = crypto.randomUUID()

    const existingRecord = await db
      .select()
      .from(overallClientSummary)
      .where(
        sql`${overallClientSummary.clientIdRef} = ${client_id} 
         AND ${overallClientSummary.runDate} = ${runDateValue}
         AND ${overallClientSummary.type} = ${type ?? null}`
      )
      .limit(1)

    if (existingRecord.length > 0) {
      await db
        .update(overallClientSummary)
        .set({
          clientName: client_name || 'Unknown Client',
          type: type ?? undefined,
          oneDaySummary: one_day_summary ?? undefined,
          sevenDaySummary: seven_day_summary ?? undefined,
          fourteenDaySummary: fourteen_day_summary ?? undefined,
          dailySummaryChanges: daily_summary_changes ?? undefined,
          weeklySentiment: weekly_sentiment ?? undefined,
          updatedDate: now,
          status: status || 'PENDING',
          runDate: runDateValue,
        })
        .where(
          sql`${overallClientSummary.clientIdRef} = ${client_id} 
           AND ${overallClientSummary.runDate} = ${runDateValue}
           AND ${overallClientSummary.type} = ${type ?? null}`
        )
    } else {
      await db.insert(overallClientSummary).values({
        id,
        clientIdRef: client_id,
        clientName: client_name || 'Unknown Client',
        type: type ?? undefined,
        oneDaySummary: one_day_summary ?? undefined,
        sevenDaySummary: seven_day_summary ?? undefined,
        fourteenDaySummary: fourteen_day_summary ?? undefined,
        dailySummaryChanges: daily_summary_changes ?? undefined,
        weeklySentiment: weekly_sentiment ?? undefined,
        createdDate: now,
        updatedDate: now,
        status: status || 'PENDING',
        retryCount: 0,
        runDate: runDateValue,
      })
    }

    const action = existingRecord.length > 0 ? 'updated' : 'created'

    logger.info(`[${requestId}] Successfully ${action} overall client summary`, {
      id,
      client_id,
      run_date: runDateValue,
      action,
    })

    return NextResponse.json(
      {
        success: true,
        data: {
          id,
          message: `Overall client summary ${action} successfully`,
          action,
        },
      },
      { status: action === 'created' ? 201 : 200 }
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`[${requestId}] Error saving overall client summary`, { error: errorMessage })

    return NextResponse.json(
      {
        success: false,
        error: { message: errorMessage || 'Failed to save overall client summary' },
      },
      { status: 500 }
    )
  }
}
