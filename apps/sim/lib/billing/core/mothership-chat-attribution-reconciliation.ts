import { createWriteStream, type WriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { db } from '@sim/db'
import { usageLog } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { isRecordLike } from '@sim/utils/object'
import { sql } from 'drizzle-orm'
import {
  MOTHERSHIP_CHAT_ATTRIBUTION_SOURCES,
  parseUpdateCostBillingMessageId,
} from '@/lib/billing/core/usage-attribution-backfill'

const logger = createLogger('MothershipChatAttributionReconciliation')

export type ReconciliationMode = 'audit' | 'dry-run' | 'apply' | 'verify' | 'rollback'

export interface MothershipChatAttributionScope {
  workspaceId?: string
  sources?: readonly string[]
  /** Inclusive lower bound on coalesce(occurred_at, created_at). */
  startAt?: Date
  /** Exclusive upper bound on coalesce(occurred_at, created_at). */
  endAt?: Date
}

export interface MothershipChatAttributionReconciliationOptions {
  mode: ReconciliationMode
  scope?: MothershipChatAttributionScope
  batchSize?: number
  maxBatches?: number
  /** NDJSON path for shadow (dry-run) or apply artifacts. */
  artifactPath?: string
  /** Required for rollback — NDJSON produced by a prior --apply. */
  rollbackFrom?: string
  /** Fuzzy window used only for reporting unmatched populations (never applied). */
  fuzzyReportWindowSeconds?: number
  log?: (message: string) => void
}

export interface CostInvariantSnapshot {
  rowCount: number
  sumCost: string
  sumRawCost: string
  sumBillableCost: string
  bySource: Array<{
    source: string
    rowCount: number
    sumCost: string
    sumRawCost: string
    sumBillableCost: string
  }>
}

export interface AttributionMatchCandidate {
  id: string
  eventKey: string | null
  source: string
  chatId: string
  runId: string | null
  strategy: 'update-cost-event-key' | 'existing-run-id' | 'run-window-unique'
  /** When message and stream both resolve but disagree. */
  ambiguous?: boolean
}

export interface ReconciliationPopulationReport {
  pendingMissingChatId: number
  exactUpdateCostMatches: number
  exactRunIdMatches: number
  /** Local copilot SHA256 rows matched to exactly one copilot_run in the time window. */
  exactRunWindowUniqueMatches: number
  ambiguousMessageStreamDisagreement: number
  fuzzyUnique: number
  fuzzyAmbiguous: number
  orphanUnmatched: number
  unrecoverableSha256: number
}

export interface MothershipChatAttributionReconciliationResult {
  mode: ReconciliationMode
  applied: number
  wouldApply: number
  batches: number
  populations: ReconciliationPopulationReport
  beforeCosts: CostInvariantSnapshot
  afterCosts?: CostInvariantSnapshot
  costInvariantOk?: boolean
  artifactPath?: string
}

const DEFAULT_BATCH_SIZE = 2000
const DEFAULT_FUZZY_REPORT_WINDOW_SECONDS = 120

/** postgres-js driver returns row objects at numeric indices with a `count` field. */
export function queryRows<T>(result: T[] & { count?: number }): T[] {
  const n = result.count ?? 0
  const rows: T[] = []
  for (let i = 0; i < n; i++) {
    const row = result[i]
    if (row != null) rows.push(row)
  }
  return rows
}

function mothershipSourceList(sources?: readonly string[]) {
  const list = sources?.length ? sources : MOTHERSHIP_CHAT_ATTRIBUTION_SOURCES
  return sql.join(
    list.map((source) => sql`${source}`),
    sql`, `
  )
}

function scopeSql(scope?: MothershipChatAttributionScope) {
  return sql`
    ${scope?.workspaceId ? sql`AND ul.workspace_id = ${scope.workspaceId}` : sql``}
    ${scope?.startAt ? sql`AND coalesce(ul.occurred_at, ul.created_at) >= ${scope.startAt}` : sql``}
    ${scope?.endAt ? sql`AND coalesce(ul.occurred_at, ul.created_at) < ${scope.endAt}` : sql``}
  `
}

export async function snapshotScopedCosts(
  scope?: MothershipChatAttributionScope
): Promise<CostInvariantSnapshot> {
  const totals = queryRows(
    await db.execute<{
      row_count: string
      sum_cost: string
      sum_raw_cost: string
      sum_billable_cost: string
    }>(sql`
      SELECT
        count(*)::text AS row_count,
        coalesce(sum(ul.cost::numeric), 0)::text AS sum_cost,
        coalesce(sum(coalesce(ul.raw_cost, ul.cost)::numeric), 0)::text AS sum_raw_cost,
        coalesce(sum(coalesce(ul.billable_cost, ul.cost)::numeric), 0)::text AS sum_billable_cost
      FROM usage_log ul
      WHERE ul.source IN (${mothershipSourceList(scope?.sources)})
        ${scopeSql(scope)}
    `)
  )

  const bySource = queryRows(
    await db.execute<{
      source: string
      row_count: string
      sum_cost: string
      sum_raw_cost: string
      sum_billable_cost: string
    }>(sql`
      SELECT
        ul.source,
        count(*)::text AS row_count,
        coalesce(sum(ul.cost::numeric), 0)::text AS sum_cost,
        coalesce(sum(coalesce(ul.raw_cost, ul.cost)::numeric), 0)::text AS sum_raw_cost,
        coalesce(sum(coalesce(ul.billable_cost, ul.cost)::numeric), 0)::text AS sum_billable_cost
      FROM usage_log ul
      WHERE ul.source IN (${mothershipSourceList(scope?.sources)})
        ${scopeSql(scope)}
      GROUP BY ul.source
      ORDER BY ul.source
    `)
  )

  return {
    rowCount: Number.parseInt(totals[0]?.row_count ?? '0', 10),
    sumCost: totals[0]?.sum_cost ?? '0',
    sumRawCost: totals[0]?.sum_raw_cost ?? '0',
    sumBillableCost: totals[0]?.sum_billable_cost ?? '0',
    bySource: bySource.map((row) => ({
      source: row.source,
      rowCount: Number.parseInt(row.row_count, 10),
      sumCost: row.sum_cost,
      sumRawCost: row.sum_raw_cost,
      sumBillableCost: row.sum_billable_cost,
    })),
  }
}

export function costsMatch(a: CostInvariantSnapshot, b: CostInvariantSnapshot): boolean {
  if (
    a.rowCount !== b.rowCount ||
    a.sumCost !== b.sumCost ||
    a.sumRawCost !== b.sumRawCost ||
    a.sumBillableCost !== b.sumBillableCost
  ) {
    return false
  }
  if (a.bySource.length !== b.bySource.length) return false
  for (let i = 0; i < a.bySource.length; i++) {
    const left = a.bySource[i]
    const right = b.bySource[i]
    if (
      !left ||
      !right ||
      left.source !== right.source ||
      left.rowCount !== right.rowCount ||
      left.sumCost !== right.sumCost ||
      left.sumRawCost !== right.sumRawCost ||
      left.sumBillableCost !== right.sumBillableCost
    ) {
      return false
    }
  }
  return true
}

async function countPendingMissingChatId(scope?: MothershipChatAttributionScope): Promise<number> {
  const rows = queryRows(
    await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM usage_log ul
      WHERE ul.chat_id IS NULL
        AND ul.source IN (${mothershipSourceList(scope?.sources)})
        ${scopeSql(scope)}
    `)
  )
  return Number.parseInt(rows[0]?.count ?? '0', 10)
}

/**
 * Exact strategy 1: update-cost event keys → message/stream id.
 * Message and stream lookups must agree when both resolve; disagreements are
 * classified ambiguous and never applied.
 */
export async function fetchExactUpdateCostMatches(
  batchSize: number,
  scope?: MothershipChatAttributionScope,
  offset = 0
): Promise<{ matches: AttributionMatchCandidate[]; ambiguous: number }> {
  const rows = queryRows(
    await db.execute<{
      id: string
      event_key: string
      source: string
      message_chat_id: string | null
      stream_chat_id: string | null
      stream_run_id: string | null
      existing_run_id: string | null
    }>(sql`
      SELECT
        ul.id,
        ul.event_key,
        ul.source,
        m.chat_id AS message_chat_id,
        r.chat_id AS stream_chat_id,
        r.id AS stream_run_id,
        ul.run_id AS existing_run_id
      FROM usage_log ul
      LEFT JOIN LATERAL (
        SELECT cm.chat_id
        FROM copilot_messages cm
        INNER JOIN copilot_chats cc ON cc.id = cm.chat_id
        WHERE cm.message_id = substring(ul.event_key from '^update-cost:(.+)-billing$')
          AND (ul.user_id IS NULL OR cc.user_id = ul.user_id)
          AND (ul.workspace_id IS NULL OR cc.workspace_id = ul.workspace_id)
        LIMIT 1
      ) m ON true
      LEFT JOIN LATERAL (
        SELECT cr.id, cr.chat_id
        FROM copilot_runs cr
        WHERE cr.stream_id = substring(ul.event_key from '^update-cost:(.+)-billing$')
          AND (ul.user_id IS NULL OR cr.user_id = ul.user_id)
          AND (ul.workspace_id IS NULL OR cr.workspace_id = ul.workspace_id)
        LIMIT 1
      ) r ON true
      WHERE ul.chat_id IS NULL
        AND ul.source IN (${mothershipSourceList(scope?.sources)})
        AND ul.event_key ~ '^update-cost:.+-billing$'
        AND (m.chat_id IS NOT NULL OR r.chat_id IS NOT NULL)
        ${scopeSql(scope)}
      ORDER BY ul.created_at ASC, ul.id ASC
      LIMIT ${batchSize}
      OFFSET ${offset}
    `)
  )

  const matches: AttributionMatchCandidate[] = []
  let ambiguous = 0
  for (const row of rows) {
    const messageChatId = row.message_chat_id
    const streamChatId = row.stream_chat_id
    if (messageChatId && streamChatId && messageChatId !== streamChatId) {
      ambiguous += 1
      continue
    }
    const chatId = messageChatId ?? streamChatId
    if (!chatId) continue
    matches.push({
      id: row.id,
      eventKey: row.event_key,
      source: row.source,
      chatId,
      runId: row.existing_run_id ?? row.stream_run_id,
      strategy: 'update-cost-event-key',
    })
  }
  return { matches, ambiguous }
}

/** Exact strategy 2: run_id present, chat_id null → copilot_runs.chat_id. */
export async function fetchExactRunIdMatches(
  batchSize: number,
  scope?: MothershipChatAttributionScope,
  offset = 0
): Promise<AttributionMatchCandidate[]> {
  const rows = queryRows(
    await db.execute<{
      id: string
      event_key: string | null
      source: string
      chat_id: string
      run_id: string
    }>(sql`
      SELECT
        ul.id,
        ul.event_key,
        ul.source,
        cr.chat_id,
        ul.run_id
      FROM usage_log ul
      INNER JOIN copilot_runs cr ON cr.id = ul.run_id
      WHERE ul.chat_id IS NULL
        AND ul.run_id IS NOT NULL
        AND ul.source IN (${mothershipSourceList(scope?.sources)})
        AND (ul.user_id IS NULL OR cr.user_id = ul.user_id)
        ${scopeSql(scope)}
      ORDER BY ul.created_at ASC, ul.id ASC
      LIMIT ${batchSize}
      OFFSET ${offset}
    `)
  )

  return rows.map((row) => ({
    id: row.id,
    eventKey: row.event_key,
    source: row.source,
    chatId: row.chat_id,
    runId: row.run_id,
    strategy: 'existing-run-id' as const,
  }))
}

/**
 * Exact strategy 3: legacy Local `copilot` rows (typically SHA256 event keys) with
 * no chat/run stamped at write time. Applies only when exactly one
 * `copilot_runs` row matches user + workspace + occurred_at within the window.
 */
export async function fetchExactRunWindowUniqueMatches(
  batchSize: number,
  scope?: MothershipChatAttributionScope,
  windowSeconds = DEFAULT_FUZZY_REPORT_WINDOW_SECONDS,
  offset = 0
): Promise<AttributionMatchCandidate[]> {
  const rows = queryRows(
    await db.execute<{
      id: string
      event_key: string | null
      source: string
      chat_id: string
      run_id: string
    }>(sql`
      WITH pending AS (
        SELECT
          ul.id,
          ul.event_key,
          ul.source,
          ul.user_id,
          ul.workspace_id,
          coalesce(ul.occurred_at, ul.created_at) AS occurred_at
        FROM usage_log ul
        WHERE ul.chat_id IS NULL
          AND ul.run_id IS NULL
          AND ul.source IN (${mothershipSourceList(scope?.sources)})
          AND ul.workspace_id IS NOT NULL
          AND ul.user_id IS NOT NULL
          AND (ul.event_key IS NULL OR ul.event_key !~ '^update-cost:.+-billing$')
          ${scopeSql(scope)}
      ),
      candidates AS (
        SELECT
          p.id,
          p.event_key,
          p.source,
          cr.chat_id,
          cr.id AS run_id,
          count(*) OVER (PARTITION BY p.id) AS match_count
        FROM pending p
        INNER JOIN copilot_runs cr
          ON cr.user_id = p.user_id
         AND cr.workspace_id = p.workspace_id
         AND cr.started_at BETWEEN p.occurred_at - make_interval(secs => ${windowSeconds})
                              AND p.occurred_at + make_interval(secs => ${windowSeconds})
      )
      SELECT id, event_key, source, chat_id, run_id
      FROM candidates
      WHERE match_count = 1
      ORDER BY id ASC
      LIMIT ${batchSize}
      OFFSET ${offset}
    `)
  )

  return rows.map((row) => ({
    id: row.id,
    eventKey: row.event_key,
    source: row.source,
    chatId: row.chat_id,
    runId: row.run_id,
    strategy: 'run-window-unique' as const,
  }))
}

async function reportFuzzyAndOrphanPopulations(
  scope: MothershipChatAttributionScope | undefined,
  windowSeconds: number
): Promise<
  Pick<
    ReconciliationPopulationReport,
    'fuzzyUnique' | 'fuzzyAmbiguous' | 'orphanUnmatched' | 'unrecoverableSha256'
  >
> {
  const fuzzy = queryRows(
    await db.execute<{ unique_count: string; ambiguous_count: string }>(sql`
      WITH pending AS (
        SELECT
          ul.id,
          ul.user_id,
          ul.workspace_id,
          coalesce(ul.occurred_at, ul.created_at) AS occurred_at
        FROM usage_log ul
        WHERE ul.chat_id IS NULL
          AND ul.source IN (${mothershipSourceList(scope?.sources)})
          AND ul.workspace_id IS NOT NULL
          AND (ul.event_key IS NULL OR ul.event_key !~ '^update-cost:.+-billing$')
          AND ul.run_id IS NULL
          ${scopeSql(scope)}
      ),
      matched AS (
        SELECT p.id, count(*) AS match_count
        FROM pending p
        INNER JOIN copilot_runs cr
          ON cr.user_id = p.user_id
         AND cr.workspace_id = p.workspace_id
         AND cr.started_at BETWEEN p.occurred_at - make_interval(secs => ${windowSeconds})
                              AND p.occurred_at + make_interval(secs => ${windowSeconds})
        GROUP BY p.id
      )
      SELECT
        coalesce(sum(case when match_count = 1 then 1 else 0 end), 0)::text AS unique_count,
        coalesce(sum(case when match_count > 1 then 1 else 0 end), 0)::text AS ambiguous_count
      FROM matched
    `)
  )

  const sha = queryRows(
    await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM usage_log ul
      WHERE ul.chat_id IS NULL
        AND ul.source IN (${mothershipSourceList(scope?.sources)})
        AND ul.event_key ~ '^[0-9a-f]{64}$'
        AND ul.run_id IS NULL
        ${scopeSql(scope)}
    `)
  )

  const orphan = queryRows(
    await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM usage_log ul
      WHERE ul.chat_id IS NULL
        AND ul.source IN (${mothershipSourceList(scope?.sources)})
        AND ul.run_id IS NULL
        AND (ul.event_key IS NULL OR ul.event_key !~ '^update-cost:.+-billing$')
        ${scopeSql(scope)}
    `)
  )

  return {
    fuzzyUnique: Number.parseInt(fuzzy[0]?.unique_count ?? '0', 10),
    fuzzyAmbiguous: Number.parseInt(fuzzy[0]?.ambiguous_count ?? '0', 10),
    orphanUnmatched: Number.parseInt(orphan[0]?.count ?? '0', 10),
    unrecoverableSha256: Number.parseInt(sha[0]?.count ?? '0', 10),
  }
}

async function applyExactMatches(matches: AttributionMatchCandidate[]): Promise<number> {
  if (matches.length === 0) return 0
  let updated = 0
  await Promise.all(
    matches.map(async (row) => {
      const result = await db
        .update(usageLog)
        .set({
          chatId: row.chatId,
          ...(row.runId ? { runId: row.runId } : {}),
        })
        .where(sql`${usageLog.id} = ${row.id} AND ${usageLog.chatId} IS NULL`)
        .returning({ id: usageLog.id })
      updated += result.length
    })
  )
  return updated
}

function openArtifact(path: string | undefined): WriteStream | null {
  if (!path) return null
  return createWriteStream(path, { flags: 'a' })
}

function writeArtifactLine(stream: WriteStream | null, value: unknown) {
  if (!stream) return
  stream.write(`${JSON.stringify(value)}\n`)
}

async function closeArtifact(stream: WriteStream | null) {
  if (!stream) return
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
}

/**
 * Exact-only mothership chat_id attribution reconciliation.
 * Applies update-cost keys, existing run_id joins, and run-window-unique matches
 * (exactly one copilot_run in the time window). Never applies ambiguous time-window
 * matches.
 */
export async function runMothershipChatAttributionReconciliation(
  options: MothershipChatAttributionReconciliationOptions
): Promise<MothershipChatAttributionReconciliationResult> {
  const log = options.log ?? ((message: string) => logger.info(message))
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY
  const scope = options.scope
  const mode = options.mode
  const windowSeconds = options.fuzzyReportWindowSeconds ?? DEFAULT_FUZZY_REPORT_WINDOW_SECONDS

  if (mode === 'rollback') {
    if (!options.rollbackFrom) {
      throw new Error('--rollback requires --rollback-from=<apply-artifact.ndjson>')
    }
    return rollbackFromArtifact(options.rollbackFrom, scope, log)
  }

  const beforeCosts = await snapshotScopedCosts(scope)
  const pendingBefore = await countPendingMissingChatId(scope)
  log(
    `Mothership chat attribution [${mode}] pending=${pendingBefore} rows=${beforeCosts.rowCount} sum(cost)=${beforeCosts.sumCost}`
  )

  const artifact = openArtifact(options.artifactPath)
  writeArtifactLine(artifact, {
    type: 'meta',
    mode,
    at: new Date().toISOString(),
    scope: scope ?? null,
    beforeCosts,
  })

  let applied = 0
  let wouldApply = 0
  let batches = 0
  let ambiguousMessageStreamDisagreement = 0
  let exactUpdateCostMatches = 0
  let exactRunIdMatches = 0
  let exactRunWindowUniqueMatches = 0

  const shouldWrite = mode === 'apply'
  const shouldPaginateFully = mode === 'audit' || mode === 'dry-run' || mode === 'apply'

  if (shouldPaginateFully) {
    // Apply mode re-queries chat_id IS NULL each batch (no offset). Audit/dry-run
    // paginate with offset so the full scope is reported without mutation.
    const useOffset = !shouldWrite

    for (let offset = 0, batch = 0; batch < maxBatches; batch++) {
      const { matches, ambiguous } = await fetchExactUpdateCostMatches(
        batchSize,
        scope,
        useOffset ? offset : 0
      )
      ambiguousMessageStreamDisagreement += ambiguous
      if (matches.length === 0 && ambiguous === 0) break

      exactUpdateCostMatches += matches.length
      batches += 1
      for (const match of matches) {
        writeArtifactLine(artifact, { type: 'match', ...match })
        if (!parseUpdateCostBillingMessageId(match.eventKey)) {
          throw new Error(`Failed to parse update-cost event_key: ${match.eventKey}`)
        }
      }

      if (shouldWrite) {
        const n = await applyExactMatches(matches)
        applied += n
        log(`  update-cost batch ${batches}: applied ${n}`)
      } else {
        wouldApply += matches.length
        offset += batchSize
        log(
          `  update-cost batch ${batches}: would apply ${matches.length} (ambiguous=${ambiguous})`
        )
      }

      if (matches.length + ambiguous < batchSize) break
    }

    for (let offset = 0, batch = 0; batch < maxBatches; batch++) {
      const matches = await fetchExactRunIdMatches(batchSize, scope, useOffset ? offset : 0)
      if (matches.length === 0) break

      exactRunIdMatches += matches.length
      batches += 1
      for (const match of matches) {
        writeArtifactLine(artifact, { type: 'match', ...match })
      }

      if (shouldWrite) {
        const n = await applyExactMatches(matches)
        applied += n
        log(`  run-id batch ${batches}: applied ${n}`)
      } else {
        wouldApply += matches.length
        offset += batchSize
        log(`  run-id batch ${batches}: would apply ${matches.length}`)
      }

      if (matches.length < batchSize) break
    }

    for (let offset = 0, batch = 0; batch < maxBatches; batch++) {
      const matches = await fetchExactRunWindowUniqueMatches(
        batchSize,
        scope,
        windowSeconds,
        useOffset ? offset : 0
      )
      if (matches.length === 0) break

      exactRunWindowUniqueMatches += matches.length
      batches += 1
      for (const match of matches) {
        writeArtifactLine(artifact, { type: 'match', ...match })
      }

      if (shouldWrite) {
        const n = await applyExactMatches(matches)
        applied += n
        log(`  run-window-unique batch ${batches}: applied ${n}`)
      } else {
        wouldApply += matches.length
        offset += batchSize
        log(`  run-window-unique batch ${batches}: would apply ${matches.length}`)
      }

      if (matches.length < batchSize) break
    }
  }

  const fuzzyOrphan = await reportFuzzyAndOrphanPopulations(scope, windowSeconds)
  const pendingAfter = await countPendingMissingChatId(scope)
  const afterCosts = await snapshotScopedCosts(scope)
  const costInvariantOk = costsMatch(beforeCosts, afterCosts)

  const populations: ReconciliationPopulationReport = {
    pendingMissingChatId: pendingAfter,
    exactUpdateCostMatches,
    exactRunIdMatches,
    exactRunWindowUniqueMatches,
    ambiguousMessageStreamDisagreement,
    ...fuzzyOrphan,
  }

  writeArtifactLine(artifact, {
    type: 'summary',
    populations,
    beforeCosts,
    afterCosts,
    costInvariantOk,
    applied,
    wouldApply,
  })
  await closeArtifact(artifact)

  log(
    `Summary: exact=${exactUpdateCostMatches + exactRunIdMatches + exactRunWindowUniqueMatches} applied=${applied} wouldApply=${wouldApply} pending=${pendingAfter} runWindowUnique=${exactRunWindowUniqueMatches} fuzzyUnique=${fuzzyOrphan.fuzzyUnique} ambiguous=${ambiguousMessageStreamDisagreement + fuzzyOrphan.fuzzyAmbiguous} orphan=${fuzzyOrphan.orphanUnmatched} sha256=${fuzzyOrphan.unrecoverableSha256} costOk=${costInvariantOk}`
  )

  if (!costInvariantOk) {
    throw new Error(
      `Cost invariant failed: before sum(cost)=${beforeCosts.sumCost} after=${afterCosts.sumCost}`
    )
  }

  return {
    mode,
    applied,
    wouldApply,
    batches,
    populations,
    beforeCosts,
    afterCosts,
    costInvariantOk,
    artifactPath: options.artifactPath,
  }
}

async function rollbackFromArtifact(
  artifactPath: string,
  scope: MothershipChatAttributionScope | undefined,
  log: (message: string) => void
): Promise<MothershipChatAttributionReconciliationResult> {
  const beforeCosts = await snapshotScopedCosts(scope)
  let text: string
  try {
    text = await readFile(artifactPath, 'utf8')
  } catch (error) {
    if (isRecordLike(error) && error.code === 'ENOENT') {
      throw new Error(`Rollback artifact not found: ${artifactPath}`)
    }
    throw error
  }
  const ids: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const parsed = JSON.parse(line) as { type?: string; id?: string }
    if (parsed.type === 'match' && typeof parsed.id === 'string') {
      ids.push(parsed.id)
    }
  }

  let applied = 0
  const chunkSize = 500
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const result = queryRows(
      await db.execute<{ id: string }>(sql`
        UPDATE usage_log
        SET chat_id = NULL
        WHERE id IN (${sql.join(
          chunk.map((id) => sql`${id}`),
          sql`, `
        )})
          AND chat_id IS NOT NULL
        RETURNING id
      `)
    )
    applied += result.length
  }

  const afterCosts = await snapshotScopedCosts(scope)
  const costInvariantOk = costsMatch(beforeCosts, afterCosts)
  log(`Rollback cleared chat_id on ${applied} rows; costOk=${costInvariantOk}`)
  if (!costInvariantOk) {
    throw new Error('Cost invariant failed after rollback')
  }

  return {
    mode: 'rollback',
    applied,
    wouldApply: 0,
    batches: Math.ceil(ids.length / chunkSize),
    populations: {
      pendingMissingChatId: await countPendingMissingChatId(scope),
      exactUpdateCostMatches: 0,
      exactRunIdMatches: 0,
      exactRunWindowUniqueMatches: 0,
      ambiguousMessageStreamDisagreement: 0,
      fuzzyUnique: 0,
      fuzzyAmbiguous: 0,
      orphanUnmatched: 0,
      unrecoverableSha256: 0,
    },
    beforeCosts,
    afterCosts,
    costInvariantOk,
    artifactPath,
  }
}
