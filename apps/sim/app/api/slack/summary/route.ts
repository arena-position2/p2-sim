import { db } from '@sim/db'
import { slackSummary } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import {
  slackSummaryBodyContract,
  slackSummaryQueryContract,
} from '@/lib/api/contracts/slack-summary'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { generateRequestId } from '@/lib/core/utils/request'

const logger = createLogger('slack-summary-api')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const parsed = await parseRequest(slackSummaryQueryContract, request, undefined, {
      validationErrorResponse: (error) =>
        NextResponse.json(
          { success: false, error: { message: getValidationErrorMessage(error) } },
          { status: 400 }
        ),
    })
    if (!parsed.success) return parsed.response
    const clientId = parsed.data.query.cid
    const summaryType = parsed.data.query.type

    logger.info(`[${requestId}] Fetching latest summaries for client`, {
      clientId,
      type: summaryType,
    })

    const { sql } = await import('drizzle-orm')

    // Get the most recent run_date for this client
    const latestDateResult = await db
      .select({ runDate: slackSummary.runDate })
      .from(slackSummary)
      .where(
        sql`${slackSummary.clientIdRef} = ${clientId} AND ${slackSummary.type} = ${summaryType}`
      )
      .orderBy(sql`${slackSummary.runDate} DESC`)
      .limit(1)

    if (latestDateResult.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            client_id: clientId,
            message: 'No summary data found for this client and type',
            summaries: [],
          },
        },
        { status: 200 }
      )
    }

    const latestRunDate = latestDateResult[0].runDate

    // Get all summaries for this client on the latest run_date
    const summaries = await db
      .select({
        id: slackSummary.id,
        clientIdRef: slackSummary.clientIdRef,
        clientName: slackSummary.clientName,
        channelIdRef: slackSummary.channelIdRef,
        channelName: slackSummary.channelName,
        channelType: slackSummary.channelType,
        type: slackSummary.type,
        oneDaySummary: slackSummary.oneDaySummary,
        sevenDaySummary: slackSummary.sevenDaySummary,
        fourteenDaySummary: slackSummary.fourteenDaySummary,
        runDate: slackSummary.runDate,
        status: slackSummary.status,
        createdDate: slackSummary.createdDate,
        updatedDate: slackSummary.updatedDate,
      })
      .from(slackSummary)
      .where(
        sql`${slackSummary.clientIdRef} = ${clientId} AND ${slackSummary.type} = ${summaryType} AND ${slackSummary.runDate} = ${latestRunDate}`
      )
      .orderBy(slackSummary.channelType, slackSummary.channelName)

    logger.info(`[${requestId}] Found summaries for client`, {
      clientId,
      runDate: latestRunDate,
      recordCount: summaries.length,
    })

    // Group by channel type for better organization
    const groupedSummaries = {
      internal: summaries.filter((s) => s.channelType === 'internal'),
      external: summaries.filter((s) => s.channelType === 'external'),
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          client_id: clientId,
          run_date: latestRunDate,
          total_channels: summaries.length,
          summaries: groupedSummaries,
          summary: {
            internal_channels: groupedSummaries.internal.length,
            external_channels: groupedSummaries.external.length,
            total_records: summaries.length,
          },
        },
      },
      { status: 200 }
    )
  } catch (error: any) {
    logger.error(`[${requestId}] Error fetching summaries`, {
      error: error.message || String(error),
      errorCode: error.code,
    })

    return NextResponse.json(
      {
        success: false,
        error: { message: error.message || 'Failed to fetch summaries' },
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const parsed = await parseRequest(slackSummaryBodyContract, request, undefined, {
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
      channel_id,
      channel_name,
      channel_type,
      type,
      one_day_summary,
      seven_day_summary,
      fourteen_day_summary,
    } = parsed.data.body

    logger.info(`[${requestId}] Saving slack summary`, {
      client_id,
      client_name,
      channel_id,
      channel_name,
      channel_type,
      type,
      hasOneDay: !!one_day_summary,
      hasSevenDay: !!seven_day_summary,
      hasFourteenDay: !!fourteen_day_summary,
    })

    const now = new Date()
    const todayDate = now.toISOString().split('T')[0] // YYYY-MM-DD format
    // Generate unique ID - just a UUID
    const id = crypto.randomUUID()

    // Use UPSERT (INSERT ... ON CONFLICT) to handle both create and update
    const { sql } = await import('drizzle-orm')

    try {
      logger.info(`[${requestId}] Performing UPSERT for slack summary`)

      // Check if record exists first, then insert or update manually
      try {
        logger.info(`[${requestId}] Checking existing slack summary record`)

        // First, check if record exists for today (same client, channel, date)
        const existingRecord = await db
          .select()
          .from(slackSummary)
          .where(
            sql`${slackSummary.clientIdRef} = ${client_id} AND ${slackSummary.channelIdRef} = ${channel_id} AND ${slackSummary.runDate} = ${todayDate} AND ${slackSummary.type} = ${type ?? null}`
          )
          .limit(1)

        const recordExists = existingRecord.length > 0

        if (recordExists) {
          // Update existing record for today
          logger.info(`[${requestId}] Updating existing slack summary for today`)

          await db
            .update(slackSummary)
            .set({
              clientName: client_name || 'Unknown Client',
              channelName: channel_name || 'Unknown Channel',
              channelType: channel_type || 'internal',
              type: type ?? undefined,
              oneDaySummary: one_day_summary || undefined,
              sevenDaySummary: seven_day_summary || undefined,
              fourteenDaySummary: fourteen_day_summary || undefined,
              updatedDate: now,
              status: 'STARTED',
            })
            .where(
              sql`${slackSummary.clientIdRef} = ${client_id} AND ${slackSummary.channelIdRef} = ${channel_id} AND ${slackSummary.runDate} = ${todayDate} AND ${slackSummary.type} = ${type ?? null}`
            )

          logger.info(`[${requestId}] Slack summary update successful for today`)
        } else {
          // Insert new record for today
          logger.info(`[${requestId}] Inserting slack summary for today`)

          await db.insert(slackSummary).values({
            id,
            clientIdRef: client_id,
            clientName: client_name || 'Unknown Client',
            channelIdRef: channel_id,
            channelName: channel_name || 'Unknown Channel',
            channelType: channel_type || 'internal',
            type: type ?? undefined,
            oneDaySummary: one_day_summary || undefined,
            sevenDaySummary: seven_day_summary || undefined,
            fourteenDaySummary: fourteen_day_summary || undefined,
            createdDate: now,
            updatedDate: now,
            startTime: undefined,
            endTime: undefined,
            status: 'STARTED',
            retryCount: 0,
            runDate: todayDate,
          })

          logger.info(`[${requestId}] Slack summary insert successful for today`)
        }
      } catch (sqlError: any) {
        logger.error(`[${requestId}] Raw SQL failed, trying Drizzle`, sqlError)

        // Fallback to Drizzle
        try {
          await db
            .insert(slackSummary)
            .values({
              id,
              clientIdRef: client_id,
              clientName: client_name || 'Unknown Client',
              channelIdRef: channel_id,
              channelName: channel_name || 'Unknown Channel',
              channelType: channel_type || 'internal',
              type: type ?? undefined,
              oneDaySummary: one_day_summary || undefined,
              sevenDaySummary: seven_day_summary || undefined,
              fourteenDaySummary: fourteen_day_summary || undefined,
              createdDate: now,
              updatedDate: now,
              startTime: undefined,
              endTime: undefined,
              status: 'STARTED',
              retryCount: 0,
              runDate: todayDate,
            })
            .onConflictDoUpdate({
              target: [slackSummary.clientIdRef, slackSummary.channelIdRef],
              set: {
                clientName: client_name || 'Unknown Client',
                channelName: channel_name || 'Unknown Channel',
                channelType: channel_type || 'internal',
                type: type ?? undefined,
                oneDaySummary: one_day_summary || undefined,
                sevenDaySummary: seven_day_summary || undefined,
                fourteenDaySummary: fourteen_day_summary || undefined,
                updatedDate: now,
                status: 'STARTED',
                runDate: todayDate,
              },
            })

          logger.info(`[${requestId}] Drizzle upsert successful after raw SQL failed`)
        } catch (drizzleError: any) {
          logger.error(`[${requestId}] Both raw SQL and Drizzle failed`, drizzleError)
          throw drizzleError
        }
      }

      // Check if this was an insert or update by querying the record
      const record = await db
        .select()
        .from(slackSummary)
        .where(
          sql`${slackSummary.clientIdRef} = ${client_id} AND ${slackSummary.channelIdRef} = ${channel_id} AND ${slackSummary.type} = ${type ?? null}`
        )
        .limit(1)

      const action = record.length > 0 ? 'updated' : 'created'

      logger.info(`[${requestId}] Successfully ${action} slack summary`, {
        id,
        client_id,
        channel_id,
        run_date: todayDate,
        action,
      })

      return NextResponse.json(
        {
          success: true,
          data: {
            id,
            message: `Slack summary ${action} successfully for today`,
            action,
          },
        },
        { status: action === 'created' ? 201 : 200 }
      )
    } catch (error: any) {
      logger.error(`[${requestId}] Database operation failed`, error)
      throw error
    }
  } catch (error: any) {
    logger.error(`[${requestId}] Error saving slack summary`, {
      error: error.message || String(error),
      errorCode: error.code,
      errorDetails: error,
    })

    return NextResponse.json(
      {
        success: false,
        error: {
          message: error.message || 'Failed to save slack summary',
          code: error.code,
        },
      },
      { status: 500 }
    )
  }
}
