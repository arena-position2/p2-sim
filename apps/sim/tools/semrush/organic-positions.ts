import { createLogger } from '@sim/logger'
import { semrushHosting } from '@/tools/semrush/hosting'
import type {
  SemrushOrganicPositionsApiResponse,
  SemrushOrganicPositionsParams,
  SemrushOrganicPositionsResponse,
} from '@/tools/semrush/types'
import type { ToolConfig, ToolHostingConfig } from '@/tools/types'

const logger = createLogger('SemrushOrganicPositionsTool')

export const semrushOrganicPositionsTool: ToolConfig<
  SemrushOrganicPositionsParams,
  SemrushOrganicPositionsResponse
> = {
  id: 'semrush_organic_positions',
  name: 'Semrush Organic Positions Report',
  description:
    'Get Position Tracking organic positions report for a campaign: keywords, rankings per URL, position changes over time. Requires a Semrush API key configured on the block.',
  version: '1.0.0',

  hosting: semrushHosting as unknown as ToolHostingConfig<SemrushOrganicPositionsParams>,

  params: {
    apiKey: {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description: 'Semrush API key',
    },
    campaignId: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Position Tracking campaign ID (e.g. from List Campaigns).',
    },
    url: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description:
        'Tracked URL(s) with mask, e.g. *.example.com/* or *.apple.com/*:*.amazon.com/* for multiple.',
    },
    dateBegin: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Start date YYYYMMDD.',
    },
    dateEnd: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'End date YYYYMMDD.',
    },
    linktypeFilter: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description:
        '0=include all, 1=only local/hotels, 2=exclude local pack, 524288=exclude hotels, 524290=exclude local+hotels, 536870912=exclude AI Overview, etc.',
    },
    displayTags: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Tags filter, e.g. tag1|tag2 or tag1|-tag2 to exclude.',
    },
    displayTagsCondition: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Newer tags filter: | for OR, & for AND, ! to exclude (e.g. tag1&!tag2).',
    },
    displaySort: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Sort key, e.g. 0_pos_asc, 0_pos_desc, nq_desc, ph_asc, 0_diff_asc, vi_desc.',
    },
    displayLimit: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Number of results (default 10).',
    },
    displayOffset: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Offset for pagination.',
    },
    displayFilter: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Filter for Ph, Nq, Cp columns (e.g. +|Ph|Co|keyword).',
    },
    topFilter: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description:
        'Position filter: top_3, top_1page, top_2page, top_100, top_3_income, top_3_leave, etc.',
    },
    useVolume: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Volume level: national, regional, or local.',
    },
    businessName: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Business name (must match Google Business Profile).',
    },
    serpFeatureFilter: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'SERP feature filter, e.g. fsn,0 for Featured Snippet for first domain.',
    },
  },

  request: {
    url: (params: SemrushOrganicPositionsParams) => {
      const q = new URLSearchParams()
      q.set('campaignId', params.campaignId)
      q.set('url', params.url)
      if (params.dateBegin) q.set('date_begin', params.dateBegin)
      if (params.dateEnd) q.set('date_end', params.dateEnd)
      if (params.linktypeFilter !== undefined && params.linktypeFilter !== '')
        q.set('linktype_filter', String(params.linktypeFilter))
      if (params.displayTags) q.set('display_tags', params.displayTags)
      if (params.displayTagsCondition) q.set('display_tags_condition', params.displayTagsCondition)
      if (params.displaySort) q.set('display_sort', params.displaySort)
      if (params.displayLimit !== undefined && params.displayLimit !== '')
        q.set('display_limit', String(params.displayLimit))
      if (params.displayOffset !== undefined && params.displayOffset !== '')
        q.set('display_offset', String(params.displayOffset))
      if (params.displayFilter) q.set('display_filter', params.displayFilter)
      if (params.topFilter) q.set('top_filter', params.topFilter)
      if (params.useVolume) q.set('use_volume', params.useVolume)
      if (params.businessName) q.set('business_name', params.businessName)
      if (params.serpFeatureFilter) q.set('serp_feature_filter', params.serpFeatureFilter)
      q.set('apiKey', params.apiKey)
      const path = `/api/tools/semrush/position-tracking-organic?${q.toString()}`
      logger.info('Semrush Organic Positions: request path', { campaignId: params.campaignId })
      return path
    },
    method: 'GET',
    headers: (params) => ({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(params.apiKey ? { 'X-Semrush-Api-Key': params.apiKey } : {}),
    }),
  },

  transformResponse: async (
    response: Response,
    _params?: SemrushOrganicPositionsParams
  ): Promise<SemrushOrganicPositionsResponse> => {
    if (!response.ok) {
      const errorText = await response.text()
      logger.error('Semrush Organic Positions API error', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      })
      throw new Error(
        `Semrush Organic Positions API error: ${response.status} ${response.statusText} - ${errorText}`
      )
    }

    const raw: SemrushOrganicPositionsApiResponse = await response.json()
    const dataArray = Object.keys(raw.data)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => ({ _index: key, ...raw.data[key] }))

    logger.info('Semrush Organic Positions response parsed', {
      total: raw.total,
      limit: raw.limit,
      offset: raw.offset,
      rows: dataArray.length,
    })

    return {
      success: true,
      output: {
        reportType: 'tracking_position_organic',
        data: dataArray as Array<Record<string, unknown>>,
        totalRows: Number(raw.total),
        limit: raw.limit,
        offset: raw.offset,
        raw,
      },
    }
  },

  outputs: {
    reportType: {
      type: 'string',
      description: 'Report type: tracking_position_organic',
    },
    data: {
      type: 'json',
      description: 'Array of keyword rows with positions, visibility, SERP features, etc.',
    },
    totalRows: {
      type: 'number',
      description: 'Total number of keywords in the report',
    },
    limit: {
      type: 'number',
      description: 'Limit used for the request',
    },
    offset: {
      type: 'number',
      description: 'Offset used for the request',
    },
    raw: {
      type: 'json',
      description: 'Raw API response including data object keyed by index',
    },
  },
}
