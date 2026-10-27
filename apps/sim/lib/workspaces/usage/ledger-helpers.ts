import { dbReplica } from '@sim/db'
import {
  copilotChats,
  copilotRuns,
  organization,
  usageLog,
  user,
  workflow,
  workflowExecutionLogs,
  workspace,
} from '@sim/db/schema'
import {
  and,
  eq,
  inArray,
  isNotNull,
  notInArray,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from 'drizzle-orm'
import {
  type UsageChargeTypeValue,
  type UsageLogSourceValue,
  usageActorTypeSchema,
  usageChargeTypeSchema,
  usageLogSourceSchema,
} from '@/lib/api/contracts/workspace-usage'
import type { UsageLogSource } from '@/lib/billing/core/usage-log'
import { COPILOT_USAGE_SOURCES } from '@/lib/billing/core/usage-log'
import {
  normalizeBucketKey,
  parseDecimal,
  parseIntMetric,
  sortByBillableCostDesc,
} from '@/lib/workspaces/usage/ledger-utils'

export {
  averageBillableCostPerRun,
  normalizeBucketKey,
  parseDecimal,
  parseIntMetric,
  sortByAverageBillableCostPerRunDesc,
  sortByBillableCostDesc,
} from '@/lib/workspaces/usage/ledger-utils'

/** Cap for the most-expensive mothership/copilot chats table on usage dashboards. */
export const TOP_EXPENSIVE_COPILOT_CHATS = 25

/** Cap for most-expensive workflows on the org usage dashboard. */
export const TOP_EXPENSIVE_WORKFLOWS = 25

export const WORKFLOW_SOURCE: UsageLogSource = 'workflow'

/**
 * Synthetic By Tools bucket id for mothership / Copilot ledger *tool* rows
 * so the Usage UI shows one "Copilot tools" line.
 * Keep in sync with `COPILOT_USAGE_TOOL_BUCKET_ID` in usage `format.ts`.
 */
export const COPILOT_USAGE_TOOL_BUCKET_ID = 'copilot' as const

/**
 * Groups tool spend for By Tools analytics.
 * Prefers `usage_log.tool_name` (registry operation) when set, else `tool_id`
 * (display label / legacy rows). Copilot / mothership *tool* sources collapse to
 * {@link COPILOT_USAGE_TOOL_BUCKET_ID} ("Copilot tools"). Model spend for those
 * sources is reported separately.
 *
 * String literals are inlined (same pattern as {@link chargeTypeExpr}) so SELECT
 * and GROUP BY stay identical — parameterized CASE fragments diverge under
 * Drizzle and Postgres rejects the query.
 */
export function byToolBucketIdExpr() {
  return sql<string>`case
    when ${usageLog.source} in ('copilot', 'workspace-chat', 'mcp_copilot', 'mothership_block')
      then 'copilot'
    else coalesce(${usageLog.toolName}, ${usageLog.toolId})
  end`
}

export const PERIOD_MS: Record<'1d' | '7d' | '30d' | '90d', number> = {
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
}

export const EMPTY_USAGE_METRICS = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  invocationCount: 0,
} as const

export interface ResolvedPeriod {
  start: Date
  end: Date
}

export interface ExplicitPeriodOptions {
  startTime?: string
  endTime?: string
  period?: '1d' | '7d' | '30d' | '90d'
}

export interface UsageMetrics {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  invocationCount: number
}

/** Ranked mothership/copilot chat cost row shared by workspace and org analytics. */
export interface ExpensiveCopilotChatRow {
  workspaceId: string
  workspaceName: string | null
  chatId: string
  title: string | null
  chatType: 'mothership' | 'copilot'
  userId: string
  runCount: number
  billableCost: number
  rawCost: number
  count: number
}

export interface QueryExpensiveCopilotChatsOptions {
  /** Restricts chats (single workspace or org workspace set). */
  chatScope: SQL
  /** Ledger join filters (workspace scope + period bounds). */
  ledgerJoinConditions: SQL[]
  period: ResolvedPeriod
}

/** Ranked workflow cost row for org-wide most-expensive workflows. */
export interface ExpensiveWorkflowRow {
  workspaceId: string
  workspaceName: string | null
  workflowId: string | null
  workflowName: string | null
  executionCount: number
  billableCost: number
  rawCost: number
  count: number
}

export interface QueryExpensiveWorkflowsOptions {
  /** Restricts executions (single workspace or org workspace set). */
  executionScope: SQL
  /** Ledger join filters (workspace scope + period bounds). */
  ledgerJoinConditions: SQL[]
  period: ResolvedPeriod
}

export function ensurePeriodDate(value: unknown): Date {
  const date = coerceToDate(value)
  if (!date) {
    throw new Error('Invalid time range')
  }
  return date
}

/** Coalesced ledger clock: occurred_at when present, else created_at. */
export function ledgerOccurredAt() {
  return sql`coalesce(${usageLog.occurredAt}, ${usageLog.createdAt})`
}

/**
 * Period bounds for the coalesced ledger clock.
 * Compare against ISO strings — raw `Date` in `sql` templates is not encoded like `gte`/`lte` params.
 */
export function ledgerPeriodBounds(period: ResolvedPeriod): [SQL, SQL] {
  const startIso = ensurePeriodDate(period.start).toISOString()
  const endIso = ensurePeriodDate(period.end).toISOString()
  const occurredAt = ledgerOccurredAt()
  return [
    sql`${occurredAt} >= ${startIso}::timestamptz`,
    sql`${occurredAt} <= ${endIso}::timestamptz`,
  ]
}

/** Normalizes postgres/drizzle timestamp values (Date or ISO string) for range math. */
export function coerceToDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

const NUMERIC_STRING_PATTERN = '^-?[0-9]+(\\.[0-9]+)?$'

/** Legacy metadata may store non-numeric token strings; a bare `::numeric` cast aborts the whole aggregate. */
function safeMetadataTokenCount(key: 'inputTokens' | 'outputTokens') {
  const tokenValue = sql`${usageLog.metadata}->>${key}`
  return sql`case when ${tokenValue} ~ ${NUMERIC_STRING_PATTERN} then (${tokenValue})::numeric else 0 end`
}

function safeQuantityTokenCount() {
  const quantityText = sql`nullif(trim(${usageLog.quantity}::text), '')`
  return sql`case when ${quantityText} ~ ${NUMERIC_STRING_PATTERN} then (${quantityText})::numeric else 0 end`
}

export function ledgerCostSelect() {
  return {
    billableCost: sql<string>`coalesce(sum(${usageLog.cost}::numeric), 0)`,
    rawCost: sql<string>`coalesce(sum(coalesce(${usageLog.rawCost}, ${usageLog.cost})::numeric), 0)`,
    count: sql<number>`count(*)::int`,
  }
}

export interface ExternalApiUsageRow {
  organizationId: string
  organizationName: string
  workspaceId: string
  workspaceName: string
  workflowId: string
  workflowName: string | null
  actorUserId: string | null
  executionCount: number
  billableCost: number
  rawCost: number
  count: number
  usage: UsageMetrics
}

/**
 * API runs billed to an organization other than the one that owns the workflow.
 *
 * `payerCondition` selects which billed rows the viewer may see. The workflow's
 * organization must differ from the billed organization, so the owning
 * organization keeps those runs in its normal workflow rollup. `homeOrganizationIds`
 * additionally drops workflows from organizations the viewer belongs to.
 */
export async function listExternalApiUsage(params: {
  payerCondition: SQL
  homeOrganizationIds: string[]
  period: ResolvedPeriod
}): Promise<ExternalApiUsageRow[]> {
  const { payerCondition, homeOrganizationIds, period } = params
  const otherOrganization = and(
    isNotNull(workspace.organizationId),
    eq(usageLog.billingEntityType, 'organization'),
    sql`${workspace.organizationId} <> ${usageLog.billingEntityId}`,
    homeOrganizationIds.length > 0
      ? notInArray(workspace.organizationId, homeOrganizationIds)
      : undefined
  )

  const workflowLabel = sql<string>`coalesce(nullif(trim(${workflow.name}), ''), ${usageLog.workflowId})`
  const actorLabel = sql<string>`coalesce(lower(${user.email}), ${usageLog.actorUserId})`

  const rows = await dbReplica
    .select({
      organizationId: organization.id,
      organizationName: organization.name,
      workspaceId: sql<string>`min(${usageLog.workspaceId})`,
      workspaceName: workspace.name,
      workflowId: sql<string>`min(${usageLog.workflowId})`,
      workflowName: workflowLabel,
      actorUserId: sql<string | null>`min(${usageLog.actorUserId})`,
      executionCount: sql<number>`count(distinct ${usageLog.executionId})::int`,
      ...ledgerCostSelect(),
      ...usageMetricsSelect(),
    })
    .from(usageLog)
    .innerJoin(
      workflowExecutionLogs,
      and(
        eq(workflowExecutionLogs.executionId, usageLog.executionId),
        eq(workflowExecutionLogs.trigger, 'api')
      )
    )
    .innerJoin(workspace, eq(workspace.id, usageLog.workspaceId))
    .innerJoin(organization, eq(organization.id, workspace.organizationId))
    .leftJoin(workflow, eq(workflow.id, usageLog.workflowId))
    .leftJoin(user, eq(user.id, usageLog.actorUserId))
    .where(
      and(
        payerCondition,
        otherOrganization,
        eq(usageLog.billable, true),
        isNotNull(usageLog.workflowId),
        ...ledgerPeriodBounds(period)
      )
    )
    .groupBy(organization.id, organization.name, workspace.name, workflowLabel, actorLabel)

  return sortByBillableCostDesc(
    rows.flatMap((row) => {
      if (!row.organizationId || !row.workspaceId || !row.workflowId) return []
      return [
        {
          organizationId: row.organizationId,
          organizationName: row.organizationName ?? row.organizationId,
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName ?? row.workspaceId,
          workflowId: row.workflowId,
          workflowName: row.workflowName,
          actorUserId: row.actorUserId,
          executionCount: parseIntMetric(row.executionCount),
          billableCost: parseDecimal(row.billableCost),
          rawCost: parseDecimal(row.rawCost),
          count: parseIntMetric(row.count),
          usage: mapUsageMetrics(row),
        },
      ]
    })
  )
}

/**
 * Local mothership (Arena AI) shares ledger `source = copilot` with workspace Copilot.
 * Rows stamped with metadata.backend = local are the Local mothership path.
 */
function isLocalMothershipBackendSql(): SQL {
  return sql`coalesce(${usageLog.metadata}->>'backend', '') = 'local'`
}

/**
 * Grouping key that splits Local mothership from workspace Copilot while keeping
 * every other source as its ledger enum value.
 */
export function bySourceDisplayBucketExpr(): SQL<string> {
  return sql<string>`case
    when ${usageLog.source} = 'copilot' and ${isLocalMothershipBackendSql()} then 'arena-ai'
    else ${usageLog.source}::text
  end`
}

/** Ledger enum value for bySource rows (always a valid usage_log_source). */
export function bySourceLedgerSourceExpr(): SQL<string> {
  return sql<string>`case
    when ${usageLog.source} = 'copilot' and ${isLocalMothershipBackendSql()} then 'copilot'
    else ${usageLog.source}::text
  end`
}

/** Usage UI display label, including Arena AI for Local mothership. */
export function bySourceDisplayLabelExpr(): SQL<string> {
  return sql<string>`case
    when ${usageLog.source} = 'copilot' and ${isLocalMothershipBackendSql()} then 'Arena AI'
    when ${usageLog.source} = 'copilot' then 'Copilot'
    when ${usageLog.source} = 'workspace-chat' then 'Mothership'
    when ${usageLog.source} = 'mothership_block' then 'Mothership block'
    when ${usageLog.source} = 'workflow' then 'Workflow'
    when ${usageLog.source} = 'wand' then 'Wand'
    when ${usageLog.source} = 'mcp_copilot' then 'MCP copilot'
    when ${usageLog.source} = 'knowledge-base' then 'Knowledge base'
    when ${usageLog.source} = 'voice-input' then 'Voice input'
    when ${usageLog.source} = 'enrichment' then 'Enrichment'
    else ${usageLog.source}::text
  end`
}

/**
 * Maps ledger category/description into dashboard charge buckets:
 * base run fee, provider/model spend, hosted tools, Cost-block pass-through,
 * and mothership/copilot pricing (kept out of the workflow provider bucket).
 */
export function chargeTypeExpr() {
  return sql<string>`case
    when ${usageLog.source} in ('copilot', 'workspace-chat', 'mcp_copilot', 'mothership_block')
      then 'mothership'
    when ${usageLog.category} = 'fixed' and ${usageLog.description} = 'execution_fee' then 'base_run'
    when ${usageLog.category} = 'model' then 'provider'
    when ${usageLog.category} = 'tool' then 'tool'
    when ${usageLog.category} = 'external' then 'cost_block'
    else 'other'
  end`
}

export function parseChargeType(value: string | null | undefined): UsageChargeTypeValue {
  const parsed = usageChargeTypeSchema.safeParse(value)
  return parsed.success ? parsed.data : 'other'
}

export function usageMetricsSelect() {
  const inputTokens = safeMetadataTokenCount('inputTokens')
  const outputTokens = safeMetadataTokenCount('outputTokens')
  const quantityTokens = safeQuantityTokenCount()

  return {
    inputTokens: sql<number>`coalesce(sum(
      case when ${usageLog.category} = 'model'
        then ${inputTokens}
        else 0
      end
    ), 0)::bigint`,
    outputTokens: sql<number>`coalesce(sum(
      case when ${usageLog.category} = 'model'
        then ${outputTokens}
        else 0
      end
    ), 0)::bigint`,
    totalTokens: sql<number>`coalesce(sum(
      case
        when ${usageLog.category} = 'model' then ${inputTokens} + ${outputTokens}
        when ${usageLog.unit} = 'tokens' then ${quantityTokens}
        else 0
      end
    ), 0)::bigint`,
    invocationCount: sql<number>`count(*)::int`,
  }
}

export function mapUsageMetrics(row: {
  inputTokens?: number | string | bigint | null
  outputTokens?: number | string | bigint | null
  totalTokens?: number | string | bigint | null
  invocationCount?: number | string | bigint | null
}): UsageMetrics {
  return {
    inputTokens: parseIntMetric(row.inputTokens),
    outputTokens: parseIntMetric(row.outputTokens),
    totalTokens: parseIntMetric(row.totalTokens),
    invocationCount: parseIntMetric(row.invocationCount),
  }
}

const SOURCE_LABEL_FALLBACK: Record<UsageLogSourceValue, string> = {
  workflow: 'Workflow',
  wand: 'Wand',
  copilot: 'Copilot',
  'workspace-chat': 'Mothership',
  mcp_copilot: 'MCP copilot',
  mothership_block: 'Mothership block',
  'knowledge-base': 'Knowledge base',
  'voice-input': 'Voice input',
  enrichment: 'Enrichment',
}

/**
 * Maps a bySource SQL row into a contract-safe bucket. Invalid ledger sources are
 * skipped (logged by the caller) so a single bad enum value cannot 500 the page
 * or fail client contract validation for the whole response.
 */
export function mapBySourceBucketRow(row: {
  source: unknown
  label?: string | null
  billableCost: string | null | undefined
  rawCost: string | null | undefined
  count: number | string | bigint | null | undefined
  inputTokens?: number | string | bigint | null
  outputTokens?: number | string | bigint | null
  totalTokens?: number | string | bigint | null
  invocationCount?: number | string | bigint | null
}): {
  source: UsageLogSourceValue
  label: string
  billableCost: number
  rawCost: number
  count: number
  usage: UsageMetrics
} | null {
  const parsed = usageLogSourceSchema.safeParse(row.source)
  if (!parsed.success) return null

  const source = parsed.data
  return {
    source,
    label: normalizeBucketKey(row.label, SOURCE_LABEL_FALLBACK[source]),
    billableCost: parseDecimal(row.billableCost),
    rawCost: parseDecimal(row.rawCost),
    count: parseIntMetric(row.count),
    usage: mapUsageMetrics(row),
  }
}

export function buildLedgerConditions(
  workspaceCondition: SQL,
  period: ResolvedPeriod,
  sources?: UsageLogSource[]
): SQL[] {
  const conditions: SQL[] = [workspaceCondition, ...ledgerPeriodBounds(period)]
  if (sources && sources.length > 0) {
    conditions.push(inArray(usageLog.source, sources))
  }
  return conditions
}

export function buildLedgerJoinConditions(workspaceCondition: SQL, period: ResolvedPeriod): SQL[] {
  return [workspaceCondition, ...ledgerPeriodBounds(period)]
}

export function buildExecutionConditions(workspaceCondition: SQL, period: ResolvedPeriod): SQL[] {
  const startIso = ensurePeriodDate(period.start).toISOString()
  const endIso = ensurePeriodDate(period.end).toISOString()
  return [
    workspaceCondition,
    sql`${workflowExecutionLogs.startedAt} >= ${startIso}::timestamptz`,
    sql`${workflowExecutionLogs.startedAt} <= ${endIso}::timestamptz`,
  ]
}

/**
 * Inclusive period bounds for a timestamp column.
 * Uses ISO timestamptz params — same encoding as {@link ledgerPeriodBounds}.
 */
export function periodRange(column: SQLWrapper, period: ResolvedPeriod): [SQL, SQL] {
  const startIso = ensurePeriodDate(period.start).toISOString()
  const endIso = ensurePeriodDate(period.end).toISOString()
  return [sql`${column} >= ${startIso}::timestamptz`, sql`${column} <= ${endIso}::timestamptz`]
}

/** Resolves a fixed window from explicit start/end or a relative period preset. */
export function resolveExplicitPeriod(options: ExplicitPeriodOptions): ResolvedPeriod {
  const end = ensurePeriodDate(options.endTime ? new Date(options.endTime) : new Date())
  const start = ensurePeriodDate(
    options.startTime
      ? new Date(options.startTime)
      : new Date(end.getTime() - PERIOD_MS[options.period ?? '30d'])
  )
  return { start, end }
}

/** Collapses min/max timestamp candidates into an all-time window ending at least at now. */
export function resolvePeriodFromDateCandidates(
  candidates: Array<Date | string | number | null | undefined>
): ResolvedPeriod {
  const dates = candidates.map(coerceToDate).filter((value): value is Date => value !== null)

  if (dates.length === 0) {
    const now = new Date()
    return { start: now, end: now }
  }

  const start = ensurePeriodDate(new Date(Math.min(...dates.map((date) => date.getTime()))))
  const end = ensurePeriodDate(
    new Date(Math.max(...dates.map((date) => date.getTime()), Date.now()))
  )
  return { start, end }
}

export function timeBucketExpr(useHourly: boolean) {
  const occurredAt = ledgerOccurredAt()
  return useHourly ? sql`date_trunc('hour', ${occurredAt})` : sql`date_trunc('day', ${occurredAt})`
}

export function executionBucketExpr(useHourly: boolean) {
  return useHourly
    ? sql`date_trunc('hour', ${workflowExecutionLogs.startedAt})`
    : sql`date_trunc('day', ${workflowExecutionLogs.startedAt})`
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Hourly buckets for the 24h preset and short custom ranges (≤ ~25h).
 * Longer windows stay daily so charts stay readable.
 */
export function shouldUseHourlyTimeBuckets(
  options: { allTime?: boolean; period?: '1d' | '7d' | '30d' | '90d' },
  period: ResolvedPeriod
): boolean {
  if (options.allTime) return false
  if (options.period === '1d') return true

  const startMs = ensurePeriodDate(period.start).getTime()
  const endMs = ensurePeriodDate(period.end).getTime()
  return endMs - startMs <= DAY_MS + HOUR_MS
}

/** Usage dashboard time-series point shared by workspace and org analytics. */
export interface UsageTimeSeriesBucket {
  bucketStart: string
  billableCost: number
  rawCost: number
  executionCount: number
  activeUserCount: number
  usage: UsageMetrics
}

/** Truncates a timestamp to the UTC hour or day boundary used by `date_trunc`. */
export function truncateToBucketStart(date: Date, useHourly: boolean): Date {
  const truncated = new Date(date.getTime())
  if (useHourly) {
    truncated.setUTCMinutes(0, 0, 0)
  } else {
    truncated.setUTCHours(0, 0, 0, 0)
  }
  return truncated
}

/**
 * Fills zero-valued buckets across `[period.start, period.end]` so Cost & activity
 * and Active users charts span the selected window even when usage is sparse.
 */
export function densifyTimeSeries(
  buckets: UsageTimeSeriesBucket[],
  period: ResolvedPeriod,
  useHourly: boolean
): UsageTimeSeriesBucket[] {
  const byStart = new Map(buckets.map((bucket) => [bucket.bucketStart, bucket]))
  const stepMs = useHourly ? HOUR_MS : DAY_MS
  const cursor = truncateToBucketStart(ensurePeriodDate(period.start), useHourly)
  const endMs = ensurePeriodDate(period.end).getTime()

  const densified: UsageTimeSeriesBucket[] = []
  for (let t = cursor.getTime(); t <= endMs; t += stepMs) {
    const bucketStart = new Date(t).toISOString()
    const existing = byStart.get(bucketStart)
    if (existing) {
      densified.push(existing)
      byStart.delete(bucketStart)
    } else {
      densified.push({
        bucketStart,
        billableCost: 0,
        rawCost: 0,
        executionCount: 0,
        activeUserCount: 0,
        usage: { ...EMPTY_USAGE_METRICS },
      })
    }
  }

  // Preserve any buckets that did not land on the UTC truncation grid.
  for (const leftover of byStart.values()) {
    densified.push(leftover)
  }

  densified.sort((a, b) => a.bucketStart.localeCompare(b.bucketStart))
  return densified
}

export function parseActorType(value: string | null | undefined) {
  if (!value) return null
  const parsed = usageActorTypeSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Resolved actor identity for usage attribution — stamped actor, else mothership
 * chat owner, else billing user. Shared by byActor rollups and active-user counts.
 */
export function resolvedActorUserIdExpr() {
  return sql`coalesce(
    ${usageLog.actorUserId},
    ${copilotChats.userId},
    ${usageLog.userId}
  )`
}

/**
 * Resolved actor type with the same fallback chain as {@link resolvedActorUserIdExpr}.
 * Infers `'user'` when a user id is present but `actor_type` was never stamped.
 */
export function resolvedActorTypeExpr() {
  return sql`coalesce(
    ${usageLog.actorType},
    case
      when coalesce(${usageLog.actorUserId}, ${copilotChats.userId}, ${usageLog.userId}) is not null
        then 'user'
      else null
    end
  )`
}

/** SQL predicate: resolved actor type is a human (`user`), including personal API keys. */
export function isHumanActorCondition() {
  return sql`${resolvedActorTypeExpr()} = 'user'`
}

export function parseChatType(value: string | null | undefined): 'mothership' | 'copilot' {
  return value === 'mothership' ? 'mothership' : 'copilot'
}

interface ExpensiveCopilotChatDbRow {
  workspaceId: string
  workspaceName: string | null
  chatId: string
  title: string | null
  chatType: string | null
  userId: string
  runCount: number
  billableCost: string
  rawCost: string
  count: number
}

interface ExpensiveWorkflowDbRow {
  workspaceId: string
  workspaceName: string | null
  workflowId: string | null
  workflowName: string | null
  executionCount: number
  billableCost: string
  rawCost: string
  count: number
}

/**
 * Period-scoped run count per chat as a scalar subquery.
 * Kept off the usage_log join so multiple runs cannot multiply sum(cost).
 */
export function copilotRunCountSubquery(period: ResolvedPeriod) {
  const startIso = ensurePeriodDate(period.start).toISOString()
  const endIso = ensurePeriodDate(period.end).toISOString()
  return sql<number>`(
    select count(*)::int
    from ${copilotRuns}
    where ${copilotRuns.chatId} = ${copilotChats.id}
      and ${copilotRuns.startedAt} >= ${startIso}::timestamptz
      and ${copilotRuns.startedAt} <= ${endIso}::timestamptz
  )`
}

/**
 * Builds the most-expensive mothership/copilot chats aggregate query.
 * Pair with {@link mapExpensiveCopilotChatRows} after Promise.all.
 *
 * Run counts use a scalar subquery — never join `copilot_runs` alongside
 * `usage_log`, or one usage row × N runs inflates credits (e.g. 20 → 40).
 */
export function buildExpensiveCopilotChatsQuery(options: QueryExpensiveCopilotChatsOptions) {
  const { chatScope, ledgerJoinConditions, period } = options

  return dbReplica
    .select({
      workspaceId: copilotChats.workspaceId,
      workspaceName: workspace.name,
      chatId: copilotChats.id,
      title: copilotChats.title,
      chatType: copilotChats.type,
      userId: copilotChats.userId,
      runCount: copilotRunCountSubquery(period),
      ...ledgerCostSelect(),
    })
    .from(copilotChats)
    .leftJoin(workspace, eq(workspace.id, copilotChats.workspaceId))
    .innerJoin(
      usageLog,
      and(
        eq(usageLog.chatId, copilotChats.id),
        ...ledgerJoinConditions,
        inArray(usageLog.source, COPILOT_USAGE_SOURCES)
      )
    )
    .where(chatScope)
    .groupBy(
      copilotChats.id,
      copilotChats.workspaceId,
      workspace.name,
      copilotChats.title,
      copilotChats.type,
      copilotChats.userId
    )
}

export interface QueryCopilotByChatTypeOptions {
  chatScope: SQL
  ledgerJoinConditions: SQL[]
  period: ResolvedPeriod
  /** Optional run-table workspace filter (org scope). */
  runWorkspaceCondition?: SQL
}

/**
 * Chat-type rollup with correct costs when chats have multiple runs.
 * Joins usage_log only (so sum(cost) is not multiplied by run count); run
 * totals use a type-correlated subquery.
 */
export function buildCopilotByChatTypeQuery(options: QueryCopilotByChatTypeOptions) {
  const { chatScope, ledgerJoinConditions, period, runWorkspaceCondition } = options
  const startIso = ensurePeriodDate(period.start).toISOString()
  const endIso = ensurePeriodDate(period.end).toISOString()

  const runCountForType = sql<number>`(
    select count(*)::int
    from ${copilotRuns}
    inner join ${copilotChats} as chat_for_runs
      on chat_for_runs.id = ${copilotRuns.chatId}
    where chat_for_runs.type = ${copilotChats.type}
      and ${copilotRuns.startedAt} >= ${startIso}::timestamptz
      and ${copilotRuns.startedAt} <= ${endIso}::timestamptz
      ${runWorkspaceCondition ? sql`and ${runWorkspaceCondition}` : sql``}
  )`

  const hasRunsInPeriod = sql`exists (
    select 1
    from ${copilotRuns}
    where ${copilotRuns.chatId} = ${copilotChats.id}
      and ${copilotRuns.startedAt} >= ${startIso}::timestamptz
      and ${copilotRuns.startedAt} <= ${endIso}::timestamptz
      ${runWorkspaceCondition ? sql`and ${runWorkspaceCondition}` : sql``}
  )`

  return dbReplica
    .select({
      chatType: copilotChats.type,
      chatCount: sql<number>`count(distinct ${copilotChats.id})::int`,
      runCount: runCountForType,
      ...ledgerCostSelect(),
    })
    .from(copilotChats)
    .leftJoin(
      usageLog,
      and(
        eq(usageLog.chatId, copilotChats.id),
        inArray(usageLog.source, COPILOT_USAGE_SOURCES),
        ...ledgerJoinConditions
      )
    )
    .where(
      and(
        chatScope,
        or(
          and(...periodRange(copilotChats.createdAt, period)),
          isNotNull(usageLog.id),
          hasRunsInPeriod
        )
      )
    )
    .groupBy(copilotChats.type)
}

/** Maps raw expensive-chat aggregate rows, ranks by billable cost, and slices top N. */
export function mapExpensiveCopilotChatRows(
  rows: ExpensiveCopilotChatDbRow[],
  limit = TOP_EXPENSIVE_COPILOT_CHATS
): ExpensiveCopilotChatRow[] {
  return sortByBillableCostDesc(
    rows.map((row) => ({
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      chatId: row.chatId,
      title: row.title,
      chatType: parseChatType(row.chatType),
      userId: row.userId,
      runCount: parseIntMetric(row.runCount),
      billableCost: parseDecimal(row.billableCost),
      rawCost: parseDecimal(row.rawCost),
      count: parseIntMetric(row.count),
    }))
  ).slice(0, limit)
}

/**
 * Builds the most-expensive workflows aggregate query.
 * Pair with {@link mapExpensiveWorkflowRows} after Promise.all.
 */
export function buildExpensiveWorkflowsQuery(options: QueryExpensiveWorkflowsOptions) {
  const { executionScope, ledgerJoinConditions, period } = options
  const executionConditions = buildExecutionConditions(executionScope, period)

  return dbReplica
    .select({
      workspaceId: workflowExecutionLogs.workspaceId,
      workspaceName: workspace.name,
      workflowId: workflowExecutionLogs.workflowId,
      workflowName: workflow.name,
      executionCount: sql<number>`count(distinct ${workflowExecutionLogs.executionId})::int`,
      ...ledgerCostSelect(),
    })
    .from(workflowExecutionLogs)
    .leftJoin(workspace, eq(workspace.id, workflowExecutionLogs.workspaceId))
    .leftJoin(workflow, eq(workflow.id, workflowExecutionLogs.workflowId))
    .leftJoin(
      usageLog,
      and(
        eq(usageLog.executionId, workflowExecutionLogs.executionId),
        eq(usageLog.source, WORKFLOW_SOURCE),
        ...ledgerJoinConditions
      )
    )
    .where(and(...executionConditions))
    .groupBy(
      workflowExecutionLogs.workspaceId,
      workspace.name,
      workflowExecutionLogs.workflowId,
      workflow.name
    )
}

/** Maps raw expensive-workflow aggregate rows, ranks by billable cost, and slices top N. */
export function mapExpensiveWorkflowRows(
  rows: ExpensiveWorkflowDbRow[],
  limit = TOP_EXPENSIVE_WORKFLOWS
): ExpensiveWorkflowRow[] {
  return sortByBillableCostDesc(
    rows.map((row) => ({
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      workflowId: row.workflowId,
      workflowName: row.workflowName,
      executionCount: parseIntMetric(row.executionCount),
      billableCost: parseDecimal(row.billableCost),
      rawCost: parseDecimal(row.rawCost),
      count: parseIntMetric(row.count),
    }))
  ).slice(0, limit)
}
