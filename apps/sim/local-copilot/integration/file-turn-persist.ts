import { isPlainRecord, omit, toRecord } from '@sim/utils/object'
import { extractResourcesFromToolResult } from '@/lib/mothership/resources/extraction'
import type { MothershipResource } from '@/lib/mothership/resources/types'
import { FILE_BODY_ARG_KEYS, firstFileBodyString } from '@/local-copilot/lib/tools/file-body-args'

const FILE_BODY_TOOL_NAMES = new Set(['create_file', 'edit_content'])

function omitFileBodyContent(params: Record<string, unknown>): Record<string, unknown> {
  const keysToDrop = FILE_BODY_ARG_KEYS.filter(
    (key) => typeof params[key] === 'string' && (params[key] as string).length > 0
  )
  if (keysToDrop.length === 0) return params
  let contentChars = 0
  for (const key of keysToDrop) {
    contentChars = Math.max(contentChars, (params[key] as string).length)
  }
  return {
    ...omit(params, keysToDrop),
    contentOmitted: true,
    contentChars,
  }
}

/**
 * Arena Copilot file writes put the whole markdown / office JS in tool args.
 * Strip that body from the mothership-facing call frame so the assistant row
 * can persist after the turn completes.
 */
export function stripLocalFileBodyToolParams(
  toolName: string,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (!FILE_BODY_TOOL_NAMES.has(toolName)) return params
  const stripped = omitFileBodyContent(params)
  const nested = isPlainRecord(stripped.args) ? stripped.args : undefined
  if (!nested) return stripped
  const nestedStripped = omitFileBodyContent(nested)
  if (nestedStripped === nested) return stripped
  return {
    ...stripped,
    args: nestedStripped,
  }
}

export function localFileBodyContent(
  args: Record<string, unknown> | undefined
): string | undefined {
  if (!args) return undefined
  const top = firstFileBodyString(args)
  if (top) return top
  const nested = isPlainRecord(args.args) ? args.args : undefined
  return nested ? firstFileBodyString(nested) : undefined
}

/**
 * File ids from Arena Copilot file tools. Shared extraction only knows
 * Cloud's `create_empty_file` id — map Arena `create_file` onto that shape,
 * and still pick up `edit_content` which is not a shared resource tool.
 */
export function extractLocalFileChatResources(
  toolName: string,
  params: Record<string, unknown> | undefined,
  output: unknown
): MothershipResource[] {
  const extractionName = toolName === 'create_file' ? 'create_empty_file' : toolName
  const extracted = extractResourcesFromToolResult(extractionName, params, output)
  if (extracted.length > 0) return extracted
  if (toolName !== 'edit_content' && toolName !== 'create_file') return []

  const result = toRecord(output)
  const data = toRecord(result.data)
  const file = toRecord(data.file)
  const fileId =
    (typeof file.id === 'string' && file.id) ||
    (typeof data.fileId === 'string' && data.fileId) ||
    (typeof data.id === 'string' && data.id) ||
    undefined
  if (!fileId) return []
  const title =
    (typeof file.name === 'string' && file.name) ||
    (typeof data.fileName === 'string' && data.fileName) ||
    (typeof data.name === 'string' && data.name) ||
    'File'
  return [{ type: 'file', id: fileId, title }]
}
