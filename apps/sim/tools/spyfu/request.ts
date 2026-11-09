import { createLogger } from '@sim/logger'
import { env } from '@/lib/core/config/env'
import {
  getSpyfuOperationDefinition,
  SPYFU_BASE_URL,
  spyfuDateOperationIds,
  spyfuDomainOperationIds,
  spyfuKeywordOperationIds,
  spyfuQueryOperationIds,
  spyfuTermOperationIds,
} from '@/tools/spyfu/operations'
import type { SpyfuRequestParams, SpyfuResponse } from '@/tools/spyfu/types'
import type { HttpMethod, ToolConfig } from '@/tools/types'

const logger = createLogger('SpyfuTool')

interface PreparedSpyfuRequest {
  url: string
  method: HttpMethod
  headers: Record<string, string>
  body?: Record<string, any> | string
  query: Record<string, string>
  endpointPath: string
}

function resolveCredentials(): { userId: string; password: string } {
  const userId = env.SPYFU_API_USER_ID?.trim()
  const password = env.SPYFU_API_PASSWORD?.trim()

  if (!userId || !password) {
    throw new Error(
      'SpyFu API credentials are missing. Set SPYFU_API_USER_ID and SPYFU_API_PASSWORD.'
    )
  }

  return { userId, password }
}

function normalizeQueryParams(params: SpyfuRequestParams): Record<string, string> {
  const normalized: Record<string, string> = {}

  if (params.countryCode?.trim()) {
    normalized.countryCode = params.countryCode.trim()
  }
  if (params.domain?.trim()) {
    normalized.domain = params.domain.trim()
  }
  if (params.keyword?.trim()) {
    normalized.keyword = params.keyword.trim()
  }
  if (params.term?.trim()) {
    normalized.term = params.term.trim()
  }
  if (params.query?.trim()) {
    normalized.query = params.query.trim()
  }
  if (params.date?.trim()) {
    normalized.date = params.date.trim()
  }
  if (params.includeDomainsCsv?.trim()) {
    normalized.includeDomainsCsv = params.includeDomainsCsv.trim()
  }
  if (params.isIntersection) {
    normalized.isIntersection = params.isIntersection.toString()
  }
  normalized.pageSize = '20'

  return normalized
}

function validateRequiredParams(operationId: string, params: SpyfuRequestParams) {
  if (spyfuDomainOperationIds.includes(operationId) && !params.domain?.trim()) {
    throw new Error('Domain is required for the selected SpyFu endpoint.')
  }
  if (spyfuTermOperationIds.includes(operationId) && !params.term?.trim()) {
    throw new Error('Term is required for the selected SpyFu endpoint.')
  }
  if (spyfuKeywordOperationIds.includes(operationId) && !params.keyword?.trim()) {
    throw new Error('Keyword is required for the selected SpyFu endpoint.')
  }
  if (spyfuQueryOperationIds.includes(operationId) && !params.query?.trim()) {
    throw new Error('Query is required for the selected SpyFu endpoint.')
  }
  if (spyfuDateOperationIds.includes(operationId) && !params.date?.trim()) {
    throw new Error('Date is required for the selected SpyFu endpoint.')
  }
}

function prepareRequest(params: SpyfuRequestParams): PreparedSpyfuRequest {
  if (!params.operationId) {
    throw new Error('Select a SpyFu operation before running this block.')
  }

  validateRequiredParams(params.operationId, params)

  const credentials = resolveCredentials()

  const operation = getSpyfuOperationDefinition(params.operationId)
  if (!operation) {
    throw new Error(`Unknown SpyFu operation: ${params.operationId}`)
  }

  const method = operation.method
  const endpointPath = `${SPYFU_BASE_URL}${operation.path}`

  const query = normalizeQueryParams(params)
  const url = new URL(endpointPath)
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value))
    }
  })

  logger.info('SpyFu request prepared', {
    operationId: params.operationId,
    endpoint: url.toString(),
    method,
    queryParams: query,
    hasDomain: !!query.domain,
    hasCountryCode: !!query.countryCode,
    domain: query.domain,
    countryCode: query.countryCode,
    credentialsPresent: !!credentials.userId && !!credentials.password,
  })

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${credentials.userId}:${credentials.password}`).toString('base64')}`,
  }

  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json'
  }

  return {
    url: url.toString(),
    method,
    headers,
    query,
    endpointPath,
  }
}

export const spyfuRequestTool: ToolConfig<SpyfuRequestParams, SpyfuResponse> = {
  id: 'spyfu_request',
  name: 'SpyFu API',
  description: 'Call any SpyFu REST endpoint for domain, keyword, ranking, or account insights.',
  version: '1.0.0',
  params: {
    operationId: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'The predefined SpyFu operation to execute.',
    },
    domain: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Domain parameter for domain-based SpyFu endpoints.',
    },
    keyword: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Keyword parameter for keyword-based SpyFu endpoints.',
    },
    term: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Keyword parameter for keyword-based SpyFu endpoints.',
    },
    date: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Date parameter (YYYY-MM-DD) for endpoints that require a specific date.',
    },
    countryCode: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'SpyFu country code (US, UK, DE, etc.) appended as `countryCode` query parameter.',
    },
  },
  outputs: {
    data: {
      type: 'json',
      description: 'Raw payload returned by the SpyFu API endpoint.',
    },
    status: {
      type: 'number',
      description: 'HTTP status code returned by SpyFu.',
    },
    headers: {
      type: 'json',
      description: 'SpyFu response headers.',
    },
    endpoint: {
      type: 'string',
      description: 'Full SpyFu endpoint URL used for the request.',
    },
    method: {
      type: 'string',
      description: 'HTTP method used for the SpyFu request.',
    },
  },
  request: {
    url: (params) => prepareRequest(params).url,
    method: (params) => prepareRequest(params).method,
    headers: (params) => prepareRequest(params).headers,
    body: (params) => {
      const prepared = prepareRequest(params)
      if (prepared.method === 'GET' || prepared.method === 'HEAD') {
        return undefined as any
      }
      const body = prepared.body
      if (!body || typeof body === 'string') {
        return undefined as any
      }
      return body as Record<string, any>
    },
  },
  transformResponse: async (response: Response, params?: SpyfuRequestParams) => {
    const prepared = prepareRequest(params ?? {})

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    // Always read as text first to handle both JSON and HTML responses
    const responseText = await response.text()
    const contentType = response.headers.get('content-type') || ''
    const isJson = contentType.includes('json')
    logger.info('SpyFu response received', {
      status: response.status,
      statusText: response.statusText,
      contentType,
      isJson,
      responseLength: responseText.length,
      preview: responseText,
    })
    let payload: any
    try {
      // Try to parse as JSON if content-type suggests JSON or if it starts with { or [
      if (isJson || responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
        payload = JSON.parse(responseText)
      } else {
        payload = responseText
      }
    } catch {
      // If JSON parsing fails, use the raw text
      payload = responseText
      logger.warn('Failed to parse response as JSON, using raw text', {
        contentType,
        responseLength: responseText.length,
        preview: responseText.substring(0, 200),
      })
    }

    if (!response.ok) {
      logger.error('SpyFu API request failed', {
        status: response.status,
        statusText: response.statusText,
        endpoint: prepared.url,
        contentType,
        payloadPreview: typeof payload === 'string' ? payload.substring(0, 500) : payload,
      })

      // Extract error message from various response formats
      let errorMessage = 'SpyFu API request failed'
      if (typeof payload === 'object' && payload !== null) {
        errorMessage =
          payload.message || payload.error || payload.errorMessage || JSON.stringify(payload)
      } else if (typeof payload === 'string') {
        // Try to extract meaningful error from HTML if present
        if (payload.includes('<!DOCTYPE') || payload.includes('<html')) {
          // Extract title or first meaningful text from HTML
          const titleMatch = payload.match(/<title[^>]*>([^<]+)<\/title>/i)
          const h1Match = payload.match(/<h1[^>]*>([^<]+)<\/h1>/i)
          errorMessage =
            titleMatch?.[1] || h1Match?.[1] || `HTTP ${response.status}: ${response.statusText}`
        } else {
          errorMessage = payload.substring(0, 500)
        }
      }

      return {
        success: false,
        error: errorMessage,
        output: {
          status: response.status,
          statusText: response.statusText,
          data: payload,
          headers,
          endpoint: prepared.url,
          method: prepared.method,
          query: prepared.query,
        },
      }
    }

    return {
      success: true,
      output: {
        status: response.status,
        data: payload,
        headers,
        endpoint: prepared.url,
        method: prepared.method,
        query: prepared.query,
      },
    }
  },
}
