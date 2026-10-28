/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetBlock } = vi.hoisted(() => ({
  mockGetBlock: vi.fn(),
}))

vi.mock('@/blocks/registry', () => ({
  getBlock: mockGetBlock,
}))

import {
  coerceDropdownValue,
  coerceLocalEditDropdownInputs,
} from '@/local-copilot/lib/tools/coerce-edit-dropdown-inputs'

const GMAIL_OPERATION_IDS = [
  'send_gmail',
  'read_gmail',
  'search_gmail',
  'advanced_search_gmail',
  'draft_gmail',
] as const

describe('coerceDropdownValue', () => {
  it('returns null when the value already matches an option id', () => {
    expect(coerceDropdownValue('search_gmail', GMAIL_OPERATION_IDS)).toBeNull()
  })

  it('resolves a unique prefix alias (search → search_gmail)', () => {
    expect(coerceDropdownValue('search', GMAIL_OPERATION_IDS)).toBe('search_gmail')
  })

  it('resolves case-insensitive exact matches', () => {
    expect(coerceDropdownValue('Search_Gmail', GMAIL_OPERATION_IDS)).toBe('search_gmail')
  })

  it('does not guess when multiple options share a prefix', () => {
    expect(coerceDropdownValue('search', ['search_gmail', 'search_mail', 'send_gmail'])).toBeNull()
  })

  it('resolves a unique suffix alias', () => {
    expect(coerceDropdownValue('gmail', ['search_gmail'])).toBe('search_gmail')
  })

  it('returns null for empty or unmatched values', () => {
    expect(coerceDropdownValue('', GMAIL_OPERATION_IDS)).toBeNull()
    expect(coerceDropdownValue('delete_all', GMAIL_OPERATION_IDS)).toBeNull()
  })
})

describe('coerceLocalEditDropdownInputs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBlock.mockReturnValue(undefined)
  })

  it('rewrites short gmail operation ids using metadata options', () => {
    const metadata = new Map<string, unknown>([
      [
        'gmail_v2',
        {
          inputs: {
            required: [
              {
                name: 'operation',
                options: [...GMAIL_OPERATION_IDS],
              },
            ],
            optional: [],
          },
        },
      ],
    ])

    const operations = [
      {
        block_id: 'fetch_mail',
        operation_type: 'add',
        params: {
          type: 'gmail_v2',
          name: 'Fetch Unread',
          inputs: { operation: 'search', query: 'is:unread' },
        },
      },
    ]

    const coerced = coerceLocalEditDropdownInputs(operations, {
      blocksMetadataByType: metadata,
    })

    expect(coerced).not.toBe(operations)
    const params = (coerced[0] as { params: { inputs: Record<string, unknown> } }).params
    expect(params.inputs.operation).toBe('search_gmail')
    expect(params.inputs.query).toBe('is:unread')
  })

  it('falls back to the live block registry when metadata is missing', () => {
    mockGetBlock.mockReturnValue({
      subBlocks: [
        {
          id: 'operation',
          type: 'dropdown',
          options: GMAIL_OPERATION_IDS.map((id) => ({ id, label: id })),
        },
      ],
    })

    const operations = [
      {
        block_id: 'fetch_mail',
        operation_type: 'add',
        params: {
          type: 'gmail_v2',
          name: 'Fetch Unread',
          inputs: { operation: 'search' },
        },
      },
    ]

    const coerced = coerceLocalEditDropdownInputs(operations)
    const params = (coerced[0] as { params: { inputs: Record<string, unknown> } }).params
    expect(params.inputs.operation).toBe('search_gmail')
    expect(mockGetBlock).toHaveBeenCalledWith('gmail_v2')
  })

  it('leaves already-valid and non-dropdown values untouched', () => {
    const operations = [
      {
        block_id: 'fetch_mail',
        operation_type: 'add',
        params: {
          type: 'gmail_v2',
          inputs: { operation: 'search_gmail', query: 'is:unread' },
        },
      },
    ]

    expect(
      coerceLocalEditDropdownInputs(operations, {
        blocksMetadataByType: new Map([
          [
            'gmail_v2',
            {
              inputs: {
                required: [{ name: 'operation', options: [...GMAIL_OPERATION_IDS] }],
                optional: [],
              },
            },
          ],
        ]),
      })
    ).toBe(operations)
  })

  it('uses existing block type when edit ops omit params.type', () => {
    const operations = [
      {
        block_id: 'existing-gmail',
        operation_type: 'edit',
        params: {
          inputs: { operation: 'search' },
        },
      },
    ]

    const coerced = coerceLocalEditDropdownInputs(operations, {
      existingBlocks: { 'existing-gmail': { type: 'gmail_v2' } },
      blocksMetadataByType: new Map([
        [
          'gmail_v2',
          {
            inputs: {
              required: [{ name: 'operation', options: [...GMAIL_OPERATION_IDS] }],
              optional: [],
            },
          },
        ],
      ]),
    })

    const params = (coerced[0] as { params: { inputs: Record<string, unknown> } }).params
    expect(params.inputs.operation).toBe('search_gmail')
  })
})
