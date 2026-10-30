import { describe, expect, it } from 'vitest'
import {
  coerceAgentToolEntry,
  coerceLocalEditAgentTools,
} from '@/local-copilot/lib/tools/coerce-edit-agent-tools'

describe('coerceAgentToolEntry', () => {
  it.concurrent('strips identity fields that authoring rejects on new attachments', () => {
    expect(
      coerceAgentToolEntry({
        type: 'image_generator_v2',
        title: 'Image Generator',
        toolId: 'image_generate',
        name: 'Image',
        functionName: 'gen',
        usageControl: 'auto',
        params: { inputImage: '<start.files>' },
      })
    ).toEqual({
      type: 'image_generator_v2',
      usageControl: 'auto',
      params: { inputImage: '<start.files>' },
    })
  })

  it.concurrent('rewrites knowledge_base alias and nests knowledgeBaseId under params', () => {
    expect(
      coerceAgentToolEntry({
        type: 'knowledge_base',
        title: 'KB',
        toolId: 'knowledge_search',
        knowledgeBaseId: 'kb-1',
        usageControl: 'auto',
      })
    ).toEqual({
      type: 'knowledge',
      operation: 'search',
      usageControl: 'auto',
      params: { knowledgeBaseId: 'kb-1' },
    })
  })

  it.concurrent('defaults knowledge operation to search and keeps existing params', () => {
    expect(
      coerceAgentToolEntry({
        type: 'knowledge',
        params: { knowledgeBaseId: 'kb-2', topK: '5' },
      })
    ).toEqual({
      type: 'knowledge',
      operation: 'search',
      params: { knowledgeBaseId: 'kb-2', topK: '5' },
    })
  })
})

describe('coerceLocalEditAgentTools', () => {
  it.concurrent('rewrites Agent tools on edit operations', () => {
    const operations = coerceLocalEditAgentTools([
      {
        block_id: 'agent-1',
        operation_type: 'edit',
        params: {
          inputs: {
            tools: [
              {
                type: 'knowledge_base',
                title: 'All Personas',
                knowledgeBaseId: '9e17bfcf-6e6d-40b1-bed3-915f4f812c3a',
                usageControl: 'auto',
              },
            ],
          },
        },
      },
    ])

    const op = operations[0] as {
      params: { inputs: { tools: Array<Record<string, unknown>> } }
    }
    expect(op.params.inputs.tools).toEqual([
      {
        type: 'knowledge',
        operation: 'search',
        usageControl: 'auto',
        params: { knowledgeBaseId: '9e17bfcf-6e6d-40b1-bed3-915f4f812c3a' },
      },
    ])
  })

  it.concurrent('leaves non-tool operations unchanged', () => {
    const operations = [
      {
        block_id: 'start-1',
        operation_type: 'edit',
        params: { connections: { source: 'agent-1' } },
      },
    ]
    expect(coerceLocalEditAgentTools(operations)).toBe(operations)
  })
})
