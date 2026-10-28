import { createLogger } from '@sim/logger'
import type { ToolConfig } from '@/tools/types'
import type {
  ZoomListAccountRecordingsParams,
  ZoomListAccountRecordingsResponse,
} from '@/tools/zoom/types'

const logger = createLogger('zoom:list_account_recordings')

/**
 * Format a date as yyyy-mm-dd
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Split a date range into 30-day chunks
 */
export function splitDateRange(from: string, to: string): Array<{ from: string; to: string }> {
  const fromDate = new Date(from)
  const toDate = new Date(to)
  const chunks: Array<{ from: string; to: string }> = []

  let currentFrom = new Date(fromDate)

  while (currentFrom < toDate) {
    const chunkTo = new Date(currentFrom)
    chunkTo.setDate(chunkTo.getDate() + 29) // 30 days total (inclusive)

    // Don't exceed the original to date
    if (chunkTo > toDate) {
      chunkTo.setTime(toDate.getTime())
    }

    chunks.push({
      from: formatDate(currentFrom),
      to: formatDate(chunkTo),
    })

    // Move to next chunk (start from day after current chunk end)
    currentFrom = new Date(chunkTo)
    currentFrom.setDate(currentFrom.getDate() + 1)
  }

  return chunks
}

/**
 * Make a single API call to Zoom for a date range, handling pagination
 */
export async function fetchZoomRecordings(
  params: ZoomListAccountRecordingsParams,
  chunkFrom?: string,
  chunkTo?: string
): Promise<{ recordings: any[]; pageInfo: any }> {
  const baseUrl = `https://api.zoom.us/v2/accounts/me/recordings`
  const allRecordings: any[] = []
  let nextPageToken: string | undefined = params.nextPageToken
  let firstPageInfo: any = null

  do {
    const queryParams = new URLSearchParams()
    if (chunkFrom) {
      queryParams.append('from', chunkFrom)
    }
    if (chunkTo) {
      queryParams.append('to', chunkTo)
    }
    if (params.pageSize) {
      queryParams.append('page_size', String(params.pageSize))
    }
    if (nextPageToken) {
      queryParams.append('next_page_token', nextPageToken)
    }

    const url = `${baseUrl}?${queryParams.toString()}`

    // Keep URL validation local so this module remains client-bundle safe.
    let validatedUrl: URL
    try {
      validatedUrl = new URL(url)
    } catch {
      throw new Error('Invalid Zoom API URL')
    }
    if (validatedUrl.protocol !== 'https:') {
      throw new Error('Invalid Zoom API URL: HTTPS required')
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 300000)
    const response = await fetch(validatedUrl.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.accessToken}`,
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId))

    if (!response.ok) {
      const errorText = await response.text()
      let errorMessage = `Zoom API error: ${response.status} ${response.statusText}`
      try {
        const errorData = JSON.parse(errorText)
        errorMessage = errorData.message || errorMessage
      } catch {
        // Use default error message
      }
      throw new Error(errorMessage)
    }

    const data = await response.json()
    const meetings = data.meetings || []
    allRecordings.push(...meetings)

    // Store page info from first page
    if (!firstPageInfo) {
      firstPageInfo = {
        from: data.from || chunkFrom || '',
        to: data.to || chunkTo || '',
        pageSize: data.page_size || 0,
        totalRecords: data.total_records || 0,
      }
    }

    // Check for next page
    nextPageToken = data.next_page_token
  } while (nextPageToken)

  return {
    recordings: allRecordings,
    pageInfo: firstPageInfo || {
      from: chunkFrom || '',
      to: chunkTo || '',
      pageSize: 0,
      totalRecords: 0,
    },
  }
}

function mapRecordings(recordings: any[]) {
  return recordings.map((recording: any) => ({
    uuid: recording.uuid,
    id: recording.id,
    account_id: recording.account_id,
    host_id: recording.host_id,
    topic: recording.topic,
    type: recording.type,
    start_time: recording.start_time,
    duration: recording.duration,
    total_size: recording.total_size,
    recording_count: recording.recording_count,
    share_url: recording.share_url,
    recording_files: recording.recording_files || [],
  }))
}

export const zoomListAccountRecordingsTool: ToolConfig<
  ZoomListAccountRecordingsParams,
  ZoomListAccountRecordingsResponse
> = {
  id: 'zoom_list_account_recordings',
  name: 'Zoom List Account Recordings',
  description: 'List all cloud recordings for a Zoom account',
  version: '1.0.0',

  oauth: {
    required: true,
    provider: 'zoom-admin',
    requiredScopes: ['recording:read:list_account_recordings', 'recording:read:admin'],
  },

  params: {
    from: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Start date in yyyy-mm-dd format (within last 6 months). Date ranges exceeding 30 days will be automatically split into 30-day chunks and all recordings will be combined.',
    },
    to: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'End date in yyyy-mm-dd format. Date ranges exceeding 30 days will be automatically split into 30-day chunks and all recordings will be combined.',
    },
    pageSize: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Number of records per page (max 300)',
    },
    nextPageToken: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Token for pagination to get next page of results',
    },
  },

  request: {
    url: (params) => {
      const baseUrl = `https://api.zoom.us/v2/accounts/me/recordings`
      const queryParams = new URLSearchParams()

      if (params.from) {
        queryParams.append('from', params.from)
      }
      if (params.to) {
        queryParams.append('to', params.to)
      }
      if (params.pageSize) {
        queryParams.append('page_size', String(params.pageSize))
      }
      if (params.nextPageToken) {
        queryParams.append('next_page_token', params.nextPageToken)
      }

      const queryString = queryParams.toString()
      return queryString ? `${baseUrl}?${queryString}` : baseUrl
    },
    method: 'GET',
    headers: (params) => {
      if (!params.accessToken) {
        throw new Error('Missing access token for Zoom API request')
      }
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.accessToken}`,
      }
    },
  },

  transformResponse: async (_response, params?) => {
    if (!params) {
      throw new Error('Missing parameters')
    }

    const emptyFailure = (error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : String(error),
      output: {
        recordings: [],
        pageInfo: {
          from: params.from || '',
          to: params.to || '',
          pageSize: 0,
          totalRecords: 0,
        },
      },
    })

    try {
      // Account recordings may span >30 days; fetchZoomRecordings handles pagination
      // and we chunk long ranges here (replaces the former directExecution path).
      if (!params.from || !params.to) {
        const result = await fetchZoomRecordings(params)
        return {
          success: true,
          output: {
            recordings: mapRecordings(result.recordings),
            pageInfo: result.pageInfo,
          },
        }
      }

      const fromDate = new Date(params.from)
      const toDate = new Date(params.to)
      const daysDiff = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24))

      if (daysDiff <= 30) {
        const result = await fetchZoomRecordings(params, params.from, params.to)
        return {
          success: true,
          output: {
            recordings: mapRecordings(result.recordings),
            pageInfo: {
              ...result.pageInfo,
              from: params.from,
              to: params.to,
            },
          },
        }
      }

      const chunks = splitDateRange(params.from, params.to)
      const allRecordings: any[] = []

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        try {
          const chunkResult = await fetchZoomRecordings(params, chunk.from, chunk.to)
          allRecordings.push(...chunkResult.recordings)
        } catch (error) {
          logger.error(`Error fetching recordings for chunk ${i + 1}`, {
            error: error instanceof Error ? error.message : String(error),
            chunkFrom: chunk.from,
            chunkTo: chunk.to,
          })
        }
      }

      const uniqueRecordings = Array.from(
        new Map(allRecordings.map((recording) => [recording.uuid, recording])).values()
      )

      return {
        success: true,
        output: {
          recordings: mapRecordings(uniqueRecordings),
          pageInfo: {
            from: params.from,
            to: params.to,
            pageSize: uniqueRecordings.length,
            totalRecords: uniqueRecordings.length,
          },
        },
      }
    } catch (error) {
      return emptyFailure(error)
    }
  },

  outputs: {
    recordings: {
      type: 'array',
      description: 'List of recordings',
    },
    pageInfo: {
      type: 'object',
      description: 'Pagination information',
      properties: {
        from: { type: 'string', description: 'Start date of query range' },
        to: { type: 'string', description: 'End date of query range' },
        pageSize: { type: 'number', description: 'Number of records per page' },
        totalRecords: { type: 'number', description: 'Total number of records' },
        nextPageToken: { type: 'string', description: 'Token for next page' },
      },
    },
  },
}
