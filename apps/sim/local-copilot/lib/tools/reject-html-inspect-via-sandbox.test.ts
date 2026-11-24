/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_INSPECT_VIA_SANDBOX_ERROR,
  rejectHtmlInspectViaSandbox,
} from '@/local-copilot/lib/tools/reject-html-inspect-via-sandbox'

describe('rejectHtmlInspectViaSandbox', () => {
  it('rejects function_execute HTML line dumps', () => {
    const result = rejectHtmlInspectViaSandbox('function_execute', {
      title: 'Inspect card styles',
      language: 'python',
      code: 'print(open("/home/user/files/Final Todo.html").read().splitlines()[0:40])',
      inputs: {
        files: [
          {
            path: 'files/Final Todo.html',
            sandboxPath: '/home/user/files/Final Todo.html',
          },
        ],
      },
    })
    expect(result?.success).toBe(false)
    expect(result?.error).toBe(HTML_INSPECT_VIA_SANDBOX_ERROR)
    expect(result?.error).toMatch(/workspace_file/i)
    expect(result?.error).toMatch(/Do not retry function_execute/i)
  })

  it('allows real compute that is not an HTML inspect dump', () => {
    expect(
      rejectHtmlInspectViaSandbox('function_execute', {
        title: 'Sum column',
        language: 'python',
        code: 'print(sum([1, 2, 3]))',
      })
    ).toBeNull()
  })

  it('ignores unrelated tools', () => {
    expect(
      rejectHtmlInspectViaSandbox('read', {
        path: 'files/Final Todo.html/content',
      })
    ).toBeNull()
  })
})
