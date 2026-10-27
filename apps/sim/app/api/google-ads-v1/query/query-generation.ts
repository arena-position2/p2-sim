/**
 * GAQL query generation using AI
 */

import { createLogger } from '@sim/logger'
import { extractProviderToolCostFields } from '@/lib/billing/core/tool-llm-cost'
import { executeProviderRequest } from '@/providers'
import { resolveAIProvider } from './ai-provider'
import { DEFAULT_DATE_RANGE_DAYS } from './constants'
import { getGaqlSystemPrompt } from './prompt'
import type { GAQLResponse } from './types'

const logger = createLogger('GoogleAdsV1QueryGen')

/**
 * Extracts date range from GAQL query
 *
 * @param query - GAQL query string
 * @returns Date range with start and end dates, or null if not found
 */
export function extractDateRange(query: string): {
  startDate: string
  endDate: string
} | null {
  // Match segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'
  const datePattern =
    /segments\.date\s+BETWEEN\s+'(\d{4}-\d{2}-\d{2})'\s+AND\s+'(\d{4}-\d{2}-\d{2})'/i
  const match = query.match(datePattern)

  if (match?.[1] && match[2]) {
    return {
      startDate: match[1],
      endDate: match[2],
    }
  }

  return null
}

/**
 * Adds default date filter to GAQL query if missing
 *
 * @param query - GAQL query string
 * @returns Query with date filter added
 */
function addDefaultDateFilter(query: string): {
  query: string
  startDate: string
  endDate: string
} {
  // Calculate last 30 days ending yesterday
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  const thirtyDaysAgo = new Date(yesterday)
  thirtyDaysAgo.setDate(yesterday.getDate() - (DEFAULT_DATE_RANGE_DAYS - 1))

  const endDate = yesterday.toISOString().split('T')[0]
  const startDate = thirtyDaysAgo.toISOString().split('T')[0]
  const defaultDateFilter = `segments.date BETWEEN '${startDate}' AND '${endDate}'`

  let updatedQuery = query

  // Add default date filter to WHERE clause
  if (query.includes('WHERE')) {
    // Insert after WHERE
    updatedQuery = query.replace(/WHERE\s+/i, `WHERE ${defaultDateFilter} AND `)
  } else if (query.includes('FROM')) {
    // Add WHERE clause if missing
    const orderByIndex = query.toUpperCase().indexOf('ORDER BY')
    const insertPosition = orderByIndex > -1 ? orderByIndex : query.length

    const beforeOrderBy = query.substring(0, insertPosition).trim()
    const afterOrderBy = orderByIndex > -1 ? query.substring(orderByIndex) : ''

    updatedQuery = `${beforeOrderBy} WHERE ${defaultDateFilter} ${afterOrderBy}`
  }

  return { query: updatedQuery, startDate, endDate }
}

/**
 * Parses AI response and extracts GAQL query
 *
 * @param aiResponse - Response from AI provider
 * @returns Parsed GAQL response
 * @throws Error if response is invalid
 */
function parseAIResponse(aiResponse: any): GAQLResponse {
  // Extract content from AI response
  const responseContent =
    typeof aiResponse === 'string'
      ? aiResponse
      : 'content' in aiResponse
        ? aiResponse.content
        : JSON.stringify(aiResponse)

  // Try to extract JSON from response
  const jsonMatch = responseContent.match(/\{[\s\S]*\}/)
  const parsed: GAQLResponse = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseContent)

  if (!parsed.gaql_query) {
    throw new Error('AI did not return a GAQL query')
  }

  return parsed
}

/**
 * Resources that reject segments.date. Injecting a default segments.date
 * filter into these queries causes GoogleAdsFailure
 * PROHIBITED_SEGMENT_IN_SELECT_OR_WHERE_CLAUSE.
 */
function shouldSkipSegmentsDateInjection(gaqlQuery: string): boolean {
  const query = gaqlQuery.toLowerCase()
  return (
    /\bfrom\s+change_event\b/.test(query) ||
    query.includes('change_event.change_date_time') ||
    /\bfrom\s+campaign_budget\b/.test(query) ||
    query.includes('url_custom_parameters')
  )
}

/**
 * Validates and fixes GAQL query date filtering
 *
 * @param response - Parsed GAQL response
 * @returns Response with validated/fixed date filtering
 */
function validateDateFiltering(response: GAQLResponse): GAQLResponse {
  const hasDateFilter =
    response.gaql_query.includes('segments.date') && response.gaql_query.includes('BETWEEN')

  if (hasDateFilter) {
    return response
  }

  // change_event / campaign_budget / UTM queries must not get segments.date
  if (shouldSkipSegmentsDateInjection(response.gaql_query)) {
    logger.info('Skipping default segments.date injection for non-performance GAQL resource', {
      originalQuery: response.gaql_query,
    })
    return response
  }

  logger.warn('Query missing BETWEEN date filter, adding default last 30 days ending yesterday', {
    originalQuery: response.gaql_query,
  })

  const { query, startDate, endDate } = addDefaultDateFilter(response.gaql_query)

  logger.info('Updated query with default BETWEEN date filter (last 30 days ending yesterday)', {
    updatedQuery: query,
    startDate,
    endDate,
  })

  return {
    ...response,
    gaql_query: query,
  }
}

/**
 * Generates GAQL query using AI
 *
 * This function:
 * - Resolves the appropriate AI provider (Grok or GPT-4o)
 * - Sends the user prompt to the AI with the GAQL system prompt
 * - Parses and validates the response
 * - Ensures proper date filtering is present
 *
 * @param userPrompt - Natural language query from user
 * @returns GAQL query response with metadata
 * @throws Error if generation fails
 */
export async function generateGAQLQuery(userPrompt: string): Promise<GAQLResponse> {
  try {
    const { provider, model, apiKey } = resolveAIProvider(logger)

    logger.info('Generating GAQL query', {
      provider,
      model,
      userPrompt,
    })

    const systemPrompt = await getGaqlSystemPrompt()

    const aiResponse = await executeProviderRequest(provider, {
      model,
      systemPrompt,
      context: `Generate GAQL query for: "${userPrompt}"`,
      messages: [
        {
          role: 'user',
          content: `Generate a GAQL query for: "${userPrompt}"`,
        },
      ],
      apiKey,
      temperature: 1,
      maxTokens: 2048,
    })

    logger.info('AI response received')

    // Parse AI response
    const parsed = parseAIResponse(aiResponse)

    // Validate and fix date filtering if needed
    const validated = validateDateFiltering(parsed)
    const billing = extractProviderToolCostFields(aiResponse)

    logger.info('Successfully generated GAQL query', {
      gaql: validated.gaql_query,
      queryType: validated.query_type,
      tables: validated.tables_used,
      hasCost: !!billing?.cost,
    })

    return {
      ...validated,
      ...billing,
    }
  } catch (error) {
    logger.error('GAQL generation failed', { error, userPrompt })
    throw error
  }
}
