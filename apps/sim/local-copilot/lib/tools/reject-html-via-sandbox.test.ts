/**
 * @vitest-environment node
 *
 * Protects A2 sandbox thrash: variable open(path) + HTML mounts must reject;
 * non-HTML compute (CSV / env probes) must still pass.
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

  it('rejects sandbox code that opens or parses HTML literals', () => {
    const result = rejectHtmlFileViaSandbox('function_execute', {
      language: 'python',
      code: 'from bs4 import BeautifulSoup\nopen("files/page.html").read()',
    })
    expect(result?.success).toBe(false)
    expect(result?.error).toBe(HTML_VIA_SANDBOX_ERROR)
  })

  it('rejects A2-style path variable then open(path)', () => {
    const result = rejectHtmlFileViaSandbox('function_execute', {
      language: 'python',
      code: `path = "/home/user/files/Apps/Team To-Do.html"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()
print(content.find("Team to-do"))
`,
      inputs: {
        files: [
          {
            path: 'files/Apps/Team%20To-Do.html',
            sandboxPath: '/home/user/files/Apps/Team To-Do.html',
          },
        ],
      },
    })
    expect(result?.success).toBe(false)
    expect(result?.error).toBe(HTML_VIA_SANDBOX_ERROR)
  })

  it('rejects HTML mount plus open even without .html in the open() args', () => {
    const result = rejectHtmlFileViaSandbox('function_execute', {
      language: 'python',
      code: 'p = mounts[0]\nprint(open(p).read()[:200])',
      inputs: {
        files: [{ path: 'files/Apps/Page.html', sandboxPath: '/home/user/files/Apps/Page.html' }],
      },
    })
    expect(result?.success).toBe(false)
  })

  it('rejects shell cat/sed on .html', () => {
    expect(
      rejectHtmlFileViaSandbox('function_execute', {
        language: 'shell',
        code: 'cat "/home/user/files/Apps/Team To-Do.html" | head -20',
      })?.success
    ).toBe(false)
  })

  it('allows unrelated sandbox compute', () => {
    expect(
      rejectHtmlFileViaSandbox('function_execute', {
        language: 'python',
        code: 'print(1 + 1)',
      })
    ).toBeNull()
  })

  it('allows CSV mount compute without HTML', () => {
    expect(
      rejectHtmlFileViaSandbox('function_execute', {
        language: 'python',
        code: `path = "/home/user/files/data.csv"
with open(path) as f:
    print(sum(1 for _ in f))
`,
        inputs: {
          files: [{ path: 'files/data.csv', sandboxPath: '/home/user/files/data.csv' }],
        },
      })
    ).toBeNull()
  })

  it('allows env probes with no HTML mount or literal', () => {
    expect(
      rejectHtmlFileViaSandbox('function_execute', {
        language: 'python',
        code: 'import os\nprint(sorted(os.environ)[:5])',
      })
    ).toBeNull()
  })
})
