import { truncate } from '@sim/utils/string'
import { FILE_BODY_ARG_KEYS, firstFileBodyString } from '@/local-copilot/lib/tools/file-body-args'

const OFFICE_FILE_EXTENSION = /\.(pptx|docx|pdf)$/i
const BINARY_IMAGE_FILE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i

/**
 * Parses a JSON object string once when models stringify nested tool args.
 */
function tryParseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

function toWorkspaceVfsPath(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith('files/') ? trimmed : `files/${trimmed}`
}

function basenameWithoutExtension(path: string): string {
  const base = path.split('/').pop()?.trim() || path.trim()
  const withoutExt = base.replace(/\.[^.]+$/, '')
  return withoutExt || base
}

export function resolveCreateFilePath(args: Record<string, unknown>): string {
  if (typeof args.fileName === 'string' && args.fileName.trim()) {
    return args.fileName.trim()
  }
  if (args.outputs && typeof args.outputs === 'object' && !Array.isArray(args.outputs)) {
    const files = (args.outputs as { files?: unknown }).files
    if (Array.isArray(files) && files[0] && typeof files[0] === 'object') {
      const path = (files[0] as { path?: unknown }).path
      if (typeof path === 'string') return path.trim()
    }
  }
  return ''
}

/**
 * Stable `files/...` key for turn-scoped create_file reuse.
 */
export function canonicalCreateFilePath(args: Record<string, unknown>): string {
  const raw = resolveCreateFilePath(args)
  if (!raw) return ''
  const withPrefix = raw.startsWith('files/') ? raw : `files/${raw}`
  return withPrefix.toLowerCase()
}

/**
 * Normalizes common `create_file` arg mistakes so AJV does not reject the call.
 * Models often pass a string/array for `outputs` or a bare `path`/`name` instead of `fileName`.
 */
export function enrichCreateFileArgs(args: Record<string, unknown>): void {
  if (typeof args.outputs === 'string') {
    const raw = args.outputs.trim()
    const asObject = tryParseJsonObject(raw)
    if (asObject) {
      args.outputs = asObject
    } else if (raw) {
      args.outputs = { files: [{ path: raw, mode: 'create' }] }
    }
  }

  if (Array.isArray(args.outputs)) {
    const files = args.outputs
      .map((item) => {
        if (typeof item === 'string' && item.trim()) {
          return { path: item.trim(), mode: 'create' as const }
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const file = item as Record<string, unknown>
          const path = typeof file.path === 'string' ? file.path.trim() : ''
          if (!path) return null
          return {
            path,
            mode: typeof file.mode === 'string' ? file.mode : 'create',
            ...(typeof file.mimeType === 'string' ? { mimeType: file.mimeType } : {}),
          }
        }
        return null
      })
      .filter((file): file is NonNullable<typeof file> => file !== null)
    args.outputs = { files }
  }

  if (args.outputs && typeof args.outputs === 'object' && !Array.isArray(args.outputs)) {
    const files = (args.outputs as { files?: unknown }).files
    if (Array.isArray(files)) {
      for (const file of files) {
        if (!file || typeof file !== 'object' || Array.isArray(file)) continue
        const row = file as Record<string, unknown>
        if (typeof row.path === 'string' && row.path.trim() && typeof row.mode !== 'string') {
          row.mode = 'create'
        }
      }
    }
  }

  if (typeof args.fileName !== 'string' || !args.fileName.trim()) {
    if (typeof args.path === 'string' && args.path.trim()) {
      args.fileName = args.path.trim()
    } else if (typeof args.name === 'string' && args.name.trim()) {
      args.fileName = args.name.trim()
    }
  }

  const createPath = resolveCreateFilePath(args)
  const nested =
    args.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : undefined

  // Office shells reject inline content — drop every body alias so create_file
  // can succeed as an empty file, then workspace_file + edit_content write JS.
  if (createPath && OFFICE_FILE_EXTENSION.test(createPath)) {
    for (const key of FILE_BODY_ARG_KEYS) {
      if (key in args) args[key] = undefined
    }
    if (nested) {
      for (const key of FILE_BODY_ARG_KEYS) {
        if (key in nested) nested[key] = undefined
      }
    }
    return
  }

  if (typeof args.content !== 'string' || args.content.length === 0) {
    const body = firstFileBodyString(args) ?? (nested ? firstFileBodyString(nested) : undefined)
    if (body) args.content = body
  }

  // Native object/array `content` (common from Claude tool_use) must become a string
  // before create_file — otherwise it is ignored and an empty shell is written.
  if (args.content && typeof args.content === 'object') {
    try {
      args.content = JSON.stringify(args.content, null, 2)
    } catch {
      args.content = undefined
    }
  }
  if (nested?.content && typeof nested.content === 'object') {
    try {
      nested.content = JSON.stringify(nested.content, null, 2)
      if (typeof args.content !== 'string' || !args.content) {
        args.content = nested.content
      }
    } catch {
      nested.content = undefined
    }
  }
}

/**
 * Local Copilot guard: never let create_file store PNG/JPEG base64 as UTF-8 text.
 * Prefer generate_image — keeps the shared create_file tool unchanged.
 */
export function rejectCreateFileImageAsText(args: Record<string, unknown>): string | null {
  const path = resolveCreateFilePath(args)
  if (!path || !BINARY_IMAGE_FILE_EXTENSION.test(path)) return null
  return (
    `create_file cannot write "${path}" as text/base64. ` +
    'Call generate_image with prompt and outputs.files (e.g. files/diagram.png) so the image is saved as binary.'
  )
}

/**
 * Normalizes common `workspace_file` arg mistakes so AJV does not reject the call.
 * Models often pass `target` as a path string and omit required `title`.
 */
export function enrichWorkspaceFileArgs(args: Record<string, unknown>): void {
  if (typeof args.target === 'string') {
    const raw = args.target.trim()
    const asObject = tryParseJsonObject(raw)
    if (asObject) {
      args.target = asObject
    } else if (raw) {
      args.target = { kind: 'path', path: raw }
    }
  }

  if (args.target && typeof args.target === 'object' && !Array.isArray(args.target)) {
    const target = args.target as Record<string, unknown>
    if (typeof target.path === 'string') {
      target.path = target.path.trim()
    }
    if (!target.kind && typeof target.path === 'string' && target.path) {
      target.kind = 'path'
    }
    if (target.kind === 'file_id' && typeof target.path === 'string' && target.path) {
      target.kind = 'path'
    }
    // create_file already inserted the row. kind=new_file / operation=create
    // would insert a second uniquely-named file (Deck (1).pptx).
    if (target.kind === 'new_file') {
      const fileName = typeof target.fileName === 'string' ? target.fileName.trim() : ''
      const path = typeof target.path === 'string' ? target.path.trim() : ''
      const resolved = path || fileName
      if (resolved) {
        target.kind = 'path'
        target.path = toWorkspaceVfsPath(resolved)
      }
    }
    if (target.kind === 'path' && typeof target.path === 'string' && target.path) {
      target.path = toWorkspaceVfsPath(target.path)
    }
  }

  if (!args.target) {
    if (typeof args.path === 'string' && args.path.trim()) {
      args.target = { kind: 'path', path: args.path.trim() }
    } else if (typeof args.filePath === 'string' && args.filePath.trim()) {
      args.target = { kind: 'path', path: args.filePath.trim() }
    }
  }

  if (typeof args.operation !== 'string' || !args.operation.trim()) {
    args.operation = 'update'
  } else if (args.operation === 'create') {
    args.operation = 'update'
  }

  if (typeof args.title !== 'string' || !args.title.trim()) {
    const target = args.target
    if (target && typeof target === 'object' && !Array.isArray(target)) {
      const path =
        typeof (target as Record<string, unknown>).path === 'string'
          ? ((target as Record<string, unknown>).path as string)
          : ''
      if (path) {
        args.title = truncate(basenameWithoutExtension(path), 48)
      }
    }
  }
}

/**
 * Remaps common `edit_content` aliases when the model omits required `content`.
 */
export function enrichEditContentArgs(args: Record<string, unknown>): void {
  if (args.content && typeof args.content === 'object') {
    try {
      args.content = JSON.stringify(args.content, null, 2)
    } catch {
      args.content = undefined
    }
  }
  if (typeof args.content === 'string' && args.content.length > 0) return
  const body = firstFileBodyString(args)
  if (body) args.content = body
}
