import type { ToolExecutionResult } from '@/local-copilot/lib/tools/executor'

const OFFICE_OUTPUT_PATH = /\.(pptx|docx|pdf)(?:\s|"|'|$|\?|#)/i
/** Build-oriented sandbox code — never allowed via function_execute. */
const OFFICE_BUILD_CODE =
  /\b(?:python-pptx|from\s+pptx\b|import\s+pptx\b|reportlab|Presentation\s*\()\b/i
/** Read/parse Word — allowed for extract when not writing office binaries. */
const OFFICE_DOCX_READ_CODE = /\b(?:python-docx|from\s+docx\b|import\s+docx\b|Document\s*\()\b/i
const OFFICE_SANDBOX_CODE =
  /\b(?:python-pptx|python-docx|from\s+pptx\b|import\s+pptx\b|from\s+docx\b|import\s+docx\b|reportlab|Presentation\s*\(|Document\s*\()\b/i
const OFFICE_SANDBOX_DEP =
  /^(?:python-pptx|python-docx|reportlab|python-docx-template|pptx|docx)(?:[=<>!~].*)?$/i
const OFFICE_BUILD_DEP = /^(?:python-pptx|reportlab|python-docx-template|pptx)(?:[=<>!~].*)?$/i
const OFFICE_DOCX_READ_DEP = /^(?:python-docx|docx)(?:[=<>!~].*)?$/i

export const OFFICE_VIA_SANDBOX_ERROR =
  'Do not use function_execute / manage_sandbox / python-pptx / python-docx / reportlab to build workspace PPTX/DOCX/PDF. Those office tools are always available: create_file (empty shell with fileName only) → workspace_file operation=update → edit_content with the document JS. Never tell the user office file tools are unavailable.'

function collectDependencyStrings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [item.trim()]
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>
      for (const key of ['name', 'package', 'dependency'] as const) {
        if (typeof record[key] === 'string' && record[key].trim()) return [record[key].trim()]
      }
    }
    return []
  })
}

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

function hasOfficeBinaryOutputs(args: Record<string, unknown>): boolean {
  return collectOutputPaths(args).some((path) => OFFICE_OUTPUT_PATH.test(path))
}

function rejection(toolName: string): ToolExecutionResult {
  return {
    toolName,
    success: false,
    error: OFFICE_VIA_SANDBOX_ERROR,
    result: { success: false, message: OFFICE_VIA_SANDBOX_ERROR },
  }
}

/**
 * Blocks remote-sandbox attempts to *build* workspace office docs. Read-only
 * python-docx / Document() extract into JSON/text is allowed on function_execute
 * when outputs are not .pptx/.docx/.pdf.
 */
export function rejectOfficeFileViaSandbox(
  toolName: string,
  args: Record<string, unknown>
): ToolExecutionResult | null {
  if (toolName !== 'function_execute' && toolName !== 'manage_sandbox') return null

  const deps = [
    ...collectDependencyStrings(args.dependencies),
    ...collectDependencyStrings(args.packages),
    ...collectDependencyStrings(args.requirements),
  ]
  const code = collectCodeBlobs(args).join('\n')

  // Writing office binaries via sandbox is never the Arena office path.
  if (toolName === 'function_execute' && hasOfficeBinaryOutputs(args)) {
    return rejection(toolName)
  }

  if (toolName === 'manage_sandbox') {
    if (deps.some((dep) => OFFICE_SANDBOX_DEP.test(dep))) return rejection(toolName)
    if (OFFICE_SANDBOX_CODE.test(code)) return rejection(toolName)
    return null
  }

  // function_execute: always block pptx/reportlab builders.
  if (OFFICE_BUILD_CODE.test(code) || deps.some((dep) => OFFICE_BUILD_DEP.test(dep))) {
    return rejection(toolName)
  }

  // Read-only Word extract (zipfile/Document → json/txt) is OK.
  if (OFFICE_DOCX_READ_CODE.test(code) || deps.some((dep) => OFFICE_DOCX_READ_DEP.test(dep))) {
    return null
  }

  if (OFFICE_SANDBOX_CODE.test(code) || deps.some((dep) => OFFICE_SANDBOX_DEP.test(dep))) {
    return rejection(toolName)
  }

  return null
}
