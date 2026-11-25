/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_VIA_SANDBOX_ERROR,
  rejectHtmlFileViaSandbox,
} from '@/local-copilot/lib/tools/reject-html-via-sandbox'

describe('rejectHtmlFileViaSandbox', () => {
  it('rejects function_execute that writes .html outputs', () => {
    const result = rejectHtmlFileViaSandbox('function_execute', {
      language: 'python',
      code: 'print("ok")',
      outputs: { files: ['files/page.html'] },
    })
    expect(result?.success).toBe(false)
    expect(result?.error).toBe(HTML_VIA_SANDBOX_ERROR)
  })

  it('rejects sandbox code that opens or parses HTML', () => {
    const result = rejectHtmlFileViaSandbox('function_execute', {
      language: 'python',
      code: 'from bs4 import BeautifulSoup\nopen("files/page.html").read()',
    })
    expect(result?.success).toBe(false)
    expect(result?.error).toBe(HTML_VIA_SANDBOX_ERROR)
  })

  it('allows unrelated sandbox compute', () => {
    expect(
      rejectHtmlFileViaSandbox('function_execute', {
        language: 'python',
        code: 'print(1 + 1)',
      })
    ).toBeNull()
  })
})
