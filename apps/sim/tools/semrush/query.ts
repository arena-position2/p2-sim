import { createLogger } from '@sim/logger'
import { semrushHosting } from '@/tools/semrush/hosting'
import type { SemrushParams, SemrushQueryResponse } from '@/tools/semrush/types'
import type { ToolConfig, ToolHostingConfig } from '@/tools/types'
import { parseCsvResponse } from '../utils'

const logger = createLogger('SemrushTool')

/**
 * For domain reports, Semrush API expects the root domain without "www."
 * (e.g. apple.com, not www.apple.com). Returns the domain with www stripped when appropriate.
 */
function toSemrushDomain(hostname: string): string {
  const lower = hostname.toLowerCase()
  if (lower.startsWith('www.')) {
    return hostname.slice(4)
  }
  return hostname
}

/**
 * Normalizes target for Semrush API. Domain-based reports require a root domain (e.g. "apple.com");
 * if the user pastes a full URL we extract the hostname and strip "www." per Semrush docs.
 * URL-based reports get a normalized URL.
 * If the user pastes an email (e.g. "user@company.com"), the domain part is used for domain reports.
 */
function normalizeSemrushTarget(target: string, reportType: string): string {
  const trimmed = target.trim()
  if (!trimmed) return trimmed

  const isDomainReport = !reportType.startsWith('url_')

  if (isDomainReport) {
    if (trimmed.includes('@') && !trimmed.includes('://')) {
      const domainPart = trimmed.split('@').pop()?.trim()
      if (domainPart) {
        logger.info('Semrush: Using domain from email-like input', {
          input: trimmed,
          domain: domainPart,
        })
        return toSemrushDomain(domainPart)
      }
    }
    try {
      const withProtocol = trimmed.includes('://') ? trimmed : `https://${trimmed}`
      const hostname = new URL(withProtocol).hostname
      if (hostname) {
        const domain = toSemrushDomain(hostname)
        if (domain !== trimmed) {
          logger.info('Semrush: Normalized domain from URL', {
            input: trimmed,
            domain,
          })
        }
        return domain
      }
    } catch {
      // Not a parseable URL; use as-is (e.g. plain domain like "example.com")
    }
    return toSemrushDomain(trimmed)
  }

  try {
    const withProtocol = trimmed.includes('://') ? trimmed : `https://${trimmed}`
    const normalized = new URL(withProtocol).href
    if (normalized !== trimmed) {
      logger.info('Semrush: Normalized URL', { input: trimmed, normalized })
    }
    return normalized
  } catch {
    return trimmed
  }
}

/** Mistaken values models pass as Semrush Analytics `type` (vs real report ids like domain_organic). */
const INVALID_SEMRUSH_TYPE_VALUES = new Set([
  '',
  'semrush_query',
  'semrush_organic_positions',
  'semrush',
])

/**
 * Strips junk models sometimes append to `domain` (e.g. `sim.ai','operation':'domain_organic'…`).
 */
function sanitizeDomainInput(raw: string): string {
  const t = raw.trim()
  if (!t) return t
  const hostMatch = t.match(/^([a-zA-Z0-9](?:[a-zA-Z0-9-]*\.)+[a-zA-Z]{2,})/)
  if (hostMatch && hostMatch[1].length < t.length) {
    logger.warn('Semrush: Stripped junk from domain param', { raw: t, domain: hostMatch[1] })
    return hostMatch[1]
  }
  return t
}

function isValidSemrushApiType(value: string): boolean {
  const v = value.trim().toLowerCase()
  if (!v || v.length > 80) return false
  if (INVALID_SEMRUSH_TYPE_VALUES.has(v)) return false
  return /^[a-z][a-z0-9_]*$/.test(v)
}

/**
 * Resolves Semrush `type` for the request. `reportType` and `operation` are both accepted;
 * coerces when the model sends this tool's id (`semrush_query`) instead of a report type.
 */
function resolveSemrushApiType(params: SemrushParams): string {
  const raw = String(params.reportType ?? params.operation ?? '').trim()
  if (isValidSemrushApiType(raw)) {
    return raw.trim().toLowerCase()
  }

  if (raw) {
    logger.warn('Semrush: Invalid report type; inferring from domain/url', { operation: raw })
  }

  const domain = sanitizeDomainInput(String(params.domain ?? '').trim())
  const url = String(params.url ?? '').trim()

  if (domain && !url) return 'domain_organic'
  if (url && !domain) return 'url_organic'
  if (domain && url) return 'domain_organic'
  return 'domain_organic'
}

export const semrushQueryTool: ToolConfig<SemrushParams, SemrushQueryResponse> = {
  id: 'semrush_query',
  name: 'Semrush Query',
  description:
    'Query Semrush SEO data API for keywords, backlinks, domain rank, and more. Requires a Semrush API key configured on the block.',
  version: '1.0.0',

  hosting: semrushHosting as unknown as ToolHostingConfig<SemrushParams>,

  params: {
    apiKey: {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description: 'Semrush API key',
    },
    url: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'For URL-based report types (operation starting with url_, e.g. url_organic): full page URL to analyze. If empty, a root domain from `domain` (e.g. facebook.com) is normalized to https://… for the same report.',
    },
    domain: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'For domain-based report types (e.g. domain_organic, domain_rank): root domain (e.g. example.com). For URL-based reports, may be used as a fallback when `url` is empty (hostname only).',
    },
    database: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Geographic database code (us, uk, ca, etc.)',
    },
    displayLimit: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Number of results to return (default 10)',
    },
    exportColumns: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Comma-separated column codes to export (e.g., Ph,Nq,Cp)',
    },
    additionalParams: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Additional Semrush API parameters as URL query string',
    },
    operation: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Semrush Analytics report `type` (e.g. domain_organic, url_organic, domain_rank). Must NOT be "semrush_query" — that is this tool\'s id, not a Semrush API type.',
    },
  },

  request: {
    url: (params: SemrushParams) => {
      const queryParams = new URLSearchParams()
      const reportType = resolveSemrushApiType(params)

      const rawFromFields = reportType.startsWith('url_') ? params.url : params.domain
      const rawTarget = (rawFromFields ?? params.target ?? '').trim()
      const target = normalizeSemrushTarget(rawTarget, reportType)

      if (!target) {
        logger.error('Semrush: Missing or empty URL or domain for report type', {
          reportType,
          hasUrl: Boolean(params.url),
          hasDomain: Boolean(params.domain),
          hasLegacyTarget: Boolean(params.target),
        })
        throw new Error(
          'Semrush requires a valid URL or domain. For "Get Domain Organic Keywords" use a domain (e.g. apple.com) or paste a full URL; for "Get Organic Keywords for URL" use a full page URL.'
        )
      }

      queryParams.append('type', reportType)
      if (reportType.startsWith('url_')) {
        queryParams.append('url', target)
      } else {
        queryParams.append('domain', target)
      }

      const database = params.database || 'us'
      queryParams.append('database', database)
      if (params.displayLimit) {
        queryParams.append('display_limit', String(params.displayLimit))
      }
      if (params.exportColumns) {
        queryParams.append('export_columns', params.exportColumns)
      }
      if (params.additionalParams) {
        try {
          queryParams.append('additionalParams', params.additionalParams)
        } catch (error) {
          logger.warn('Failed to set additionalParams', {
            error,
            additionalParams: params.additionalParams,
          })
        }
      }

      queryParams.append('apiKey', params.apiKey)
      const path = `/api/tools/semrush/query?${queryParams.toString()}`
      logger.info('Semrush: Using internal proxy', {
        reportType,
        param: reportType.startsWith('url_') ? 'url' : 'domain',
      })
      return path
    },
    method: 'GET',
    headers: (params) => ({
      Accept: 'text/plain, text/csv, */*',
      'Content-Type': 'text/plain',
      ...(params.apiKey ? { 'X-Semrush-Api-Key': params.apiKey } : {}),
    }),
  },

  transformResponse: async (response: Response, params?: SemrushParams) => {
    if (!response.ok) {
      const errorText = await response.text()
      logger.error('Semrush API error', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      })
      throw new Error(`Semrush API error: ${response.status} ${response.statusText} - ${errorText}`)
    }

    /** Semrush returns CSV (text/plain); `text()` may fail if the body was already consumed. */
    let csvText: string
    try {
      csvText = await response.text()
    } catch (error) {
      // If text() fails (body already consumed), try json() and stringify it
      // This handles the case where tools/index.ts already parsed it as JSON
      try {
        const jsonData = await response.json()
        // If we got JSON, it might be an error response or the body was stringified
        if (typeof jsonData === 'string') {
          csvText = jsonData
        } else {
          // If it's an object, try to reconstruct or throw error
          throw new Error('Unexpected JSON response from Semrush API. Expected CSV text.')
        }
      } catch (jsonError) {
        logger.error('Failed to read Semrush response as text or JSON', {
          contentType: response.headers.get('content-type') || '',
          error: error instanceof Error ? error.message : String(error),
          jsonError: jsonError instanceof Error ? jsonError.message : String(jsonError),
        })
        throw new Error(
          'Failed to read Semrush API response. Expected CSV text but received invalid format.'
        )
      }
    }

    const trimmedBody = csvText.trim()
    if (
      trimmedBody.length > 0 &&
      trimmedBody.length < 200 &&
      !trimmedBody.includes(';') &&
      (trimmedBody.toLowerCase().startsWith('error') ||
        trimmedBody.toLowerCase().includes('invalid') ||
        /^[A-Za-z\s\-:]+$/.test(trimmedBody))
    ) {
      logger.error('Semrush API returned error message as body', { body: trimmedBody })
      throw new Error(
        `Semrush API error: ${trimmedBody}. For domain reports use a root domain (e.g. apple.com). For URL reports use a full page URL.`
      )
    }

    let typeFromUrl: string | null = null
    if (response.url.trim()) {
      try {
        const type = new URL(response.url).searchParams.get('type')
        if (type && isValidSemrushApiType(type)) {
          typeFromUrl = type.trim().toLowerCase()
        }
      } catch {}
    }

    const reportType =
      (params ? resolveSemrushApiType(params) : null) || typeFromUrl || 'domain_organic'

    // Parse CSV using generic parser (Semrush uses semicolon delimiter)
    const parseResult = parseCsvResponse(csvText, {
      delimiter: ';', // Semrush API returns semicolon-delimited CSV
      header: true,
      skipEmptyLines: true,
      trimHeaders: true,
      trimValues: true,
    })

    logger.info('Semrush API response parsed', {
      reportType,
      columns: parseResult.headers.length,
      rows: parseResult.totalRows,
      hasErrors: parseResult.errors.length > 0,
    })

    // Type assertion: when header: true, data is Array<Record<string, string>>
    const data = parseResult.data as Array<Record<string, string>>

    return {
      success: true,
      output: {
        reportType,
        data,
        columns: parseResult.headers,
        totalRows: parseResult.totalRows,
        rawCsv: csvText,
      },
    }
  },

  outputs: {
    reportType: {
      type: 'string',
      description: 'Semrush report type that was requested (e.g. domain_organic, url_organic)',
    },
    data: {
      type: 'json',
      description: 'Parsed Semrush data as JSON array of objects (one object per row)',
    },
    columns: {
      type: 'json',
      description: 'Column headers from the CSV response',
    },
    totalRows: {
      type: 'number',
      description: 'Total number of data rows returned',
    },
    rawCsv: {
      type: 'string',
      description: 'Raw CSV response from the Semrush API (semicolon-delimited)',
    },
  },
}
