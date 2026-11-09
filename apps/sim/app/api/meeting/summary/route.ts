import { db } from '@sim/db'
import { meetingSummary } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { sql } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import {
  meetingSummaryBodyContract,
  meetingSummaryQueryContract,
} from '@/lib/api/contracts/meeting-summary'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'

const logger = createLogger('meeting-summary-api')

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
    const parsed = await parseRequest(meetingSummaryQueryContract, request, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json(
          { success: false, error: { message: getValidationErrorMessage(error) } },
          { status: 400 }
        ),
    })
    if (!parsed.success) return parsed.response
    const clientId = parsed.data.query.cid
    const summaryType = parsed.data.query.type

    logger.info(`[${requestId}] Fetching latest meeting summaries for client`, {
      clientId,
      type: summaryType,
    })

    const latestDateResult = await db
      .select({ runDate: meetingSummary.runDate })
      .from(meetingSummary)
      .where(
        sql`${meetingSummary.clientIdRef} = ${clientId} AND ${meetingSummary.type} = ${summaryType}`
      )
      .orderBy(sql`${meetingSummary.runDate} DESC`)
      .limit(1)

    if (latestDateResult.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            client_id: clientId,
            message: 'No meeting summary data found for this client and type',
            summaries: [],
          },
        },
        { status: 200 }
      )
    }

    const latestRunDate = latestDateResult[0].runDate

    const summaries = await db
      .select({
        id: meetingSummary.id,
        clientIdRef: meetingSummary.clientIdRef,
        clientName: meetingSummary.clientName,
        meetingType: meetingSummary.meetingType,
        type: meetingSummary.type,
        oneDaySummary: meetingSummary.oneDaySummary,
        sevenDaySummary: meetingSummary.sevenDaySummary,
        fourteenDaySummary: meetingSummary.fourteenDaySummary,
        runDate: meetingSummary.runDate,
        status: meetingSummary.status,
        createdDate: meetingSummary.createdDate,
        updatedDate: meetingSummary.updatedDate,
        startTime: meetingSummary.startTime,
        endTime: meetingSummary.endTime,
        retryCount: meetingSummary.retryCount,
      })
      .from(meetingSummary)
      .where(
        sql`${meetingSummary.clientIdRef} = ${clientId} AND ${meetingSummary.type} = ${summaryType} AND ${meetingSummary.runDate} = ${latestRunDate}`
      )
      .orderBy(meetingSummary.createdDate)

    logger.info(`[${requestId}] Found meeting summaries for client`, {
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
    logger.error(`[${requestId}] Error fetching meeting summaries`, { error: errorMessage })

    return NextResponse.json(
      { success: false, error: { message: errorMessage || 'Failed to fetch meeting summaries' } },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const parsed = await parseRequest(meetingSummaryBodyContract, request, undefined, {
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
      meeting_type,
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

    logger.info(`[${requestId}] Saving meeting summary`, {
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
      .from(meetingSummary)
      .where(
        sql`${meetingSummary.clientIdRef} = ${client_id} AND ${meetingSummary.runDate} = ${runDateValue} AND ${meetingSummary.type} = ${type ?? null}`
      )
      .limit(1)

    if (existingRecord.length > 0) {
      await db
        .update(meetingSummary)
        .set({
          clientName: client_name || 'Unknown Client',
          meetingType: meeting_type,
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
          sql`${meetingSummary.clientIdRef} = ${client_id} AND ${meetingSummary.runDate} = ${runDateValue} AND ${meetingSummary.type} = ${type ?? null}`
        )
    } else {
      await db.insert(meetingSummary).values({
        id,
        clientIdRef: client_id,
        clientName: client_name || 'Unknown Client',
        meetingType: meeting_type,
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

    logger.info(`[${requestId}] Successfully ${action} meeting summary`, {
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
          message: `Meeting summary ${action} successfully`,
          action,
        },
      },
      { status: action === 'created' ? 201 : 200 }
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error(`[${requestId}] Error saving meeting summary`, { error: errorMessage })

    return NextResponse.json(
      { success: false, error: { message: errorMessage || 'Failed to save meeting summary' } },
      { status: 500 }
    )
  }
}
