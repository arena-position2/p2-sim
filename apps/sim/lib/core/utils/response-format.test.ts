import { describe, expect, it } from 'vitest'
import { extractFieldsFromSchema, traverseObjectPath } from '@/lib/core/utils/response-format'
import {
  LARGE_ARRAY_MANIFEST_VERSION,
  type LargeArrayManifest,
} from '@/lib/execution/payloads/large-array-manifest-metadata'

function createManifest(totalCount = 100_000): LargeArrayManifest {
  return {
    __simLargeArrayManifest: true,
    version: LARGE_ARRAY_MANIFEST_VERSION,
    kind: 'array',
    totalCount,
    chunkCount: 1,
    byteSize: 12 * 1024 * 1024,
    chunks: [
      {
        count: totalCount,
        byteSize: 12 * 1024 * 1024,
        ref: {
          __simLargeValueRef: true,
          version: 1,
          id: 'lv_ABCDEFGHIJKL',
          kind: 'array',
          size: 12 * 1024 * 1024,
          executionId: 'execution-1',
        },
      },
    ],
    preview: [{ key: 'SIM-0' }],
  }
}

describe('extractFieldsFromSchema', () => {
  it('filters null and undefined entries from legacy fields arrays', () => {
    const fields = extractFieldsFromSchema({
      fields: [
        { name: 'score', type: 'number', description: 'A score' },
        null,
        undefined,
        { name: '', type: 'string' },
        { name: '  ', type: 'string' },
        { type: 'string' },
        { name: 'comment', type: 'string' },
      ],
    })

    expect(fields).toEqual([
      { name: 'score', type: 'number', description: 'A score' },
      { name: 'comment', type: 'string', description: undefined },
    ])
  })

  it('extracts fields from JSON Schema properties', () => {
    const fields = extractFieldsFromSchema({
      schema: {
        type: 'object',
        properties: {
          min: { type: 'number' },
          max: { type: 'number', description: 'Upper bound' },
        },
      },
    })

    expect(fields).toEqual([
      { name: 'min', type: 'number', description: undefined },
      { name: 'max', type: 'number', description: 'Upper bound' },
    ])
  })
})

describe('response format traversal', () => {
  it('returns whole large array manifest metadata without materializing chunks', () => {
    const manifest = createManifest()

    expect(traverseObjectPath({ output: { rows: manifest } }, 'output.rows')).toEqual(manifest)
  })

  it('returns manifest totalCount for length selections', () => {
    const manifest = createManifest()

    expect(traverseObjectPath({ output: { rows: manifest } }, 'output.rows.length')).toBe(100_000)
  })

  it('does not perform indexed manifest reads in sync traversal', () => {
    const manifest = createManifest()

    expect(traverseObjectPath({ output: { rows: manifest } }, 'output.rows.0.key')).toBeUndefined()
  })
})
