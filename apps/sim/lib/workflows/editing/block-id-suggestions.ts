/**
 * Suggests existing workflow blocks when an edit/delete targets a missing id
 * (common when the model invents ids like `schedule-trigger-1`).
 */

export interface BlockIdSuggestion {
  blockId: string
  blockName: string
  blockType: string
}

interface SuggestableBlock {
  type?: string
  name?: string
}

/**
 * Tokenizes a hallucinated or stale block id into lowercase alphanumeric parts.
 * Digits-only tokens are dropped so trailing `-1` does not match everything.
 */
export function tokenizeMissingBlockId(missingId: string): string[] {
  return missingId
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !/^\d+$/.test(token))
}

/**
 * Ranks live blocks against a missing id. Prefers an exact type match for a
 * token (e.g. `schedule` from `schedule-trigger-1`) over substring hits like
 * `start_trigger` matching `trigger`.
 */
export function suggestBlocksForMissingId(
  missingId: string,
  blocks: Record<string, SuggestableBlock>
): BlockIdSuggestion[] {
  const trimmed = missingId.trim()
  if (!trimmed) return []

  const tokens = tokenizeMissingBlockId(trimmed)
  if (tokens.length === 0) return []

  const scored: Array<BlockIdSuggestion & { score: number }> = []
  for (const [blockId, block] of Object.entries(blocks)) {
    const blockType = typeof block.type === 'string' ? block.type : ''
    const blockName = typeof block.name === 'string' ? block.name : ''
    if (!blockType && !blockName) continue

    const typeLower = blockType.toLowerCase()
    const nameLower = blockName.toLowerCase()
    let score = 0

    for (const token of tokens) {
      if (typeLower === token) score += 10
      else if (typeLower.includes(token)) score += 3
      if (nameLower === token) score += 6
      else if (nameLower.includes(token)) score += 2
    }

    if (score > 0) {
      scored.push({
        blockId,
        blockName: blockName || blockId,
        blockType: blockType || 'unknown',
        score,
      })
    }
  }

  if (scored.length === 0) return []

  const exactTypeMatches = scored.filter((candidate) =>
    tokens.includes(candidate.blockType.toLowerCase())
  )
  const pool = exactTypeMatches.length > 0 ? exactTypeMatches : scored
  return [...pool]
    .sort((a, b) => b.score - a.score || a.blockName.localeCompare(b.blockName))
    .slice(0, 3)
    .map(({ blockId, blockName, blockType }) => ({ blockId, blockName, blockType }))
}

/**
 * Formats suggestions into a reason the model can act on.
 */
export function formatMissingBlockSuggestionReason(
  missingId: string,
  suggestions: BlockIdSuggestion[],
  operationVerb: 'deleted' | 'edited' = 'deleted'
): string {
  const base = `Block "${missingId}" does not exist and cannot be ${operationVerb}`
  if (suggestions.length === 0) return base
  if (suggestions.length === 1) {
    const only = suggestions[0]
    return `${base}. Did you mean block_id="${only.blockId}" (name "${only.blockName}", type ${only.blockType})? Use that real id — do not invent ids like "${missingId}".`
  }
  const listed = suggestions
    .map((item) => `block_id="${item.blockId}" (${item.blockName}, type ${item.blockType})`)
    .join('; ')
  return `${base}. Candidates: ${listed}. Pick the correct real id — do not invent ids like "${missingId}".`
}
