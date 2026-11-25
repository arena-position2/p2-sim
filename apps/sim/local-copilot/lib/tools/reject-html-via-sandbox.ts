import type { ToolExecutionResult } from '@/local-copilot/lib/tools/executor'

const HTML_OUTPUT_PATH = /\.html?(?:\s|"|'|$|\?|#)/i
const HTML_SANDBOX_CODE =
  /\b(?:open\s*\([^)]*\.html?['"]|Path\s*\([^)]*\.html?['"]|write(?:text|bytes)?\s*\([^)]*\.html?['"]|BeautifulSoup\b|from\s+bs4\b|html\.parser|lxml\.html|<html[\s>]|<!DOCTYPE\s+html)/i

export const HTML_VIA_SANDBOX_ERROR =
  'Do not use function_execute / manage_sandbox to inspect or rewrite workspace HTML. Use read/grep on files/<name>/content or uploads/<name>, then workspace_file operation=patch + edit_content. Sandbox HTML dumps thrash and leave the live file unchanged.'

function collectCodeBlobs(args: Record<string, unknown>): string[] {
  const blobs: string[] = []
  for (const key of ['code', 'script', 'source', 'command', 'content', 'stdin'] as const) {
    if (typeof args[key] === 'string' && args[key].trim()) blobs.push(args[key])
  }
  return blobs
}

function collectOutputPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = []
  const outputs = args.outputs
  if (outputs && typeof outputs === 'object' && !Array.isArray(outputs)) {
    const files = (outputs as { files?: unknown }).files
    if (Array.isArray(files)) {
      for (const file of files) {
        if (typeof file === 'string' && file.trim()) paths.push(file.trim())
        if (file && typeof file === 'object' && !Array.isArray(file)) {
          const path = (file as { path?: unknown }).path
          if (typeof path === 'string' && path.trim()) paths.push(path.trim())
        }
      }
    }
  }
  for (const key of ['outputPath', 'fileName', 'path'] as const) {
    if (typeof args[key] === 'string' && args[key].trim()) paths.push(args[key].trim())
  }
  return paths
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
 */
export function rejectHtmlFileViaSandbox(
  toolName: string,
  args: Record<string, unknown>
): ToolExecutionResult | null {
  if (toolName !== 'function_execute' && toolName !== 'manage_sandbox') return null

  const code = collectCodeBlobs(args).join('\n')
  if (HTML_SANDBOX_CODE.test(code)) {
    return rejection(toolName)
  }

  if (
    toolName === 'function_execute' &&
    collectOutputPaths(args).some((path) => HTML_OUTPUT_PATH.test(path))
  ) {
    return rejection(toolName)
  }

  return null
}
