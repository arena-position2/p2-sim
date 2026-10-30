import { describe, expect, it } from 'vitest'
import {
  ensureStartReservedInputFormatFields,
  ensureStartReservedInputFormatInEditOperations,
} from '@/local-copilot/lib/tools/ensure-start-reserved-input-format'

describe('ensureStartReservedInputFormatFields', () => {
  it.concurrent('seeds input, conversationId, and files when empty', () => {
    const fields = ensureStartReservedInputFormatFields(null)
    expect(fields.map((field) => ({ name: field.name, type: field.type }))).toEqual([
      { name: 'input', type: 'string' },
      { name: 'conversationId', type: 'string' },
      { name: 'files', type: 'file[]' },
    ])
  })

  it.concurrent('prepends missing reserved fields and keeps custom fields', () => {
    const fields = ensureStartReservedInputFormatFields([
      { id: 'custom-1', name: 'recipient_email', type: 'string', value: '', collapsed: false },
      { name: 'input', type: 'string' },
      { name: '', type: 'string' },
    ])
    expect(fields.map((field) => field.name)).toEqual([
      'input',
      'conversationId',
      'files',
      'recipient_email',
    ])
    expect(fields.find((field) => field.name === 'recipient_email')?.id).toBe('custom-1')
  })
})

describe('ensureStartReservedInputFormatInEditOperations', () => {
  it.concurrent('injects reserved inputFormat when editing Start with only connections', () => {
    const operations = ensureStartReservedInputFormatInEditOperations(
      [
        {
          block_id: 'start-1',
          operation_type: 'edit',
          params: { connections: { source: 'agent-1' } },
        },
      ],
      { knownStartBlockIds: ['start-1'] }
    )

    const op = operations[0] as {
      params: { connections: unknown; inputs: { inputFormat: Array<{ name: string }> } }
    }
    expect(op.params.connections).toEqual({ source: 'agent-1' })
    expect(op.params.inputs.inputFormat.map((field) => field.name)).toEqual([
      'input',
      'conversationId',
      'files',
    ])
  })

  it.concurrent('merges reserved fields into Start inputFormat on add', () => {
    const operations = ensureStartReservedInputFormatInEditOperations([
      {
        block_id: 'start-2',
        operation_type: 'add',
        params: {
          type: 'start_trigger',
          name: 'Start',
          inputs: {
            inputFormat: [{ name: 'recipient_email', type: 'string', value: '', collapsed: false }],
          },
        },
      },
    ])

    const op = operations[0] as {
      params: { inputs: { inputFormat: Array<{ name: string }> } }
    }
    expect(op.params.inputs.inputFormat.map((field) => field.name)).toEqual([
      'input',
      'conversationId',
      'files',
      'recipient_email',
    ])
  })

  it.concurrent('injects a Start seed edit when known Start is untouched', () => {
    const operations = ensureStartReservedInputFormatInEditOperations(
      [
        {
          block_id: 'agent-1',
          operation_type: 'add',
          params: { type: 'agent', name: 'Agent' },
        },
      ],
      { knownStartBlockIds: ['start-1'] }
    )

    expect(operations).toHaveLength(2)
    const seed = operations[1] as {
      block_id: string
      operation_type: string
      params: { inputs: { inputFormat: Array<{ name: string }> } }
    }
    expect(seed.block_id).toBe('start-1')
    expect(seed.operation_type).toBe('edit')
    expect(seed.params.inputs.inputFormat.map((field) => field.name)).toEqual([
      'input',
      'conversationId',
      'files',
    ])
  })
})
