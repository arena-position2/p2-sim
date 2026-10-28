/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  collectBlockOutputContracts,
  diffOutputContracts,
  flattenOutputSchema,
  type OutputContractDump,
  type OutputContractRow,
  parseOutputContractDump,
} from '@/scripts/diff-block-output-contracts'

function row(
  overrides: Partial<OutputContractRow> & Pick<OutputContractRow, 'path'>
): OutputContractRow {
  return {
    blockType: 'slack',
    operation: 'send',
    type: 'string',
    source: 'tool',
    hidden: false,
    ...overrides,
  }
}

function dump(rows: OutputContractRow[]): OutputContractDump {
  return { version: 1, rows }
}

describe('flattenOutputSchema', () => {
  it('records nested paths, hidden fields, and file properties', () => {
    const flattened = flattenOutputSchema({
      message: 'string',
      user: {
        name: { type: 'string', hiddenFromDisplay: true },
      },
      attachment: { type: 'file' },
    })

    expect(flattened.get('message')).toEqual({ type: 'string', hidden: false })
    expect(flattened.get('user')).toEqual({ type: 'object', hidden: false })
    expect(flattened.get('user.name')).toEqual({ type: 'string', hidden: true })
    expect(flattened.get('attachment')).toEqual({ type: 'file', hidden: false })
    expect(flattened.get('attachment.url')).toEqual({ type: 'string', hidden: false })
    expect(flattened.get('attachment.size')).toEqual({ type: 'number', hidden: false })
  })
})

describe('diffOutputContracts', () => {
  it('reports removed paths, type changes, additions, and rename candidates', () => {
    const before = dump([
      row({ path: 'message' }),
      row({ path: 'user.name' }),
      row({ path: 'files', type: 'file[]' }),
    ])
    const after = dump([
      row({ path: 'account.name' }),
      row({ path: 'files', type: 'json' }),
      row({ path: 'permalink' }),
    ])

    const diff = diffOutputContracts(before, after)

    expect(diff.removed.map((entry) => entry.path)).toEqual(['message', 'user.name'])
    expect(diff.typeChanged).toEqual([
      {
        before: row({ path: 'files', type: 'file[]' }),
        after: row({ path: 'files', type: 'json' }),
      },
    ])
    expect(diff.added.map((entry) => entry.path)).toEqual(['account.name', 'permalink'])
    expect(diff.renameCandidates).toEqual([
      {
        removed: row({ path: 'user.name' }),
        added: [row({ path: 'account.name' })],
      },
    ])
  })

  it('ignores a hidden flag change when the path and type stay', () => {
    const diff = diffOutputContracts(
      dump([row({ path: 'message', hidden: false })]),
      dump([row({ path: 'message', hidden: true })])
    )

    expect(diff.removed).toEqual([])
    expect(diff.typeChanged).toEqual([])
    expect(diff.added).toEqual([])
  })

  it('rejects a dump from another version', () => {
    expect(() => parseOutputContractDump({ version: 2, rows: [] })).toThrow(/version 1/)
  })
})

describe('collectBlockOutputContracts', () => {
  it('records each operation from the block and the tool, and each trigger', () => {
    const rows = collectBlockOutputContracts(
      {
        type: 'slack',
        subBlocks: [{ id: 'operation', options: [{ id: 'send' }, { id: 'read' }] }],
        triggers: { enabled: true, available: ['slack_message'] },
      },
      {
        blockOutputs: (_blockType, subBlocks, triggerMode) => {
          if (triggerMode) return { event: 'string' }
          return subBlocks.operation?.value === 'send'
            ? { message: 'string' }
            : { messages: 'array' }
        },
        toolOutputs: (_block, subBlocks) =>
          subBlocks.operation?.value === 'send'
            ? { ts: { type: 'string', hiddenFromDisplay: true } }
            : {},
      }
    )

    expect(rows).toEqual([
      row({ operation: 'read', path: 'messages', type: 'array', source: 'block' }),
      row({ operation: 'send', path: 'message', source: 'block' }),
      row({ operation: 'send', path: 'ts', source: 'tool', hidden: true }),
      row({ operation: 'trigger:slack_message', path: 'event', source: 'trigger' }),
    ])
  })
})
