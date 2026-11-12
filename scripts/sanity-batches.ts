#!/usr/bin/env bun
/**
 * Picks the Arena unit-test batch a diff should run.
 *
 * After a merge, the full `bun run test` suite is the gate and the wrong
 * quick check. This maps changed paths onto the two Arena batches that
 * already exist: exclusive trees, and the short allowlist of tests that
 * guard Arena edits inside upstream files. Integration and live tests stay
 * out; they need Postgres or a provider.
 *
 *   bun run scripts/sanity-batches.ts suggest [--base <ref>]
 *   bun run scripts/sanity-batches.ts affected [--base <ref>]
 *   bun run scripts/sanity-batches.ts arena
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { compareStrings } from '@sim/utils/string'

const ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_BASE = 'origin/version-6.2-main'
/** A diff larger than this is treated as a sync even when no seam path changed. */
const SYNC_FILE_THRESHOLD = 40

const BATCH_ORDER = ['arena-exclusive', 'arena-customized'] as const

type BatchId = (typeof BATCH_ORDER)[number]

/**
 * Trees and files that do not exist upstream. A hit selects the exclusive
 * batch. The batch then runs every unit test under the directory roots,
 * not only the file that changed.
 */
const EXCLUSIVE_TRIGGER_PREFIXES = [
  'apps/sim/local-copilot/',
  'apps/sim/lib/billing/arena/',
  'apps/sim/lib/arena/',
  'apps/sim/lib/arena-utils/',
  'apps/sim/lib/auth/arena-',
  'apps/sim/lib/development/arena/',
  'apps/sim/lib/users/arena-timezone',
  'apps/sim/app/workspace/arena-general-settings/',
  'apps/sim/app/api/arena/',
  'apps/sim/app/api/tools/arena/',
  'apps/sim/tools/arena/',
  'apps/sim/tools/arena-development/',
  'apps/sim/tools/bing_ads/',
  'apps/sim/tools/facebook_ads/',
  'apps/sim/tools/figma/',
  'apps/sim/tools/image_fusion/',
  'apps/sim/tools/p2_docs/',
  'apps/sim/tools/skyvern/',
  'apps/sim/tools/spyfu/',
  'apps/sim/tools/unipile/',
  'apps/sim/tools/semrush/',
  'apps/sim/tools/airweave/',
  'apps/sim/lib/mothership/tools/server/arena-registry.ts',
  'apps/sim/lib/mothership/tools/arena-server-tool-aliases.ts',
  'packages/db/migrations/Arena_',
]

/** Directories whose `*.test.ts(x)` files are the exclusive batch. */
const EXCLUSIVE_TEST_DIRS = [
  'apps/sim/local-copilot',
  'apps/sim/lib/billing/arena',
  'apps/sim/lib/arena',
  'apps/sim/lib/arena-utils',
  'apps/sim/lib/development/arena',
  'apps/sim/app/workspace/arena-general-settings',
  'apps/sim/app/api/arena',
  'apps/sim/app/api/tools/arena',
  'apps/sim/tools/arena',
  'apps/sim/tools/arena-development',
  'apps/sim/tools/bing_ads',
  'apps/sim/tools/facebook_ads',
  'apps/sim/tools/figma',
  'apps/sim/tools/image_fusion',
  'apps/sim/tools/p2_docs',
  'apps/sim/tools/skyvern',
  'apps/sim/tools/spyfu',
  'apps/sim/tools/unipile',
  'apps/sim/tools/semrush',
  'apps/sim/tools/airweave',
]

/**
 * Upstream areas Arena changed. A hit selects the customized batch, which
 * always runs the allowlist below rather than every test beside the file.
 */
const CUSTOMIZED_SEAM_PREFIXES = [
  'apps/sim/app/(interfaces)/chat/',
  'apps/sim/app/api/chat/',
  'apps/sim/executor/execution/',
  'apps/sim/components/settings/navigation.ts',
  'apps/sim/components/settings/navigation.test.ts',
  'apps/sim/tools/shopify/',
  'apps/sim/tools/google_ads/',
  'apps/sim/tools/google_slides/',
  'apps/sim/tools/slack/',
  'apps/sim/tools/gmail/',
  'apps/sim/tools/image_generation/',
  'apps/sim/tools/image-generate-direct',
  'apps/sim/tools/image-generation-wrapper-v2-direct',
  'apps/sim/blocks/blocks/image_generator',
  'apps/sim/blocks/utils.ts',
  'apps/sim/blocks/utils.test.ts',
  'apps/sim/lib/image-generation/',
  'apps/sim/app/api/mothership/chats/[chatId]/fork/',
  'apps/sim/lib/auth/legacy-session-cookie-clears',
]

/** Tests that guard Arena edits inside upstream files. Shared files run whole. */
const CUSTOMIZED_TEST_FILES = [
  'apps/sim/tools/google_ads/search.test.ts',
  'apps/sim/tools/shopify/list_customers.test.ts',
  'apps/sim/blocks/utils.test.ts',
  'apps/sim/executor/execution/engine.test.ts',
  'apps/sim/components/settings/navigation.test.ts',
  'apps/sim/app/api/mothership/chats/[chatId]/fork/route.test.ts',
  'apps/sim/app/api/chat/[identifier]/route.test.ts',
  'apps/sim/tools/slack/oauth-scopes.test.ts',
  'apps/sim/tools/google_slides/create-from-template-table.test.ts',
  'apps/sim/tools/image-generate-direct.test.ts',
  'apps/sim/tools/image-generation-wrapper-v2-direct.test.ts',
  'apps/sim/tools/image_generation/utils.test.ts',
  'apps/sim/tools/image_generation/wrapper-ids.test.ts',
  'apps/sim/blocks/blocks/image_generator.test.ts',
  'apps/sim/lib/auth/legacy-session-cookie-clears.test.ts',
]

const IMAGE_GENERATION_TEST_DIR = 'apps/sim/lib/image-generation'

/**
 * A clean merge can drop an Arena registration without an edit under a
 * feature folder. These files select both batches and the sync gates.
 */
const REGISTRY_FILES = [
  'apps/sim/blocks/registry-maps.ts',
  'apps/sim/tools/registry.ts',
  'apps/sim/lib/mothership/tools/server/router.ts',
]

/** Diff prefixes that also need the output-contract and block-registry commands. */
const SYNC_GATE_PREFIXES = [
  'apps/sim/blocks/',
  'apps/sim/tools/registry.ts',
  'apps/sim/serializer/',
  'packages/db/migrations/',
  'apps/sim/lib/mothership/tools/server/router.ts',
]

const SYNC_GATE_COMMANDS = [
  'bun run apps/sim/scripts/diff-block-output-contracts.ts diff /tmp/output-contracts-before.json',
  'bun run apps/sim/scripts/check-block-registry.ts origin/version-6.2-main',
]

const BILLING_INTEGRATION_DIR = 'apps/sim/lib/billing/arena'
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

export interface ClassifyOptions {
  /** Current branch. `upstream-sync/*` selects both Arena batches. */
  branch?: string
  /** Run both Arena batches with no diff. Used by `test:sanity:arena`. */
  forceBoth?: boolean
}

export interface SanityPlan {
  batches: BatchId[]
  /** Repo-relative unit tests. Integration and live files are omitted. */
  vitestFiles: string[]
  /** Arena billing integration files. Named, not executed. */
  optionalIntegrationFiles: string[]
  syncGateCommands: string[]
  /** Changed paths that hit a batch, in batch priority order. */
  reasons: { batch: BatchId; paths: string[] }[]
  /** Seam, exclusive, and registry paths inside a sync-sized diff. */
  seamPaths: string[]
  /** Set when the branch or the file count forces both Arena batches. */
  syncDetail: string | null
  fileCount: number
}

function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '')
}

function matchesPrefix(file: string, prefix: string): boolean {
  return normalizeRepoPath(file).startsWith(prefix)
}

function isUnitTest(name: string): boolean {
  if (name.endsWith('.live.test.ts') || name.endsWith('.live.test.tsx')) return false
  if (name.endsWith('.integration.ts')) return false
  if (name.endsWith('.integration.test.ts') || name.endsWith('.integration.test.tsx')) return false
  return name.endsWith('.test.ts') || name.endsWith('.test.tsx')
}

function isBillingIntegration(name: string): boolean {
  return (
    name.endsWith('.integration.ts') ||
    name.endsWith('.integration.test.ts') ||
    name.endsWith('.integration.test.tsx')
  )
}

function walk(dir: string, visit: (relativePath: string, name: string) => void): void {
  const absolute = path.join(ROOT, dir)
  if (!existsSync(absolute)) return
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const relativePath = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(relativePath, visit)
    else visit(relativePath, entry.name)
  }
}

function exclusiveUnitTests(): string[] {
  const files: string[] = []
  for (const dir of EXCLUSIVE_TEST_DIRS) {
    walk(dir, (relativePath, name) => {
      if (isUnitTest(name)) files.push(relativePath)
    })
  }
  const authDir = path.join(ROOT, 'apps/sim/lib/auth')
  if (existsSync(authDir)) {
    for (const entry of readdirSync(authDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith('arena-') || !isUnitTest(entry.name)) continue
      files.push(`apps/sim/lib/auth/${entry.name}`)
    }
  }
  const timezone = 'apps/sim/lib/users/arena-timezone.test.ts'
  if (existsSync(path.join(ROOT, timezone))) files.push(timezone)
  return files
}

function customizedUnitTests(): string[] {
  const files = CUSTOMIZED_TEST_FILES.filter((file) => existsSync(path.join(ROOT, file)))
  walk(IMAGE_GENERATION_TEST_DIR, (relativePath, name) => {
    if (isUnitTest(name)) files.push(relativePath)
  })
  return files
}

function billingIntegrationFiles(): string[] {
  const files: string[] = []
  walk(BILLING_INTEGRATION_DIR, (relativePath, name) => {
    if (isBillingIntegration(name)) files.push(relativePath)
  })
  return files
}

function uniqueSorted(files: string[]): string[] {
  return [...new Set(files)].sort(compareStrings)
}

/**
 * Maps changed repo paths to Arena batches and the Vitest files those
 * batches run. A sync-sized diff selects both batches even when no seam
 * path is in the list, because a clean merge can drop a standing seam
 * without a conflict in that file.
 */
export function classify(files: string[], options: ClassifyOptions = {}): SanityPlan {
  const changed = files.map(normalizeRepoPath)
  const branchSized = options.branch?.startsWith('upstream-sync/') === true
  const countSized = changed.length > SYNC_FILE_THRESHOLD
  const syncSized = branchSized || countSized
  const syncDetail = !syncSized
    ? null
    : branchSized && countSized
      ? `branch ${options.branch}, ${changed.length} files`
      : branchSized
        ? `branch ${options.branch}`
        : `${changed.length} files`

  const exclusivePaths = changed.filter((file) =>
    EXCLUSIVE_TRIGGER_PREFIXES.some((prefix) => matchesPrefix(file, prefix))
  )
  const customizedPaths = changed.filter((file) =>
    CUSTOMIZED_SEAM_PREFIXES.some((prefix) => matchesPrefix(file, prefix))
  )
  const registryPaths = changed.filter((file) => REGISTRY_FILES.includes(file))
  const seamPaths = uniqueSorted([...exclusivePaths, ...customizedPaths, ...registryPaths])

  const selected = new Set<BatchId>()
  if (options.forceBoth || syncSized || exclusivePaths.length > 0 || registryPaths.length > 0) {
    selected.add('arena-exclusive')
  }
  if (options.forceBoth || syncSized || customizedPaths.length > 0 || registryPaths.length > 0) {
    selected.add('arena-customized')
  }

  const batches = BATCH_ORDER.filter((batch) => selected.has(batch))
  const vitestFiles = uniqueSorted([
    ...(selected.has('arena-exclusive') ? exclusiveUnitTests() : []),
    ...(selected.has('arena-customized') ? customizedUnitTests() : []),
  ])

  const reasons = batches.map((batch) => ({
    batch,
    paths:
      batch === 'arena-exclusive'
        ? uniqueSorted([...exclusivePaths, ...registryPaths])
        : uniqueSorted([...customizedPaths, ...registryPaths]),
  }))

  const gates = changed.some((file) =>
    SYNC_GATE_PREFIXES.some((prefix) => matchesPrefix(file, prefix))
  )

  return {
    batches,
    vitestFiles,
    optionalIntegrationFiles: selected.has('arena-exclusive')
      ? uniqueSorted(billingIntegrationFiles())
      : [],
    syncGateCommands: gates ? [...SYNC_GATE_COMMANDS] : [],
    reasons,
    seamPaths,
    syncDetail,
    fileCount: changed.length,
  }
}

function formatPlan(plan: SanityPlan, command: string | null): string {
  const lines: string[] = []
  if (plan.batches.length === 0) {
    lines.push('No Arena batch matched.')
  } else {
    lines.push(`Quick sanity: ${plan.batches.join(', ')}`)
    if (command) lines.push(command)
    lines.push('Why:')
    for (const reason of plan.reasons) {
      if (plan.syncDetail) {
        lines.push(`  ${reason.batch}: sync-sized diff (${plan.syncDetail})`)
        continue
      }
      if (reason.paths.length === 0) {
        lines.push(`  ${reason.batch}: both Arena batches`)
        continue
      }
      lines.push(`  ${reason.batch}: ${reason.paths.join(', ')}`)
    }
    if (plan.syncDetail) {
      lines.push(`Sync-sized: ${plan.syncDetail}`)
      lines.push(plan.seamPaths.length === 0 ? 'Seam paths: none' : 'Seam paths:')
      for (const seam of plan.seamPaths) lines.push(`  ${seam}`)
    }
  }

  if (plan.syncGateCommands.length > 0) {
    lines.push('')
    lines.push('Also run sync gates:')
    for (const gate of plan.syncGateCommands) lines.push(gate)
  }

  if (plan.optionalIntegrationFiles.length > 0) {
    lines.push('')
    lines.push('Optional, needs Postgres (not run):')
    for (const file of plan.optionalIntegrationFiles) lines.push(file)
  }

  lines.push('')
  lines.push('Stock suite not included. bun run test remains the full gate.')
  return lines.join('\n')
}

function git(args: string[]): string | null {
  const result = gitOk(args)
  return result.ok ? result.stdout : null
}

function gitOk(args: string[]): { ok: true; stdout: string } | { ok: false } {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return { ok: false }
  return { ok: true, stdout: (result.stdout ?? '').trim() }
}

/** Paths from `git status --porcelain -uall`, including the new side of a rename. */
function porcelainPaths(status: string): string[] {
  if (!status) return []
  const paths: string[] = []
  for (const line of status.split('\n')) {
    if (!line) continue
    const payload = line.slice(3).trim()
    const renamed = payload.split(' -> ')
    paths.push(renamed[renamed.length - 1] ?? payload)
  }
  return paths
}

function changedFiles(base: string): { files: string[]; note: string | null } {
  const committed = gitOk(['diff', '--name-only', `${base}...HEAD`])
  if (!committed.ok) {
    const uncommitted = uncommittedFiles()
    if (uncommitted.length === 0) {
      return {
        files: [],
        note: `Cannot diff against '${base}', and there are no uncommitted files.`,
      }
    }
    return {
      files: uncommitted,
      note: `Cannot diff against '${base}'. Using uncommitted files.`,
    }
  }
  const committedFiles = committed.stdout ? committed.stdout.split('\n').filter(Boolean) : []
  if (committedFiles.length > 0) return { files: committedFiles, note: null }
  const uncommitted = uncommittedFiles()
  if (uncommitted.length > 0) return { files: uncommitted, note: null }
  return {
    files: [],
    note: `Nothing to classify. No commits ahead of ${base} and no uncommitted files.`,
  }
}

function uncommittedFiles(): string[] {
  const status = git(['status', '--porcelain', '-uall'])
  return uniqueSorted(porcelainPaths(status ?? ''))
}

function currentBranch(): string | undefined {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  return branch && branch !== 'HEAD' ? branch : undefined
}

function runVitest(files: string[]): number {
  const relative = files.map((file) => file.replace(/^apps\/sim\//, ''))
  const child = spawnSync('bun', ['run', '--cwd', 'apps/sim', 'test', '--', ...relative], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  return child.status ?? 1
}

function parseArgs(argv: string[]): { mode: 'suggest' | 'affected' | 'arena'; base: string } {
  const mode = argv[0]
  if (mode !== 'suggest' && mode !== 'affected' && mode !== 'arena') {
    console.error('Usage: sanity-batches.ts <suggest|affected|arena> [--base <ref>]')
    process.exit(1)
  }
  let base = DEFAULT_BASE
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]
    if (arg !== '--base') {
      console.error(`Unknown argument ${arg}`)
      process.exit(1)
    }
    const value = argv[index + 1]
    if (!value) {
      console.error('--base needs a git ref')
      process.exit(1)
    }
    base = value
    index++
  }
  return { mode, base }
}

function main(): void {
  const { mode, base } = parseArgs(process.argv.slice(2))
  if (mode === 'arena') {
    const plan = classify([], { forceBoth: true })
    console.log(formatPlan(plan, null))
    process.exit(runVitest(plan.vitestFiles))
  }

  const { files, note } = changedFiles(base)
  if (note) console.log(note)
  if (files.length === 0) {
    console.log('')
    console.log('Stock suite not included. bun run test remains the full gate.')
    process.exit(0)
  }

  const plan = classify(files, { branch: currentBranch() })
  const command = mode === 'affected' ? null : 'bun run test:sanity:affected'
  console.log(formatPlan(plan, command))
  if (mode === 'suggest' || plan.vitestFiles.length === 0) process.exit(0)
  process.exit(runVitest(plan.vitestFiles))
}

if (import.meta.main) main()
