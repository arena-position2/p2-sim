import type { ToolExecutionResult } from '@/local-copilot/lib/tools/executor'

const HTML_PATH = /\.html?(?:\s|"|'|$|\?|#|\/)/i

/** Literal open/Path/write with .html in the call, or HTML parsers / dumps. */
const HTML_SANDBOX_CODE =
  /\b(?:open\s*\([^)]*\.html?['"]|Path\s*\([^)]*\.html?['"]|write(?:text|bytes)?\s*\([^)]*\.html?['"]|BeautifulSoup\b|from\s+bs4\b|html\.parser|lxml\.html|<html[\s>]|<!DOCTYPE\s+html)/i

/** Any .html string literal in code (covers path = "….html" then open(path)). */
const HTML_STRING_LITERAL = /['"`][^'"`\n]*\.html?['"`]/i

/** File open/read/write APIs used after a path variable assignment. */
const FILE_IO_CALL =
  /\b(?:open\s*\(|Path\s*\(|\.read_text\s*\(|\.write_text\s*\(|\.read_bytes\s*\(|\.write_bytes\s*\(|Path\([^)]*\)\s*\.\s*write_text)/i

/** Shell tools touching HTML paths. */
const SHELL_HTML_IO =
  /\b(?:cat|sed|awk|head|tail|less|more|rg|grep)\b[\s\S]{0,160}\.html?\b|\.html?\b[\s\S]{0,80}\b(?:cat|sed|awk)/i

export const HTML_VIA_SANDBOX_ERROR =
  'Do not use function_execute / manage_sandbox to inspect or rewrite workspace HTML. Use read/grep on files/<name>/content or uploads/<name>, then workspace_file operation=patch + edit_content. Sandbox HTML dumps thrash and leave the live file unchanged.'

function collectCodeBlobs(args: Record<string, unknown>): string[] {
  const blobs: string[] = []
  for (const key of ['code', 'script', 'source', 'command', 'content', 'stdin'] as const) {
    if (typeof args[key] === 'string' && args[key].trim()) blobs.push(args[key])
  }
  return blobs
}

function collectFileEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  for (const file of value) {
    if (typeof file === 'string' && file.trim()) {
      paths.push(file.trim())
      continue
    }
    if (file && typeof file === 'object' && !Array.isArray(file)) {
      const record = file as { path?: unknown; sandboxPath?: unknown }
      if (typeof record.path === 'string' && record.path.trim()) paths.push(record.path.trim())
      if (typeof record.sandboxPath === 'string' && record.sandboxPath.trim()) {
        paths.push(record.sandboxPath.trim())
      }
    }
  }
  return paths
}

function collectOutputPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = []
  const outputs = args.outputs
  if (outputs && typeof outputs === 'object' && !Array.isArray(outputs)) {
    paths.push(...collectFileEntries((outputs as { files?: unknown }).files))
  }
  for (const key of ['outputPath', 'fileName', 'path'] as const) {
    if (typeof args[key] === 'string' && args[key].trim()) paths.push(args[key].trim())
  }
  return paths
}

/**
 * Workspace files mounted into the sandbox (A2 bypass used inputs.files + open(path)).
 */
function collectInputMountPaths(args: Record<string, unknown>): string[] {
  const inputs = args.inputs
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return []
  return collectFileEntries((inputs as { files?: unknown }).files)
}

function hasHtmlPath(paths: readonly string[]): boolean {
  return paths.some((path) => HTML_PATH.test(path))
}

function codeLooksLikeHtmlInspect(code: string, htmlMounted: boolean): boolean {
  if (!code.trim()) return false
  if (HTML_SANDBOX_CODE.test(code)) return true
  if (SHELL_HTML_IO.test(code)) return true

  const hasHtmlLiteral = HTML_STRING_LITERAL.test(code)
  const hasFileIo = FILE_IO_CALL.test(code)

  // path = "….html" then open(path) / Path(path).read_text()
  if (hasHtmlLiteral && hasFileIo) return true

  // Mounted HTML + any open/read/write of files → treat as HTML inspect
  if (htmlMounted && hasFileIo) return true

  // Mounted HTML + shell dump patterns without needing .html again in the command
  if (htmlMounted && /\b(?:cat|sed|awk|head|tail)\b/i.test(code)) return true

  return false
}

function rejection(toolName: string): ToolExecutionResult {
  return {
    toolName,
    success: false,
    error: HTML_VIA_SANDBOX_ERROR,
    result: {
      success: false,
      message: HTML_VIA_SANDBOX_ERROR,
      followUpHint:
        'Call read or grep on the preferred HTML path, then workspace_file operation=patch with a short live substring, then edit_content.',
    },
  }
}

/**
 * Blocks sandbox attempts to dump or rewrite HTML. Models fall back here after
 * inspect thrash; the VFS read/grep → workspace_file patch path must be used.
 *
 * Covers A2 bypasses: `path = "….html"; open(path)` and HTML mounts via inputs.files.
 */
export function rejectHtmlFileViaSandbox(
  toolName: string,
  args: Record<string, unknown>
): ToolExecutionResult | null {
  if (toolName !== 'function_execute' && toolName !== 'manage_sandbox') return null

  const code = collectCodeBlobs(args).join('\n')
  const htmlMounted = hasHtmlPath(collectInputMountPaths(args))

  if (codeLooksLikeHtmlInspect(code, htmlMounted)) {
    return rejection(toolName)
  }

  if (
    toolName === 'function_execute' &&
    collectOutputPaths(args).some((path) => HTML_PATH.test(path))
  ) {
    return rejection(toolName)
  }

  return null
}
