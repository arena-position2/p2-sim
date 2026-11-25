import { truncate } from '@sim/utils/string'
import {
  loadCopilotChatConfig,
  mergeCopilotChatConfig,
} from '@/local-copilot/lib/context/chat-config'
import type { ChatMessage } from '@/local-copilot/lib/providers/types'

/** Prefix for the durable active-document system block. */
export const ACTIVE_DOCUMENTS_SYSTEM_PREFIX =
  'Active documents (chat-scoped edit targets):' as const

/** Soft cap on tracked documents per chat. */
export const MAX_ACTIVE_DOCUMENTS = 8

export type ActiveDocumentRole = 'upload' | 'generated' | 'edited'

export interface ActiveDocument {
  path: string
  role: ActiveDocumentRole
  lastTouchedAt: string
  name?: string
}

export interface ActiveDocumentsState {
  documents: ActiveDocument[]
  /** Default edit target when the user is vague. */
  preferredPath: string | null
}

export type ActiveEditTargetReason =
  | 'current_upload'
  | 'explicit_name'
  | 'preferred'
  | 'single'
  | 'ambiguous'
  | 'image_reference'
  | 'none'

export interface ResolvedActiveEditTarget {
  preferredPath: string | null
  reason: ActiveEditTargetReason
  candidates: string[]
}

/** Image uploads are visual references — never auto-preferred edit targets. */
const IMAGE_DOCUMENT_EXTENSION = /\.(png|jpe?g|gif|webp)$/i

const ACTIVE_DOC_TOUCH_TOOLS = new Set([
  'create_file',
  'workspace_file',
  'edit_content',
  'materialize_file',
  'save_upload',
])

/**
 * Parses chat-config JSON into ActiveDocumentsState.
 */
export function parseActiveDocumentsState(value: unknown): ActiveDocumentsState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const rawDocs = Array.isArray(record.documents) ? record.documents : []
  const documents: ActiveDocument[] = []
  for (const item of rawDocs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const path = typeof row.path === 'string' ? normalizeDocumentPath(row.path) : ''
    if (!path) continue
    const role = row.role
    if (role !== 'upload' && role !== 'generated' && role !== 'edited') continue
    const lastTouchedAt =
      typeof row.lastTouchedAt === 'string' && row.lastTouchedAt.trim()
        ? row.lastTouchedAt.trim()
        : new Date().toISOString()
    const name =
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : fileNameFromPath(path) || undefined
    documents.push({ path, role, lastTouchedAt, ...(name ? { name } : {}) })
  }

  const preferredSpecified = Object.hasOwn(record, 'preferredPath')
  const preferredRaw =
    typeof record.preferredPath === 'string' ? normalizeDocumentPath(record.preferredPath) : ''
  const preferredPath =
    preferredRaw && documents.some((doc) => doc.path === preferredRaw) ? preferredRaw : null

  if (documents.length === 0 && !preferredPath) return null
  return clampActiveDocumentsState(
    { documents, preferredPath },
    {
      // Explicit null in chat config means "cleared" (e.g. image-only create turn).
      allowEmptyPreferred: preferredSpecified && record.preferredPath === null,
    }
  )
}

/**
 * Enforces size caps and canonical preferredPath.
 * Pass `allowEmptyPreferred` when an image-only create turn intentionally clears
 * preferredPath so a prior HTML file is not silently re-selected.
 */
export function clampActiveDocumentsState(
  state: ActiveDocumentsState,
  options?: { allowEmptyPreferred?: boolean }
): ActiveDocumentsState {
  const byPath = new Map<string, ActiveDocument>()
  for (const doc of state.documents) {
    const path = normalizeDocumentPath(doc.path)
    if (!path) continue
    const next: ActiveDocument = {
      path,
      role: doc.role,
      lastTouchedAt: doc.lastTouchedAt,
      ...(doc.name?.trim() ? { name: truncate(doc.name.trim(), 120, '') } : {}),
    }
    const prev = byPath.get(path)
    if (!prev || prev.lastTouchedAt <= next.lastTouchedAt) {
      byPath.set(path, next)
    }
  }

  const documents = [...byPath.values()]
    .sort((a, b) => a.lastTouchedAt.localeCompare(b.lastTouchedAt))
    .slice(-MAX_ACTIVE_DOCUMENTS)

  const preferredValid =
    Boolean(state.preferredPath) &&
    documents.some((doc) => doc.path === state.preferredPath) &&
    !isImageDocumentPath(state.preferredPath ?? '')

  const preferred = preferredValid
    ? state.preferredPath
    : options?.allowEmptyPreferred
      ? null
      : lastEditableDocumentPath(documents)

  return { documents, preferredPath: preferred }
}

/**
 * Formats active documents as a system chat message.
 */
export function formatActiveDocumentsSystemMessage(
  state: ActiveDocumentsState,
  resolution?: ResolvedActiveEditTarget
): ChatMessage {
  const preferred =
    resolution?.preferredPath ?? state.preferredPath ?? state.documents.at(-1)?.path ?? null
  const payload = {
    preferredPath: preferred,
    resolveReason: resolution?.reason ?? (preferred ? 'preferred' : 'none'),
    documents: state.documents.map((doc) => ({
      path: doc.path,
      role: doc.role,
      name: doc.name ?? fileNameFromPath(doc.path),
      lastTouchedAt: doc.lastTouchedAt,
    })),
    rules: [
      'Current-turn uploads win over older preferred documents.',
      'Image uploads (png/jpeg/gif/webp) are reference only — never preferredPath.',
      'If the user names a file, edit that path only.',
      'If multiple documents could match and the user is vague, ask which file — do not silently patch the wrong one.',
      'After create_file / materialize / successful edit, keep editing that same path (do not create a duplicate).',
    ],
  }
  return {
    role: 'system',
    content: `${ACTIVE_DOCUMENTS_SYSTEM_PREFIX}\n${JSON.stringify(payload, null, 2)}`,
  }
}

export function isActiveDocumentsSystemMessage(message: ChatMessage): boolean {
  if (message.role !== 'system') return false
  const text = typeof message.content === 'string' ? message.content : ''
  return text.startsWith(ACTIVE_DOCUMENTS_SYSTEM_PREFIX)
}

/**
 * Loads active documents from chat config.
 */
export async function loadActiveDocuments(
  chatId: string,
  userId: string
): Promise<ActiveDocumentsState | null> {
  const config = await loadCopilotChatConfig(chatId, userId)
  if (!config) return null
  return parseActiveDocumentsState(config.activeDocuments)
}

/**
 * Persists active documents into chat config.
 */
export async function persistActiveDocuments(
  chatId: string,
  userId: string,
  state: ActiveDocumentsState
): Promise<void> {
  await mergeCopilotChatConfig(chatId, userId, {
    activeDocuments: clampActiveDocumentsState(state, {
      allowEmptyPreferred: state.preferredPath === null,
    }),
  })
}

/**
 * Builds upload paths from the current turn's attachments / uploaded_file contexts.
 */
export function pathsFromCurrentTurnUploads(params: {
  fileAttachments?: Array<{ filename?: string }>
  contexts?: Array<{ type?: string; content?: string }>
}): string[] {
  const paths: string[] = []
  const seen = new Set<string>()

  for (const attachment of params.fileAttachments ?? []) {
    const name = attachment.filename?.trim()
    if (!name) continue
    const path = normalizeDocumentPath(`uploads/${name}`)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }

  for (const entry of params.contexts ?? []) {
    if (entry.type !== 'uploaded_file' || typeof entry.content !== 'string') continue
    const nameMatch = entry.content.match(/^File "([^"]+)"/)
    const name = nameMatch?.[1]?.trim()
    if (!name) continue
    const path = normalizeDocumentPath(`uploads/${name}`)
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }

  return paths
}

/**
 * True when the path is an image file (screenshot / mockup), not an edit target.
 */
export function isImageDocumentPath(path: string): boolean {
  return IMAGE_DOCUMENT_EXTENSION.test(fileNameFromPath(normalizeDocumentPath(path)))
}

/**
 * Whether an image-only turn should clear a prior preferred edit target.
 * Create / build-from-screenshot intents clear; edit-existing intents keep it.
 * Ambiguous image-only turns clear so we do not silently patch an old HTML file.
 */
export function shouldClearPreferredForImageOnlyTurn(message: string): boolean {
  const text = message.trim().toLowerCase()
  if (!text) return true

  const createVerb =
    /\b(build|create|generate|make|design|recreate|clone|convert|turn into)\b/.test(text)
  const fromImage =
    /\b(from|based on)\s+(this\s+)?(screenshot|image|png|photo|mockup|design)\b/.test(text)
  const editVerb = /\b(fix|edit|update|change|patch|tweak|adjust|modify|rename|restyle)\b/.test(
    text
  )

  // "fix the header using this screenshot as reference" → keep prior preferred.
  if (editVerb && !createVerb && !fromImage) return false
  if (createVerb || fromImage) return true
  if (/\b(screenshot|mockup)\b/.test(text) && !editVerb) return true
  return true
}

/**
 * Picks the edit target for this turn without colliding older files with new uploads.
 * Image uploads never become preferredPath; create-from-screenshot clears a prior preferred.
 */
export function resolveActiveEditTarget(params: {
  state: ActiveDocumentsState | null
  currentTurnPaths: string[]
  message: string
}): ResolvedActiveEditTarget {
  const known = [
    ...new Set([
      ...(params.state?.documents.map((doc) => doc.path) ?? []),
      ...params.currentTurnPaths.map(normalizeDocumentPath).filter(Boolean),
    ]),
  ]
  const knownEditable = known.filter((path) => !isImageDocumentPath(path))
  const current = [...new Set(params.currentTurnPaths.map(normalizeDocumentPath).filter(Boolean))]
  const currentEditable = current.filter((path) => !isImageDocumentPath(path))
  const currentImages = current.filter((path) => isImageDocumentPath(path))

  const explicit = findExplicitPathMentions(params.message, knownEditable)
  if (explicit.length === 1) {
    return { preferredPath: explicit[0] ?? null, reason: 'explicit_name', candidates: explicit }
  }
  if (explicit.length > 1) {
    return { preferredPath: null, reason: 'ambiguous', candidates: explicit }
  }

  if (currentEditable.length === 1) {
    return {
      preferredPath: currentEditable[0] ?? null,
      reason: 'current_upload',
      candidates: currentEditable,
    }
  }
  if (currentEditable.length > 1) {
    return { preferredPath: null, reason: 'ambiguous', candidates: currentEditable }
  }

  if (currentImages.length > 0 && currentEditable.length === 0) {
    if (shouldClearPreferredForImageOnlyTurn(params.message)) {
      return {
        preferredPath: null,
        reason: 'image_reference',
        candidates: currentImages,
      }
    }
    const preferred = params.state?.preferredPath
    if (preferred && knownEditable.includes(preferred) && !isImageDocumentPath(preferred)) {
      return { preferredPath: preferred, reason: 'preferred', candidates: [preferred] }
    }
    return {
      preferredPath: null,
      reason: 'image_reference',
      candidates: currentImages,
    }
  }

  // Preferred is the last created/edited editable doc — use it for vague follow-ups even when
  // older uploads (e.g. a screenshot) remain in the map. Current-turn uploads above
  // already win so a new file two days later does not collide with the old preferred.
  const preferred = params.state?.preferredPath
  if (preferred && knownEditable.includes(preferred) && !isImageDocumentPath(preferred)) {
    return { preferredPath: preferred, reason: 'preferred', candidates: [preferred] }
  }

  if (knownEditable.length === 1) {
    return { preferredPath: knownEditable[0] ?? null, reason: 'single', candidates: knownEditable }
  }
  if (knownEditable.length > 1) {
    return { preferredPath: null, reason: 'ambiguous', candidates: knownEditable }
  }

  return { preferredPath: null, reason: 'none', candidates: [] }
}

/**
 * Applies a touch (upsert). Images are tracked but never become preferredPath.
 */
export function touchActiveDocument(
  state: ActiveDocumentsState | null,
  touch: Omit<ActiveDocument, 'lastTouchedAt'> & { lastTouchedAt?: string }
): ActiveDocumentsState {
  const path = normalizeDocumentPath(touch.path)
  const lastTouchedAt = touch.lastTouchedAt ?? new Date().toISOString()
  const nextDoc: ActiveDocument = {
    path,
    role: touch.role,
    lastTouchedAt,
    ...(touch.name?.trim()
      ? { name: touch.name.trim() }
      : { name: fileNameFromPath(path) || undefined }),
  }

  const previous = state?.documents ?? []
  const without = previous.filter((doc) => doc.path !== path)
  const preferredPath = isImageDocumentPath(path)
    ? state?.preferredPath && !isImageDocumentPath(state.preferredPath)
      ? state.preferredPath
      : lastEditableDocumentPath(without)
    : path
  return clampActiveDocumentsState({
    documents: [...without, nextDoc],
    preferredPath,
  })
}

/**
 * Merges current-turn uploads and successful file-tool touches into durable state.
 * Image-only create/build-from-screenshot turns clear preferredPath so the next
 * vague follow-up does not silently patch a prior HTML file.
 */
export function updateActiveDocumentsFromTurn(params: {
  previous: ActiveDocumentsState | null
  currentTurnUploadPaths: string[]
  toolRecords: Array<{ name: string; success: boolean; result?: unknown }>
  message?: string
  now?: string
}): ActiveDocumentsState | null {
  const now = params.now ?? new Date().toISOString()
  let next = params.previous
  const uploadPaths = params.currentTurnUploadPaths.map(normalizeDocumentPath).filter(Boolean)
  const editableUploads = uploadPaths.filter((path) => !isImageDocumentPath(path))
  const imageUploads = uploadPaths.filter((path) => isImageDocumentPath(path))

  for (const path of uploadPaths) {
    next = touchActiveDocument(next, { path, role: 'upload', lastTouchedAt: now })
  }

  for (const record of params.toolRecords) {
    const touch = extractActiveDocumentTouch(record.name, record.success, record.result, now)
    if (!touch) continue
    next = touchActiveDocument(next, touch)
  }

  if (
    next &&
    imageUploads.length > 0 &&
    editableUploads.length === 0 &&
    shouldClearPreferredForImageOnlyTurn(params.message ?? '')
  ) {
    const touchedEditableTool = params.toolRecords.some((record) => {
      const touch = extractActiveDocumentTouch(record.name, record.success, record.result, now)
      return Boolean(touch && !isImageDocumentPath(touch.path))
    })
    if (!touchedEditableTool) {
      next = clampActiveDocumentsState(
        {
          documents: next.documents,
          preferredPath: null,
        },
        { allowEmptyPreferred: true }
      )
    }
  }

  return next
}

/**
 * Extracts a document touch from a successful file-pipeline tool result.
 */
export function extractActiveDocumentTouch(
  toolName: string,
  success: boolean,
  result: unknown,
  now: string = new Date().toISOString()
): ActiveDocument | null {
  if (!success || !ACTIVE_DOC_TOUCH_TOOLS.has(toolName)) return null
  const path = extractPathFromToolResult(toolName, result)
  if (!path) return null

  const role: ActiveDocumentRole =
    toolName === 'create_file'
      ? 'generated'
      : toolName === 'materialize_file' || toolName === 'save_upload'
        ? 'upload'
        : 'edited'

  return {
    path,
    role,
    lastTouchedAt: now,
    name: fileNameFromPath(path) || undefined,
  }
}

function extractPathFromToolResult(toolName: string, result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  const data =
    record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {}

  const candidates = [
    data.vfsPath,
    data.path,
    data.name,
    record.vfsPath,
    record.path,
    record.fileName,
    record.name,
  ]

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const normalized = normalizeToolPath(candidate.trim())
    if (normalized) return normalized
  }

  if (toolName === 'materialize_file' && typeof record.message === 'string') {
    const match = record.message.match(/available at\s+(\S+)/i)
    if (match?.[1]) {
      return normalizeToolPath(match[1].replace(/[.,]$/, ''))
    }
  }

  return null
}

function normalizeToolPath(raw: string): string | null {
  let path = raw.trim()
  if (!path) return null
  // create_file sometimes returns bare names — prefer files/ for non-upload paths.
  if (!path.includes('/') && !path.startsWith('uploads/')) {
    path = `files/${path}`
  }
  if (path.endsWith('/content')) {
    path = path.slice(0, -'/content'.length)
  }
  return normalizeDocumentPath(path)
}

/**
 * Normalizes a VFS path for active-document identity.
 */
export function normalizeDocumentPath(path: string): string {
  let next = path.trim().replace(/\\/g, '/')
  while (next.startsWith('./')) next = next.slice(2)
  next = next.replace(/\/{2,}/g, '/')
  if (next.endsWith('/') && next.length > 1) next = next.slice(0, -1)
  if (next.endsWith('/content')) next = next.slice(0, -'/content'.length)
  return next
}

function fileNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function lastEditableDocumentPath(documents: ActiveDocument[]): string | null {
  for (let i = documents.length - 1; i >= 0; i -= 1) {
    const path = documents[i]?.path
    if (path && !isImageDocumentPath(path)) return path
  }
  return null
}

function findExplicitPathMentions(message: string, candidates: string[]): string[] {
  if (!message.trim() || candidates.length === 0) return []
  const lower = message.toLowerCase()
  const hits: string[] = []
  for (const candidate of candidates) {
    const path = candidate.toLowerCase()
    const base = fileNameFromPath(candidate).toLowerCase()
    if ((path && lower.includes(path)) || (base && lower.includes(base))) {
      hits.push(candidate)
    }
  }
  return hits
}
