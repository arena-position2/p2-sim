import { db } from '@sim/db'
import { clientChannelMapping } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { asc, eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { clientChannelMappingContract } from '@/lib/api/contracts/client-channel-mapping'
import { parseRequest } from '@/lib/api/server'

const logger = createLogger('client-channel-mapping')

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clientId: string }> }
) {
  const requestId = crypto.randomUUID()
  const parsed = await parseRequest(clientChannelMappingContract, request, { params })
  if (!parsed.success) return parsed.response
  const { clientId } = parsed.data.params

  logger.info(`[${requestId}] Fetching channels for client`, { clientId })

  try {
    const channels = await db
      .select()
      .from(clientChannelMapping)
      .where(eq(clientChannelMapping.clientId, clientId))
      .orderBy(asc(clientChannelMapping.channelName))

    logger.info(`[${requestId}] Found channels`, {
      clientId,
      channelCount: channels.length,
    })

    const responseData = {
      success: true,
      channels: channels.map((channel) => ({
        channel_id: channel.channelId,
        channel_name: channel.channelName,
      })),
    }

    return NextResponse.json(responseData)
  } catch (error) {
    logger.error(`[${requestId}] Error fetching channels`, {
      clientId,
      error: error instanceof Error ? error.message : String(error),
    })

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch channels',
      },
      { status: 500 }
    )
  }
}
