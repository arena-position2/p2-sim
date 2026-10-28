import { createLogger } from '@sim/logger'
import type { ToolConfig, ToolResponse } from '@/tools/types'
import { fetchZoomRecordings, splitDateRange } from '@/tools/zoom/list_account_recordings'
import type { ZoomListAccountRecordingsParams } from '@/tools/zoom/types'

const logger = createLogger('zoom:get_account_recordings_with_transcript')

async function downloadTranscript(downloadUrl: string, accessToken?: string): Promise<string> {
  if (!accessToken) {
    throw new Error('Missing access token for Zoom transcript download')
  }

  const response = await fetch(downloadUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(
      `Failed to download transcript: ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    )
  }

  return response.text()
}

export interface ZoomGetAccountRecordingsWithTranscriptParams
  extends ZoomListAccountRecordingsParams {
  meetingTitle?: string
}

export interface ZoomGetAccountRecordingsWithTranscriptResponse extends ToolResponse {
  output: {
    recordings: Array<{
      topic: string
      start_time: string
      transcript_download_url: string
      content: string
    }>
  }
}

async function fetchAccountRecordingsWithTranscript(
  params: ZoomGetAccountRecordingsWithTranscriptParams
): Promise<ZoomGetAccountRecordingsWithTranscriptResponse> {
  try {
    logger.info('Fetching account recordings', {
      from: params.from,
      to: params.to,
      meetingTitle: params.meetingTitle,
    })

    let allRecordings: any[] = []

    if (!params.from || !params.to) {
      logger.info('No date range provided, making single API call without date filters')
      const result = await fetchZoomRecordings(params)
      allRecordings = result.recordings
    } else {
      const fromDate = new Date(params.from)
      const toDate = new Date(params.to)
      const daysDiff = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24))

      if (daysDiff <= 30) {
        const result = await fetchZoomRecordings(params, params.from, params.to)
        allRecordings = result.recordings
      } else {
        const chunks = splitDateRange(params.from, params.to)

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

        allRecordings = Array.from(
          new Map(allRecordings.map((recording) => [recording.uuid, recording])).values()
        )
      }
    }

    if (params.meetingTitle) {
      const titleFilters = params.meetingTitle
        .split(',')
        .map((title) => title.trim().toLowerCase())
        .filter((title) => title.length > 0)

      if (titleFilters.length > 0) {
        allRecordings = allRecordings.filter((recording) => {
          const topic = (recording.topic || '').toLowerCase()
          return titleFilters.some((filter) => topic.includes(filter))
        })
      }
    }

    const recordingsWithTranscript = allRecordings.filter((recording) => {
      const recordingFiles = recording.recording_files || []
      return recordingFiles.some(
        (file: { file_type?: string; download_url?: string }) =>
          file.file_type === 'TRANSCRIPT' && file.download_url
      )
    })

    const results: Array<{
      topic: string
      start_time: string
      transcript_download_url: string
      content: string
    }> = []

    for (const recording of recordingsWithTranscript) {
      const recordingFiles = recording.recording_files || []
      const transcriptFile = recordingFiles.find(
        (file: { file_type?: string; download_url?: string }) =>
          file.file_type === 'TRANSCRIPT' && file.download_url
      )

      if (!transcriptFile?.download_url) continue

      try {
        const content = await downloadTranscript(transcriptFile.download_url, params.accessToken)
        results.push({
          topic: recording.topic || '',
          start_time: recording.start_time || '',
          transcript_download_url: transcriptFile.download_url,
          content,
        })
      } catch (error) {
        logger.error(`Error downloading transcript for ${recording.topic}`, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      success: true,
      output: {
        recordings: results,
      },
    }
  } catch (error) {
    logger.error('Error in get account recordings with transcript', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      output: {
        recordings: [],
      },
    }
  }
}

export const zoomGetAccountRecordingsWithTranscriptTool: ToolConfig<
  ZoomGetAccountRecordingsWithTranscriptParams,
  ZoomGetAccountRecordingsWithTranscriptResponse
> = {
  id: 'zoom_get_account_recordings_with_transcript',
  name: 'Zoom Get Account Recordings with Transcript',
  description: 'Get all account recordings with transcripts, optionally filtered by meeting title',
  version: '1.0.0',

  request: {
    url: (params) => {
      const baseUrl = 'https://api.zoom.us/v2/accounts/me/recordings'
      const queryParams = new URLSearchParams()
      if (params.from) queryParams.append('from', params.from)
      if (params.to) queryParams.append('to', params.to)
      if (params.pageSize) queryParams.append('page_size', String(params.pageSize))
      if (params.nextPageToken) queryParams.append('next_page_token', params.nextPageToken)
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

  oauth: {
    required: true,
    provider: 'zoom-admin',
    requiredScopes: [
      'recording:read:list_account_recordings',
      'recording:read:admin',
      'cloud_recording:read:list_recording_files',
    ],
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
    meetingTitle: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Filter recordings by meeting topic/title. Supports comma-separated list for matching multiple titles (case-insensitive, partial match).',
    },
  },

  transformResponse: async (_response, params?) => {
    if (!params) {
      throw new Error('Missing parameters')
    }
    return fetchAccountRecordingsWithTranscript(params)
  },

  outputs: {
    recordings: {
      type: 'array',
      description: 'List of recordings with their transcripts',
    },
  },
}
