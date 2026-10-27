import type { VfsSnapshotV1 } from '@/lib/mothership/generated/vfs-snapshot-v1'

/** Default TTL for treating a stamped snapshot as still fresh. */
export const SNAPSHOT_FRESHNESS_MAX_AGE_MS = 5 * 60_000

export interface WorkspaceSnapshotMeta {
  generatedAt: string
  contentRevision: string
  workspaceId?: string
}

/** Snapshot + markdown inventory with optional Local freshness stamps. */
export interface StampedWorkspaceSnapshotBundle {
  markdown: string
  snapshot: VfsSnapshotV1
  generatedAt?: string
  contentRevision?: string
}

/**
 * Stable content revision for a VFS snapshot (FNV-1a over canonical JSON).
 * Prefer {@link computeContentRevisionFromText} when markdown is already available —
 * JSON.stringify of a large snapshot is multi-second CPU on big workspaces.
 */
export function computeSnapshotContentRevision(snapshot: VfsSnapshotV1): string {
  return computeContentRevisionFromText(JSON.stringify(snapshot))
}

/**
 * FNV-1a content revision over an already-materialized string (e.g. inventory markdown).
 */
export function computeContentRevisionFromText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * Ensures a snapshot bundle carries freshness metadata.
 */
export function stampWorkspaceSnapshotBundle(
  bundle: StampedWorkspaceSnapshotBundle
): StampedWorkspaceSnapshotBundle &
  Required<Pick<StampedWorkspaceSnapshotBundle, 'generatedAt' | 'contentRevision'>> {
  const generatedAt =
    typeof bundle.generatedAt === 'string' && bundle.generatedAt.trim()
      ? bundle.generatedAt.trim()
      : new Date().toISOString()
  const existingRevision =
    typeof bundle.contentRevision === 'string' && bundle.contentRevision.trim()
      ? bundle.contentRevision.trim()
      : null
  // Prefer hashing markdown (already a string from mothership) over stringifying
  // the full VFS object — that stringify dominated contextBuildMs on large workspaces.
  const contentRevision =
    existingRevision ??
    (bundle.markdown.trim()
      ? computeContentRevisionFromText(bundle.markdown)
      : computeSnapshotContentRevision(bundle.snapshot))
  return {
    ...bundle,
    generatedAt,
    contentRevision,
  }
}

/**
 * True when meta is recent and matches the expected content revision.
 */
export function isSnapshotBundleFresh(
  meta: WorkspaceSnapshotMeta | null | undefined,
  options: {
    contentRevision?: string
    nowMs?: number
    maxAgeMs?: number
  } = {}
): boolean {
  if (!meta?.generatedAt?.trim() || !meta.contentRevision?.trim()) return false
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? SNAPSHOT_FRESHNESS_MAX_AGE_MS
  const generatedMs = Date.parse(meta.generatedAt)
  if (!Number.isFinite(generatedMs)) return false
  if (nowMs - generatedMs > maxAgeMs) return false
  if (options.contentRevision && options.contentRevision !== meta.contentRevision) return false
  return true
}

/**
 * Builds chat-config meta from a stamped bundle.
 */
export function toWorkspaceSnapshotMeta(
  bundle: StampedWorkspaceSnapshotBundle
): WorkspaceSnapshotMeta {
  const stamped = stampWorkspaceSnapshotBundle(bundle)
  return {
    generatedAt: stamped.generatedAt,
    contentRevision: stamped.contentRevision,
  }
}
