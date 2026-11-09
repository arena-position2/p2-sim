import { db, sql } from '@sim/db'
import { arenaTaskSummary } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import {
  arenaTaskSummaryBodyContract,
  arenaTaskSummaryQueryContract,
} from '@/lib/api/contracts/arena-task-summary'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'

const logger = createLogger('arena-task-summary-api')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const parseOptionalDate = (value?: string) => {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

export async function GET(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const parsed = await parseRequest(arenaTaskSummaryQueryContract, request, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json(
          { success: false, error: { message: getValidationErrorMessage(error) } },
          { status: 400 }
        ),
    })
    if (!parsed.success) return parsed.response
    const clientId = parsed.data.query.cid
    const summaryType = parsed.data.query.type

    logger.info(`[${requestId}] Fetching latest arena task summaries for client`, {
      clientId,
      type: summaryType,
    })

    const latestDateResult = await db
      .select({ runDate: arenaTaskSummary.runDate })
      .from(arenaTaskSummary)
      .where(
        sql`${arenaTaskSummary.clientIdRef} = ${clientId} AND ${arenaTaskSummary.type} = ${summaryType}`
      )
      .orderBy(sql`${arenaTaskSummary.runDate} DESC`)
      .limit(1)

    if (latestDateResult.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            client_id: clientId,
            message: 'No arena task summary data found for this client and type',
            summaries: [],
          },
        },
        { status: 200 }
      )
    }

    const latestRunDate = latestDateResult[0].runDate

    const summaries = await db
      .select({
        id: arenaTaskSummary.id,
        clientIdRef: arenaTaskSummary.clientIdRef,
        clientName: arenaTaskSummary.clientName,
        type: arenaTaskSummary.type,
        oneDaySummary: arenaTaskSummary.oneDaySummary,
        sevenDaySummary: arenaTaskSummary.sevenDaySummary,
        fourteenDaySummary: arenaTaskSummary.fourteenDaySummary,
        runDate: arenaTaskSummary.runDate,
        status: arenaTaskSummary.status,
        createdDate: arenaTaskSummary.createdDate,
        updatedDate: arenaTaskSummary.updatedDate,
        startTime: arenaTaskSummary.startTime,
        endTime: arenaTaskSummary.endTime,
        retryCount: arenaTaskSummary.retryCount,
      })
      .from(arenaTaskSummary)
      .where(
        sql`${arenaTaskSummary.clientIdRef} = ${clientId} AND ${arenaTaskSummary.type} = ${summaryType} AND ${arenaTaskSummary.runDate} = ${latestRunDate}`
      )
      .orderBy(arenaTaskSummary.createdDate)

    logger.info(`[${requestId}] Found arena task summaries for client`, {
      clientId,
      runDate: latestRunDate,
      recordCount: summaries.length,
    })

    return NextResponse.json(
      {
        success: true,
        data: {
          client_id: clientId,
          run_date: latestRunDate,
          total_records: summaries.length,
          summaries,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`[${requestId}] Error fetching arena task summaries`, { error: errorMessage })

    return NextResponse.json(
      {
        success: false,
        error: { message: errorMessage || 'Failed to fetch arena task summaries' },
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const parsed = await parseRequest(arenaTaskSummaryBodyContract, request, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json(
          { success: false, error: { message: getValidationErrorMessage(error) } },
          { status: 400 }
        ),
    })
    if (!parsed.success) return parsed.response
    const {
      client_id,
      client_name,
      type,
      one_day_summary,
      seven_day_summary,
      fourteen_day_summary,
      start_time,
      end_time,
      status,
      retry_count,
      run_date,
    } = parsed.data.body

    const now = new Date()
    const todayDate = now.toISOString().split('T')[0]
    const runDateValue = run_date || todayDate
    const startTimeValue = parseOptionalDate(start_time)
    const endTimeValue = parseOptionalDate(end_time)

    if (startTimeValue === null || endTimeValue === null) {
      return NextResponse.json(
        { success: false, error: { message: 'Invalid start_time or end_time' } },
        { status: 400 }
      )
    }

    logger.info(`[${requestId}] Saving arena task summary`, {
      client_id,
      client_name,
      type,
      hasOneDay: !!one_day_summary,
      hasSevenDay: !!seven_day_summary,
      hasFourteenDay: !!fourteen_day_summary,
      run_date: runDateValue,
    })

    const id = crypto.randomUUID()
    const retryCountValue = typeof retry_count === 'number' ? retry_count : undefined

    const existingRecord = await db
      .select()
      .from(arenaTaskSummary)
      .where(
        sql`${arenaTaskSummary.clientIdRef} = ${client_id} AND ${arenaTaskSummary.runDate} = ${runDateValue} AND ${arenaTaskSummary.type} = ${type ?? null}`
      )
      .limit(1)

    if (existingRecord.length > 0) {
      await db
        .update(arenaTaskSummary)
        .set({
          clientName: client_name || 'Unknown Client',
          type: type ?? undefined,
          oneDaySummary: one_day_summary ?? undefined,
          sevenDaySummary: seven_day_summary ?? undefined,
          fourteenDaySummary: fourteen_day_summary ?? undefined,
          updatedDate: now,
          startTime: startTimeValue ?? undefined,
          endTime: endTimeValue ?? undefined,
          status: status || 'STARTED',
          retryCount: retryCountValue,
          runDate: runDateValue,
        })
        .where(
          sql`${arenaTaskSummary.clientIdRef} = ${client_id} AND ${arenaTaskSummary.runDate} = ${runDateValue} AND ${arenaTaskSummary.type} = ${type ?? null}`
        )
    } else {
      await db.insert(arenaTaskSummary).values({
        id,
        clientIdRef: client_id,
        clientName: client_name || 'Unknown Client',
        type: type ?? undefined,
        oneDaySummary: one_day_summary ?? undefined,
        sevenDaySummary: seven_day_summary ?? undefined,
        fourteenDaySummary: fourteen_day_summary ?? undefined,
        createdDate: now,
        updatedDate: now,
        startTime: startTimeValue ?? undefined,
        endTime: endTimeValue ?? undefined,
        status: status || 'STARTED',
        retryCount: retry_count ?? 0,
        runDate: runDateValue,
      })
    }

    const action = existingRecord.length > 0 ? 'updated' : 'created'

    logger.info(`[${requestId}] Successfully ${action} arena task summary`, {
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
          message: `Arena task summary ${action} successfully`,
          action,
        },
      },
      { status: action === 'created' ? 201 : 200 }
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`[${requestId}] Error saving arena task summary`, { error: errorMessage })

    return NextResponse.json(
      { success: false, error: { message: errorMessage || 'Failed to save arena task summary' } },
      { status: 500 }
    )
  }
}
