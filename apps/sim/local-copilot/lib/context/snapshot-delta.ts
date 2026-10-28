/**
 * Incremental VFS inventory prompting: fingerprint baselines, id-keyed diffs,
 * and full / delta / unchanged system-message formatting for Local Copilot.
 */
import type { VfsSnapshotV1 } from '@/lib/mothership/generated/vfs-snapshot-v1'
import {
  computeSnapshotContentRevision,
  isSnapshotBundleFresh,
  type WorkspaceSnapshotMeta,
} from '@/local-copilot/lib/context/snapshot-freshness'

/** Diffable inventory kind names stored in the fingerprint map. */
export const SNAPSHOT_FINGERPRINT_KINDS = [
  'workflows',
  'files',
  'tables',
  'knowledgeBases',
  'skills',
  'jobs',
  'integrations',
  'mcpServers',
  'customTools',
  'customBlocks',
  'members',
  'envVars',
  'workspace',
] as const

export type SnapshotFingerprintKind = (typeof SNAPSHOT_FINGERPRINT_KINDS)[number]

/** Compact scalar fields retained for old→new change summaries. */
export type SnapshotFingerprintFields = Record<string, string | number | boolean | null>

export interface SnapshotFingerprintEntry {
  hash: string
  label?: string
  fields?: SnapshotFingerprintFields
}

export type SnapshotFingerprintKindMap = Record<string, SnapshotFingerprintEntry>

export interface WorkspaceSnapshotFingerprints {
  revision: string
  workspaceId: string
  generatedAt: string
  kinds: Partial<Record<SnapshotFingerprintKind, SnapshotFingerprintKindMap>>
}

export type SnapshotPromptMode = 'full' | 'delta' | 'unchanged'

export interface SnapshotPromptPlan {
  mode: SnapshotPromptMode
  content: string
  fingerprints: WorkspaceSnapshotFingerprints
  meta: WorkspaceSnapshotMeta & { workspaceId: string }
}

export interface ResolveSnapshotPromptPlanParams {
  snapshot: VfsSnapshotV1
  markdown: string
  workspaceId: string
  generatedAt: string
  contentRevision: string
  priorMeta?: (WorkspaceSnapshotMeta & { workspaceId?: string }) | null
  priorFingerprints?: WorkspaceSnapshotFingerprints | null
  nowMs?: number
}

interface KindDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

/**
 * FNV-1a hash of canonical JSON (same family as snapshot contentRevision).
 */
export function hashCanonicalJson(value: unknown): string {
  const canonical = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseFingerprintFields(value: unknown): SnapshotFingerprintFields | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const fields: SnapshotFingerprintFields = {}
  for (const [key, fieldValue] of Object.entries(record)) {
    if (
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean' ||
      fieldValue === null
    ) {
      fields[key] = fieldValue
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined
}

/**
 * Parses persisted fingerprint state from chat config.
 */
export function parseWorkspaceSnapshotFingerprints(
  value: unknown
): WorkspaceSnapshotFingerprints | null {
  const root = asRecord(value)
  if (!root) return null
  const revision = asString(root.revision)
  const workspaceId = asString(root.workspaceId)
  const generatedAt = asString(root.generatedAt)
  const kindsRaw = asRecord(root.kinds)
  if (!revision || !workspaceId || !generatedAt || !kindsRaw) return null

  const kinds: WorkspaceSnapshotFingerprints['kinds'] = {}
  for (const kind of SNAPSHOT_FINGERPRINT_KINDS) {
    const kindMap = asRecord(kindsRaw[kind])
    if (!kindMap) continue
    const entries: SnapshotFingerprintKindMap = {}
    for (const [key, entryValue] of Object.entries(kindMap)) {
      const entry = asRecord(entryValue)
      const hash = entry ? asString(entry.hash) : undefined
      if (!key.trim() || !hash) continue
      const label = entry ? asString(entry.label) : undefined
      const fields = entry ? parseFingerprintFields(entry.fields) : undefined
      entries[key] = {
        hash,
        ...(label ? { label } : {}),
        ...(fields ? { fields } : {}),
      }
    }
    if (Object.keys(entries).length > 0) {
      kinds[kind] = entries
    }
  }

  return { revision, workspaceId, generatedAt, kinds }
}

/**
 * Parses workspace snapshot meta, optionally including workspaceId.
 */
export function parseWorkspaceSnapshotMeta(
  value: unknown
): (WorkspaceSnapshotMeta & { workspaceId?: string }) | null {
  const root = asRecord(value)
  if (!root) return null
  const generatedAt = asString(root.generatedAt)
  const contentRevision = asString(root.contentRevision)
  if (!generatedAt || !contentRevision) return null
  const workspaceId = asString(root.workspaceId)
  return workspaceId
    ? { generatedAt, contentRevision, workspaceId }
    : { generatedAt, contentRevision }
}

function itemLabel(
  kind: SnapshotFingerprintKind,
  item: Record<string, unknown>
): string | undefined {
  if (kind === 'envVars') return asString(item.value)
  if (kind === 'members') return asString(item.email) ?? asString(item.name)
  if (kind === 'customBlocks') return asString(item.name) ?? asString(item.type)
  if (kind === 'integrations') {
    return asString(item.displayName) ?? asString(item.providerId) ?? asString(item.id)
  }
  if (kind === 'jobs') return asString(item.title) ?? asString(item.id)
  return asString(item.name) ?? asString(item.id) ?? asString(item.type)
}

function itemKey(kind: SnapshotFingerprintKind, item: Record<string, unknown>): string | null {
  switch (kind) {
    case 'customBlocks':
      return asString(item.type) ?? null
    case 'members':
      return asString(item.email) ?? null
    case 'envVars':
      return asString(item.value) ?? null
    case 'workspace':
      return 'workspace'
    default:
      return asString(item.id) ?? null
  }
}

function toItemRecords(
  kind: SnapshotFingerprintKind,
  snapshot: VfsSnapshotV1
): Array<Record<string, unknown>> {
  switch (kind) {
    case 'workflows':
      return (snapshot.workflows ?? []) as unknown as Array<Record<string, unknown>>
    case 'files':
      return (snapshot.files ?? []) as unknown as Array<Record<string, unknown>>
    case 'tables':
      return (snapshot.tables ?? []) as unknown as Array<Record<string, unknown>>
    case 'knowledgeBases':
      return (snapshot.knowledgeBases ?? []) as unknown as Array<Record<string, unknown>>
    case 'skills':
      return (snapshot.skills ?? []) as unknown as Array<Record<string, unknown>>
    case 'jobs':
      return []
    case 'integrations':
      return (snapshot.integrations ?? []) as unknown as Array<Record<string, unknown>>
    case 'mcpServers':
      return (snapshot.mcpServers ?? []) as unknown as Array<Record<string, unknown>>
    case 'customTools':
      return (snapshot.customTools ?? []) as unknown as Array<Record<string, unknown>>
    case 'customBlocks':
      return (snapshot.customBlocks ?? []) as unknown as Array<Record<string, unknown>>
    case 'members':
      return (snapshot.members ?? []) as unknown as Array<Record<string, unknown>>
    case 'envVars':
      return (snapshot.envVars ?? []).map((value) => ({ value }))
    case 'workspace':
      return snapshot.workspace ? [snapshot.workspace as unknown as Record<string, unknown>] : []
  }
}

/**
 * Extracts comparable scalar fields for old→new summaries (excludes id/key fields).
 */
export function extractFingerprintFields(
  kind: SnapshotFingerprintKind,
  item: Record<string, unknown>
): SnapshotFingerprintFields {
  const skip = new Set(
    kind === 'customBlocks'
      ? ['type']
      : kind === 'members'
        ? ['email']
        : kind === 'envVars'
          ? ['value']
          : kind === 'workspace'
            ? []
            : ['id']
  )
  const fields: SnapshotFingerprintFields = {}
  for (const [key, value] of Object.entries(item)) {
    if (skip.has(key)) continue
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      fields[key] = value
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      fields[key] = value.join(',')
    }
  }
  return fields
}

/**
 * Builds a slim fingerprint map from a typed VFS snapshot.
 */
export function buildWorkspaceSnapshotFingerprints(params: {
  snapshot: VfsSnapshotV1
  workspaceId: string
  generatedAt: string
  contentRevision?: string
}): WorkspaceSnapshotFingerprints {
  const revision = params.contentRevision?.trim() || computeSnapshotContentRevision(params.snapshot)
  const kinds: WorkspaceSnapshotFingerprints['kinds'] = {}

  for (const kind of SNAPSHOT_FINGERPRINT_KINDS) {
    const entries: SnapshotFingerprintKindMap = {}
    for (const item of toItemRecords(kind, params.snapshot)) {
      const key = itemKey(kind, item)
      if (!key) continue
      const label = itemLabel(kind, item)
      const fields = extractFingerprintFields(kind, item)
      entries[key] = {
        hash: hashCanonicalJson(item),
        ...(label ? { label } : {}),
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
      }
    }
    if (Object.keys(entries).length > 0) {
      kinds[kind] = entries
    }
  }

  return {
    revision,
    workspaceId: params.workspaceId,
    generatedAt: params.generatedAt,
    kinds,
  }
}

function formatScalar(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Field-level old→new summaries for two field maps.
 */
export function summarizeFieldChanges(
  previous: SnapshotFingerprintFields | null | undefined,
  current: SnapshotFingerprintFields | null | undefined
): string[] {
  const lines: string[] = []
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(current ?? {})])
  for (const key of [...keys].sort()) {
    const before = previous?.[key]
    const after = current?.[key]
    if (before === undefined && after === undefined) continue
    if (before === after) continue
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue
    lines.push(`${key}: ${formatScalar(before)}→${formatScalar(after)}`)
  }
  return lines
}

function findCurrentItem(
  kind: SnapshotFingerprintKind,
  snapshot: VfsSnapshotV1,
  key: string
): Record<string, unknown> | null {
  for (const item of toItemRecords(kind, snapshot)) {
    if (itemKey(kind, item) === key) return item
  }
  return null
}

function diffKindMaps(
  previous: SnapshotFingerprintKindMap | undefined,
  current: SnapshotFingerprintKindMap | undefined
): KindDiff {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  const prev = previous ?? {}
  const curr = current ?? {}
  for (const key of Object.keys(curr)) {
    if (!(key in prev)) {
      added.push(key)
      continue
    }
    if (prev[key]?.hash !== curr[key]?.hash) {
      changed.push(key)
    }
  }
  for (const key of Object.keys(prev)) {
    if (!(key in curr)) removed.push(key)
  }
  return { added, removed, changed }
}

function describeAddedItem(kind: SnapshotFingerprintKind, item: Record<string, unknown>): string {
  const label = itemLabel(kind, item)
  const key = itemKey(kind, item) ?? '?'
  if (kind === 'workflows') {
    return `${key} "${label ?? key}" deployed=${Boolean(item.isDeployed)}`
  }
  if (kind === 'files') {
    return `${key} "${label ?? key}" path=${String(item.path ?? '')}`
  }
  if (kind === 'envVars') {
    return String(item.value ?? key)
  }
  if (kind === 'customBlocks') {
    return `type=${key} "${label ?? key}"`
  }
  if (kind === 'integrations') {
    return `${key} provider=${String(item.providerId ?? '')}`
  }
  return label ? `${key} "${label}"` : key
}

/**
 * Formats a compact inventory delta between prior fingerprints and the current snapshot.
 */
export function formatSnapshotDelta(params: {
  previous: WorkspaceSnapshotFingerprints
  currentFingerprints: WorkspaceSnapshotFingerprints
  currentSnapshot: VfsSnapshotV1
}): string {
  const lines: string[] = [
    `delta (rev ${params.previous.revision}→${params.currentFingerprints.revision}):`,
  ]

  let anyChange = false
  for (const kind of SNAPSHOT_FINGERPRINT_KINDS) {
    const diff = diffKindMaps(params.previous.kinds[kind], params.currentFingerprints.kinds[kind])
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
      continue
    }
    anyChange = true
    lines.push(`## ${kind}`)
    for (const key of diff.added.sort()) {
      const item = findCurrentItem(kind, params.currentSnapshot, key)
      lines.push(
        item
          ? `+ ${describeAddedItem(kind, item)}`
          : `+ ${key}${
              params.currentFingerprints.kinds[kind]?.[key]?.label
                ? ` "${params.currentFingerprints.kinds[kind]?.[key]?.label}"`
                : ''
            }`
      )
    }
    for (const key of diff.removed.sort()) {
      const label = params.previous.kinds[kind]?.[key]?.label
      lines.push(label ? `- ${key} "${label}"` : `- ${key}`)
    }
    for (const key of diff.changed.sort()) {
      const prevEntry = params.previous.kinds[kind]?.[key]
      const currEntry = params.currentFingerprints.kinds[kind]?.[key]
      const label = currEntry?.label ?? prevEntry?.label
      lines.push(label ? `~ ${key} "${label}"` : `~ ${key}`)
      for (const line of summarizeFieldChanges(prevEntry?.fields, currEntry?.fields)) {
        lines.push(`  ${line}`)
      }
    }
  }

  if (!anyChange) {
    lines.push('(no per-item changes detected; revision differs — treat inventory as refreshed)')
  }

  lines.push(
    `(snapshot generatedAt=${params.currentFingerprints.generatedAt}; revision=${params.currentFingerprints.revision})`
  )
  return lines.join('\n')
}

/**
 * Chooses full / delta / unchanged and builds the snapshot system-message body.
 * Full mode includes the `Workspace snapshot:` prefix; delta/unchanged do not —
 * use {@link withWorkspaceSnapshotPrefix} when injecting.
 */
export function resolveSnapshotPromptPlan(
  params: ResolveSnapshotPromptPlanParams
): SnapshotPromptPlan {
  const fingerprints = buildWorkspaceSnapshotFingerprints({
    snapshot: params.snapshot,
    workspaceId: params.workspaceId,
    generatedAt: params.generatedAt,
    contentRevision: params.contentRevision,
  })
  const meta: WorkspaceSnapshotMeta & { workspaceId: string } = {
    generatedAt: params.generatedAt,
    contentRevision: params.contentRevision,
    workspaceId: params.workspaceId,
  }

  const prior = params.priorFingerprints
  const priorMeta = params.priorMeta
  const effectivePriorMeta =
    priorMeta ??
    (prior
      ? {
          generatedAt: prior.generatedAt,
          contentRevision: prior.revision,
          workspaceId: prior.workspaceId,
        }
      : null)
  const hasUsableBaseline =
    Boolean(prior) &&
    Boolean(effectivePriorMeta?.contentRevision) &&
    prior?.workspaceId === params.workspaceId &&
    (effectivePriorMeta?.workspaceId
      ? effectivePriorMeta.workspaceId === params.workspaceId
      : true) &&
    isSnapshotBundleFresh(
      {
        generatedAt: prior.generatedAt,
        contentRevision: prior.revision,
      },
      {
        nowMs: params.nowMs,
        contentRevision: prior.revision,
      }
    )

  if (!hasUsableBaseline || !prior) {
    return {
      mode: 'full',
      content: formatFullSnapshotContent(params.markdown, meta),
      fingerprints,
      meta,
    }
  }

  if (prior.revision === fingerprints.revision) {
    return {
      mode: 'unchanged',
      content: `unchanged (revision=${fingerprints.revision})`,
      fingerprints,
      meta,
    }
  }

  return {
    mode: 'delta',
    content: formatSnapshotDelta({
      previous: prior,
      currentFingerprints: fingerprints,
      currentSnapshot: params.snapshot,
    }),
    fingerprints,
    meta,
  }
}

function formatFullSnapshotContent(
  markdown: string,
  meta: WorkspaceSnapshotMeta & { workspaceId: string }
): string {
  return `Workspace snapshot:\n${markdown}\n\n(snapshot generatedAt=${meta.generatedAt}; revision=${meta.contentRevision})`
}

/**
 * Ensures snapshot system content starts with the prompt-slots prefix.
 */
export function withWorkspaceSnapshotPrefix(content: string): string {
  if (content.startsWith('Workspace snapshot:')) return content
  return `Workspace snapshot:\n${content}`
}
