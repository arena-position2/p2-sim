import type { SkyvernGetRunParams, SkyvernGetRunResponse } from '@/tools/skyvern/types'
import {
  buildSkyvernUrl,
  requireSkyvernApiKey,
  resolveSkyvernBaseUrl,
  resolveSkyvernRunsApiPath,
} from '@/tools/skyvern/utils'
import type { ToolConfig } from '@/tools/types'

export const skyvernGetRunTool: ToolConfig<SkyvernGetRunParams, SkyvernGetRunResponse> = {
  id: 'skyvern_get_run',
  name: 'Skyvern Get Run',
  description: 'Get the status and output of a Skyvern workflow run',
  version: '1.0.0',

  params: {
    apiKey: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description:
        'Skyvern API key (x-api-key header). Optional if SKYVERN_API_KEY is set on the server.',
    },
    baseUrl: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description:
        'Skyvern server base URL (e.g. https://api.skyvern.com). Optional if SKYVERN_BASE_URL is set on the server.',
    },
    runId: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Workflow run ID (wr_...)',
    },
  },

  request: {
    allowHttp: true,
    url: (params) => {
      const runsPath = resolveSkyvernRunsApiPath()
      const runId = params.runId.trim()
      return buildSkyvernUrl(resolveSkyvernBaseUrl(params.baseUrl), `${runsPath}/${runId}`)
    },
    method: 'GET',
    headers: (params) => ({
      'Content-Type': 'application/json',
      'x-api-key': requireSkyvernApiKey(params.apiKey),
    }),
  },

  transformResponse: async (response) => {
    const data = await response.json()
    const screenshotUrls = Array.isArray(data.screenshot_urls)
      ? data.screenshot_urls
      : data.screenshot_urls == null
        ? null
        : [data.screenshot_urls]

    return {
      success: true,
      output: {
        runId: data.run_id ?? null,
        status: data.status ?? null,
        output: (data.output as Record<string, unknown> | null | undefined) ?? null,
        failureReason: data.failure_reason ?? null,
        downloadedFiles: data.downloaded_files ?? [],
        recordingUrl: data.recording_url ?? null,
        screenshotUrls,
        createdAt: data.created_at ?? null,
        startedAt: data.started_at ?? null,
        finishedAt: data.finished_at ?? null,
        appUrl: data.app_url ?? null,
        stepCount: data.step_count ?? null,
        runType: data.run_type ?? null,
      },
    }
  },

  outputs: {
    runId: {
      type: 'string',
      description: 'Workflow run ID',
    },
    status: {
      type: 'string',
      description: 'Run status (e.g. completed, failed, running)',
    },
    output: {
      type: 'json',
      description: 'Run output payload including block outputs and extracted information',
      optional: true,
    },
    failureReason: {
      type: 'string',
      description: 'Failure reason when status is failed',
      optional: true,
    },
    downloadedFiles: {
      type: 'array',
      description: 'Files downloaded during the run',
      optional: true,
    },
    recordingUrl: {
      type: 'string',
      description: 'URL to the run recording',
      optional: true,
    },
    screenshotUrls: {
      type: 'array',
      description: 'Screenshot URLs captured during the run',
      optional: true,
    },
    createdAt: {
      type: 'string',
      description: 'Run creation timestamp',
      optional: true,
    },
    startedAt: {
      type: 'string',
      description: 'Run start timestamp',
      optional: true,
    },
    finishedAt: {
      type: 'string',
      description: 'Run finish timestamp',
      optional: true,
    },
    appUrl: {
      type: 'string',
      description: 'URL to view the run in the Skyvern app',
      optional: true,
    },
    stepCount: {
      type: 'number',
      description: 'Number of steps executed',
      optional: true,
    },
    runType: {
      type: 'string',
      description: 'Run type (e.g. workflow_run)',
      optional: true,
    },
  },
}
