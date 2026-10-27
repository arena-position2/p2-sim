/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeBlockReferencesInInputs,
  normalizeBlockReferencesInString,
} from './reference-normalization'

const AGENT_BLOCK_ID = 'bd80a5a8-ef94-43ef-afcf-f6daa926495f'

describe('normalizeBlockReferencesInString', () => {
  const idToName = new Map([[AGENT_BLOCK_ID, 'gpt4oagent']])

  it('rewrites UUID block references to normalized block names', () => {
    expect(normalizeBlockReferencesInString(`<${AGENT_BLOCK_ID}.content>`, idToName)).toBe(
      '<gpt4oagent.content>'
    )
  })

  it('leaves name-based references unchanged', () => {
    expect(normalizeBlockReferencesInString('<gpt4oagent.content>', idToName)).toBe(
      '<gpt4oagent.content>'
    )
  })

  it('leaves special loop/parallel/variable references unchanged', () => {
    expect(normalizeBlockReferencesInString('<loop.index>', idToName)).toBe('<loop.index>')
    expect(normalizeBlockReferencesInString('<variable.myvar>', idToName)).toBe('<variable.myvar>')
  })

  it('rewrites references embedded in longer strings', () => {
    expect(
      normalizeBlockReferencesInString(
        `Subject line\n\n<${AGENT_BLOCK_ID}.content>\n\nThanks`,
        idToName
      )
    ).toBe('Subject line\n\n<gpt4oagent.content>\n\nThanks')
  })
})

describe('normalizeBlockReferencesInInputs', () => {
  it('normalizes nested input objects and arrays', () => {
    const blocks = {
      [AGENT_BLOCK_ID]: { name: 'GPT-4o Agent', type: 'agent' },
    }

    const normalized = normalizeBlockReferencesInInputs(
      {
        body: `<${AGENT_BLOCK_ID}.content>`,
        rows: [{ value: `<${AGENT_BLOCK_ID}.content>` }],
      },
      blocks
    )

    expect(normalized).toEqual({
      body: '<gpt-4oagent.content>',
      rows: [{ value: '<gpt-4oagent.content>' }],
    })
  })
})
