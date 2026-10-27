/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  formatMissingBlockSuggestionReason,
  suggestBlocksForMissingId,
  tokenizeMissingBlockId,
} from '@/lib/workflows/editing/block-id-suggestions'

describe('tokenizeMissingBlockId', () => {
  it('drops digit-only segments', () => {
    expect(tokenizeMissingBlockId('schedule-trigger-1')).toEqual(['schedule', 'trigger'])
  })
})

describe('suggestBlocksForMissingId', () => {
  const blocks = {
    'd14cbc80-b078-444b-997e-7617bbedd298': { type: 'start_trigger', name: 'Start' },
    '48ddd46d-7f95-46ac-be50-faacb8bae6f5': { type: 'schedule', name: 'Schedule' },
    'd3647959-e47b-4c3f-b87f-9ecc9bb230e9': { type: 'function', name: 'Fetch services' },
  }

  it('prefers an exact type match for schedule-trigger-1 over start_trigger', () => {
    const suggestions = suggestBlocksForMissingId('schedule-trigger-1', blocks)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toEqual({
      blockId: '48ddd46d-7f95-46ac-be50-faacb8bae6f5',
      blockName: 'Schedule',
      blockType: 'schedule',
    })
  })

  it('returns empty when nothing matches', () => {
    expect(suggestBlocksForMissingId('totally-made-up-id', blocks)).toEqual([])
  })
})

describe('formatMissingBlockSuggestionReason', () => {
  it('includes the real block id when there is a single suggestion', () => {
    const reason = formatMissingBlockSuggestionReason(
      'schedule-trigger-1',
      [
        {
          blockId: '48ddd46d-7f95-46ac-be50-faacb8bae6f5',
          blockName: 'Schedule',
          blockType: 'schedule',
        },
      ],
      'deleted'
    )
    expect(reason).toContain('48ddd46d-7f95-46ac-be50-faacb8bae6f5')
    expect(reason).toMatch(/do not invent ids/i)
  })
})
