import { createLogger } from '@sim/logger'
import { env } from '@/lib/core/config/env'

const logger = createLogger('ContentRerank')

/**
 * Configuration for content reranking
 */
export interface RerankConfig {
  enabled?: boolean
  model?: string
  topN?: number
  requestId?: string
  maxContentLength?: number
  maxCandidates?: number
}

/**
 * Generic interface for items that can be reranked
 * Items must have a way to extract content for reranking
 */
export interface RerankableItem {
  [key: string]: unknown
}

/**
 * Function to extract content from a rerankable item
 */
export type ContentExtractor<T extends RerankableItem> = (item: T) => string | null | undefined

/**
 * Generic function to rerank a list of content items based on a prompt using Cohere rerank API.
 * This is a generic version of rerankSearchResults that works with any content structure.
 *
 * @param query - The search query or prompt to rank content against
 * @param items - Array of items to rerank (can be any structure with extractable content)
 * @param extractContent - Function to extract content string from each item
 * @param rerankConfig - Optional configuration for reranking
 * @returns Array of reranked items, sorted by relevance
 *
 * @example
 * ```typescript
 * // For Google Drive files
 * const rerankedFiles = await rerankContent(
 *   "find information about Q4 strategy",
 *   googleDriveFiles,
 *   (file) => file.content,
 *   { topN: 5 }
 * )
 *
 * // For custom content structure
 * const rerankedItems = await rerankContent(
 *   "user query",
 *   myItems,
 *   (item) => item.text || item.description,
 *   { enabled: true, topN: 10 }
 * )
 * ```
 */
export async function rerankContent<T extends RerankableItem>(
  query: string,
  items: T[],
  extractContent: ContentExtractor<T>,
  rerankConfig?: RerankConfig
): Promise<T[]> {
  const rerankEnabled = rerankConfig?.enabled ?? true

  if (!rerankEnabled) {
    return items
  }

  if (!query?.trim() || items.length === 0) {
    return items
  }

  const apiKey = env.COHERE_API_KEY || 'FtSOTZsLWqFsfgvPlZC2UawkIiTP9kYaH2bvU0BD'

  if (!apiKey) {
    logger.warn('Skipping rerank because COHERE_API_KEY is not configured', {
      requestId: rerankConfig?.requestId,
    })
    return items
  }

  const model = rerankConfig?.model || 'rerank-v4.0-pro'
  const maxCandidates = rerankConfig?.maxCandidates ?? 100
  const candidateCount = Math.min(items.length, maxCandidates)
  const topN = Math.min(rerankConfig?.topN ?? items.length, candidateCount)
  const maxContentLength = rerankConfig?.maxContentLength ?? 4000

  const candidates = items.slice(0, candidateCount)

  // Filter out items with no content
  const validCandidates: T[] = []
  const validDocuments: string[] = []
  const candidateIndexMap = new Map<number, number>()

  candidates.forEach((candidate, originalIndex) => {
    const content = extractContent(candidate)
    if (content && content.trim().length > 0) {
      const newIndex = validCandidates.length
      candidateIndexMap.set(newIndex, originalIndex)
      validCandidates.push(candidate)
      validDocuments.push(content.slice(0, maxContentLength))
    }
  })

  if (validCandidates.length === 0) {
    logger.debug('No items with valid content to rerank', { requestId: rerankConfig?.requestId })
    return []
  }

  try {
    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        query,
        documents: validDocuments,
        top_n: Math.min(topN, validDocuments.length),
      }),
    })

    if (!response.ok) {
      logger.warn('Rerank API request failed', {
        status: response.status,
        statusText: response.statusText,
        requestId: rerankConfig?.requestId,
      })
      return items
    }

    const data = await response.json()
    const rerankedItems: any[] = Array.isArray(data?.results) ? data.results : []

    if (!Array.isArray(rerankedItems) || rerankedItems.length === 0) {
      logger.warn('Rerank API returned no data', { requestId: rerankConfig?.requestId })
      return items
    }

    // Sort by relevance_score (descending) and filter valid scores
    const sortedRerankedItems = rerankedItems
      .filter((item: any) => typeof item.relevance_score === 'number')
      .sort((a: any, b: any) => b.relevance_score - a.relevance_score)
      .slice(0, topN)

    if (sortedRerankedItems.length === 0) {
      logger.debug('No results with valid relevance_score', { requestId: rerankConfig?.requestId })
      return []
    }

    // Extract indices from sorted results
    const validIndices = new Set<number>()
    sortedRerankedItems.forEach((item: any) => {
      const candidateIndex = typeof item.index === 'number' ? item.index : -1
      if (candidateIndex >= 0 && candidateIndex < validCandidates.length) {
        validIndices.add(candidateIndex)
      }
    })

    if (validIndices.size === 0) {
      return []
    }

    // Create score map for sorting
    const scoreMap = new Map<number, number>()
    sortedRerankedItems.forEach((item: any) => {
      const candidateIndex = typeof item.index === 'number' ? item.index : -1
      if (candidateIndex >= 0 && candidateIndex < validCandidates.length) {
        const relevanceScore = typeof item.relevance_score === 'number' ? item.relevance_score : 0
        scoreMap.set(candidateIndex, relevanceScore)
      }
    })

    // Filter candidates to only include those at valid indices and sort by relevance score
    const rerankedResults = validCandidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => validIndices.has(index))
      .sort((a, b) => {
        const scoreB = scoreMap.get(b.index) ?? Number.NEGATIVE_INFINITY
        const scoreA = scoreMap.get(a.index) ?? Number.NEGATIVE_INFINITY
        return scoreB - scoreA
      })
      .map(({ candidate }) => candidate)

    return rerankedResults.slice(0, topN)
  } catch (error) {
    logger.warn('Failed to rerank content', {
      error: error instanceof Error ? error.message : 'Unknown error',
      requestId: rerankConfig?.requestId,
    })
    return items
  }
}
