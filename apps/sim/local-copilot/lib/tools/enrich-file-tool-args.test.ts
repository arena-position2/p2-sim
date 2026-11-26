/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  enrichCreateFileArgs,
  enrichFunctionExecuteArgs,
} from '@/local-copilot/lib/tools/enrich-file-tool-args'
import { firstFileBodyString } from '@/local-copilot/lib/tools/file-body-args'

describe('Claude-facing create_file content enrichment', () => {
  it('stringifies native object content', () => {
    const args: Record<string, unknown> = {
      fileName: 'files/Product_and_Architecture/Technical_Architecture/samples.json',
      content: { samples: [{ id: 'a' }] },
    }
    enrichCreateFileArgs(args)
    expect(args.content).toBe(JSON.stringify({ samples: [{ id: 'a' }] }, null, 2))
  })

  it('lifts object bodies from common aliases', () => {
    expect(firstFileBodyString({ body: { hello: 'world' } })).toBe(
      JSON.stringify({ hello: 'world' }, null, 2)
    )
  })
})

describe('enrichFunctionExecuteArgs', () => {
  it('parses stringified inputs/outputs objects (audit stringification failure)', () => {
    const args: Record<string, unknown> = {
      language: 'python',
      code: 'print(1)',
      inputs: JSON.stringify({
        files: [
          {
            path: 'files/BetaBionics/brief_extract.json',
            sandboxPath: '/home/user/out.json',
          },
        ],
      }),
      outputs: JSON.stringify({
        files: [{ path: 'files/BetaBionics/grouped.json', mode: 'overwrite' }],
      }),
    }
    enrichFunctionExecuteArgs(args)
    expect(args.inputs).toEqual({
      files: [
        {
          path: 'files/BetaBionics/brief_extract.json',
          sandboxPath: '/home/user/out.json',
        },
      ],
    })
    expect(args.outputs).toEqual({
      files: [{ path: 'files/BetaBionics/grouped.json', mode: 'overwrite' }],
    })
  })

  it('leaves already-object inputs alone', () => {
    const inputs = { files: [{ path: 'files/a.docx' }] }
    const args: Record<string, unknown> = { inputs }
    enrichFunctionExecuteArgs(args)
    expect(args.inputs).toBe(inputs)
  })
})
