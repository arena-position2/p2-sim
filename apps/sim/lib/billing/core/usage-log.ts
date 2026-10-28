import { createHash } from 'node:crypto'
import { db, dbReplica } from '@sim/db'
import { subscription as subscriptionTable, usageLog, workflow } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { toNumberOrNull } from '@sim/utils/coerce'
import { getPostgresErrorCode, toError } from '@sim/utils/errors'
import { generateId } from '@sim/utils/id'
import { toRecordOrNull } from '@sim/utils/object'
import { and, desc, eq, gte, inArray, lt, lte, notInArray, or, sql } from 'drizzle-orm'
import {
  type CursorKey,
  keysetColumns,
  keysetPage,
  type ListSortOrder,
  listOrderBy,
  resumeKeyset,
  textKey,
  timestampKey,
} from '@/lib/api/list-query'
import { defaultBillingPeriod } from '@/lib/billing/core/billing-period'
import { readLedgerBounded } from '@/lib/billing/core/ledger-read'
import { getHighestPrioritySubscription } from '@/lib/billing/core/plan'
import {
  resolveSubscriptionUsagePeriod,
  type UsagePeriodSource,
} from '@/lib/billing/core/reporting-period'
import { invalidatePayerPrefixesForTopUp } from '@/lib/billing/core/reporting-usage-epoch'
import { UNBILLED_USAGE_CATEGORIES } from '@/lib/billing/core/unbilled-usage-categories'
import {
  normalizeUsageEntry,
  normalizeUsageModelId,
} from '@/lib/billing/core/usage-entry-normalize'
import { logUsageSkip } from '@/lib/billing/core/usage-skip-metrics'
import { apportionCredits } from '@/lib/billing/credits/conversion'
import { isOrgScopedSubscription } from '@/lib/billing/subscriptions/utils'
import type { InternalUsageLogSource } from '@/lib/billing/usage-sources'
import { asOrchestrationError, OrchestrationError } from '@/lib/core/orchestration/types'
import { HttpError } from '@/lib/core/utils/http-error'
import { acquireAdvisoryXactLock } from '@/lib/db/advisory-locks'
import type { DbClient, DbOrTx } from '@/lib/db/types'
import type { ExecutionActor } from '@/lib/execution/actor-resolution'

const logger = createLogger('UsageLog')

export interface UsageCostLogContext {
  userId?: string
  workspaceId?: string
  workflowId?: string
  executionId?: string
}

function parsePositiveNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return null
  }
  const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

/** Reads USAGE_LOG_COST_MULTIPLIER from process.env (reliable in Next.js server). */
export function getUsageLogCostMultiplier(): number {
  const raw = process.env.USAGE_LOG_COST_MULTIPLIER ?? process.env.COST_MULTIPLIER ?? undefined
  return parsePositiveNumber(raw) ?? 1
}

export function scaleUsageLogCost(cost: number): number {
  if (cost <= 0) {
    return cost
  }
  const multiplier = getUsageLogCostMultiplier()
  return multiplier === 1 ? cost : cost * multiplier
}

/**
 * Converts a repriced COGS target into the billable amount persisted in `usage_log.cost`.
 * External / Cost-block rows pass through unchanged (multiplier 1).
 */
export function billableReconciliationAmount(
  category: UsageLogCategory,
  rawAmount: number
): number {
  if (rawAmount <= 0) return rawAmount
  if (category === 'external') return rawAmount
  return scaleUsageLogCost(rawAmount)
}

/**
 * Inverse of {@link billableReconciliationAmount} for positive ledger increments.
 * `recordUsage` scales raw entry costs, so reconciliation deltas are emitted as COGS.
 */
export function rawUsageAmountFromBillable(
  category: UsageLogCategory,
  billableAmount: number
): number {
  if (billableAmount <= 0) return billableAmount
  if (category === 'external') return billableAmount
  const multiplier = getUsageLogCostMultiplier()
  return multiplier === 1 ? billableAmount : billableAmount / multiplier
}

function scaleUsageEntry<T extends UsageEntry>(entry: T, multiplier: number): T {
  const rawCost = entry.rawCost ?? entry.cost
  const effectiveMultiplier =
    entry.category === 'external' ? 1 : (entry.pricingSnapshot?.multiplier ?? multiplier)
  const billableCost =
    entry.billableCost ?? (effectiveMultiplier === 1 ? rawCost : rawCost * effectiveMultiplier)

  let metadata = entry.metadata
  if (
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as ModelUsageMetadata).toolCost != null &&
    (metadata as ModelUsageMetadata).toolCost! > 0
  ) {
    const modelMetadata = metadata as ModelUsageMetadata
    const scaledToolCost =
      effectiveMultiplier === 1
        ? modelMetadata.toolCost
        : modelMetadata.toolCost! * effectiveMultiplier
    const scaledEmbeddedToolCosts =
      modelMetadata.embeddedToolCosts && effectiveMultiplier !== 1
        ? Object.fromEntries(
            Object.entries(modelMetadata.embeddedToolCosts).map(([tool, cost]) => [
              tool,
              cost * effectiveMultiplier,
            ])
          )
        : modelMetadata.embeddedToolCosts
    metadata = {
      ...modelMetadata,
      toolCost: scaledToolCost,
      ...(scaledEmbeddedToolCosts ? { embeddedToolCosts: scaledEmbeddedToolCosts } : {}),
    }
  }

  return {
    ...entry,
    cost: billableCost,
    rawCost,
    billableCost,
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

function logUsageCostBreakdown(params: {
  context: UsageCostLogContext
  multiplier: number
  rawEntries: UsageEntry[]
  scaledEntries: UsageEntry[]
}): void {
  const { context, multiplier, rawEntries, scaledEntries } = params

  const lineItems = rawEntries.map((raw, index) => {
    const scaled = scaledEntries[index]
    return {
      label: [raw.source, raw.category, raw.description].filter(Boolean).join('/'),
      costBefore: raw.cost,
      costAfter: scaled?.cost ?? raw.cost,
    }
  })

  logger.info('Usage billing cost breakdown', {
    ...context,
    multiplier,
    envUsageLogCostMultiplier: process.env.USAGE_LOG_COST_MULTIPLIER,
    envCostMultiplier: process.env.COST_MULTIPLIER,
    totalCostBefore: rawEntries.reduce((sum, e) => sum + e.cost, 0),
    totalCostAfter: scaledEntries.reduce((sum, e) => sum + e.cost, 0),
    lineItems,
  })
}

function scaleUsageLogCosts(entries: UsageEntry[], context: UsageCostLogContext): UsageEntry[] {
  const multiplier = getUsageLogCostMultiplier()
  const scaled = entries.map((entry) => scaleUsageEntry(entry, multiplier))

  logUsageCostBreakdown({
    context,
    multiplier,
    rawEntries: entries,
    scaledEntries: scaled,
  })

  return scaled
}

/**
 * Usage log category types.
 *
 * `model_unbilled` is reporting-only — see {@link UNBILLED_USAGE_CATEGORIES}. Code
 * that means "a charge" must not treat it as one.
 */
export type UsageLogCategory = 'model' | 'fixed' | 'tool' | 'external' | 'model_unbilled'

/**
 * Usage log source types
 */
export type UsageLogSource = InternalUsageLogSource

/**
 * usage_log sources that make up the "copilot" cost breakdown shown in billing
 * summaries: Arena Copilot (local mothership), Sim Cloud mothership/workspace
 * chat, MCP copilot, and mothership blocks. Local and Sim Cloud mothership stay
 * on different sources (`copilot` vs `workspace-chat` / `mothership_block`).
 * Mirrors the source set billed via /api/billing/update-cost.
 */
export const COPILOT_USAGE_SOURCES: UsageLogSource[] = [
  'copilot',
  'workspace-chat',
  'mcp_copilot',
  'mothership_block',
]

export { UNBILLED_USAGE_CATEGORIES }

const UNBILLED_USAGE_CATEGORY_SET: ReadonlySet<string> = new Set(UNBILLED_USAGE_CATEGORIES)

/** True for a category whose rows are recorded for reporting rather than billing. */
export function isUnbilledUsageCategory(category: UsageLogCategory): boolean {
  return UNBILLED_USAGE_CATEGORY_SET.has(category)
}

/**
 * Metadata for 'model' category charges
 */
export interface ModelUsageMetadata {
  inputTokens: number
  outputTokens: number
  toolCost?: number
  embeddedToolCosts?: Record<string, number>
  /**
   * Optional map from `embeddedToolCosts` key → Usage By Tools bucket id.
   * New writes populate this so readers do not rely on key heuristics.
   * Absent on legacy rows — readers fall back to {@link normalizeUsageToolBucketId}.
   */
  embeddedToolIds?: Record<string, string>
}

/**
 * Metadata for `external` category charges (Cost block / third-party vendor spend).
 */
export interface ExternalUsageMetadata {
  originalAmount?: number
  originalCurrency?: string
  exchangeRate?: number
  sourceBlockId?: string
  responsePath?: string
  source?: string
}

/**
 * Union type for all usage log metadata types
 */
export type UsageLogMetadata =
  | ModelUsageMetadata
  | ExternalUsageMetadata
  | Record<string, unknown>
  | null

export type BillingEntityType = 'user' | 'organization'

export interface BillingEntity {
  type: BillingEntityType
  id: string
}

/**
 * Rates and multipliers captured at write time in `usage_log.pricing_snapshot`.
 * Supports COGS vs billable reconciliation without re-reading vendor-pricing.json.
 */
export interface UsagePricingSnapshot {
  vendor?: string
  tool?: string
  model?: string
  inputRatePerMillion?: number
  outputRatePerMillion?: number
  cachedInputRatePerMillion?: number
  flatRate?: number
  multiplier?: number
  pricingSource?: 'vendor-pricing' | 'models-ts' | 'hosted-key' | 'fixed'
  capturedAt?: string
}

/**
 * A single usage entry to be recorded in the usage_log table.
 */
export interface UsageEntry {
  category: UsageLogCategory
  source: UsageLogSource
  description: string
  cost: number
  /** Vendor COGS before `USAGE_LOG_COST_MULTIPLIER`. When set, `cost` should equal billableCost. */
  rawCost?: number
  /** Customer-facing amount after multiplier. When set, should mirror `cost` for legacy readers. */
  billableCost?: number
  eventKey?: string
  sourceReference?: string
  metadata?: UsageLogMetadata
  vendor?: string
  provider?: string
  toolId?: string
  /** Registry operation id (e.g. exa_search). Written for Usage By Tools only. */
  toolName?: string
  chatId?: string
  runId?: string
  quantity?: number
  unit?: string
  pricingSnapshot?: UsagePricingSnapshot
}

interface RecordUsageBaseParams {
  /** Actor recorded in usage_log.userId. */
  userId: string
  /** One or more usage_log entries to record. Total cost is derived from these. */
  entries: UsageEntry[]
  /** Workspace context */
  workspaceId?: string
  /** Workflow context */
  workflowId?: string
  /** Execution context */
  executionId?: string
  /** Copilot/mothership chat context (entry-level values take precedence). */
  chatId?: string
  /** Copilot run context (entry-level values take precedence). */
  runId?: string
  /**
   * When the underlying work started (execution `startedAt`). Falls back to
   * `now` at insert time when omitted.
   */
  occurredAt?: Date
  /** Attribution actor stamped from the hosting execution log. */
  executionActor?: ExecutionActor
  /** Parent workflow run for child/mothership-block attribution. */
  parentExecutionId?: string
  /** Root of the execution lineage tree. */
  rootExecutionId?: string
  /** Copilot chat that triggered the hosting run (rollup only). */
  triggeringChatId?: string
  /** Copilot run that triggered the hosting run (rollup only). */
  triggeringRunId?: string
}

/**
 * Parameters for the central recordUsage function.
 * This is the single entry point for all billing mutations.
 *
 * Callers that pass `tx` (e.g. the per-execution advisory-lock reconciliation
 * in the workflow completion path) must pre-resolve the billing context before
 * opening the transaction: resolving it inside would run the subscription
 * lookups on the global pool while the tx already holds a pooled connection,
 * starving the pool under load (see recordCumulativeUsage for the history).
 */
export type RecordUsageParams = RecordUsageBaseParams &
  (
    | {
        /** Transaction the ledger INSERT participates in. */
        tx: DbOrTx
        /** Billing entity scope, resolved before the transaction opened. */
        billingEntity: BillingEntity
        /** Billing period bounds, resolved before the transaction opened. */
        billingPeriod: { start: Date; end: Date }
      }
    | {
        tx?: undefined
        /** Billing entity scope, resolved by caller when already known. */
        billingEntity?: BillingEntity
        /** Billing period bounds, resolved by caller when already known. */
        billingPeriod?: { start: Date; end: Date }
      }
  )

export function stableEventKey(parts: Record<string, unknown>): string {
  const payload = Object.keys(parts)
    .sort()
    .map((key) => `${key}:${String(parts[key] ?? '')}`)
    .join('|')
  return createHash('sha256').update(payload).digest('hex')
}

type ResolvedSubscription = Awaited<ReturnType<typeof getHighestPrioritySubscription>>

export interface BillingContext {
  billingEntity: BillingEntity
  billingPeriod: UsageQueryPeriod
}

export interface UsageQueryPeriod {
  start: Date
  end: Date
  source?: UsagePeriodSource
}

/**
 * Derive an account-only billing entity and period from an already-resolved
 * subscription. Workspace-hosted callers must use `resolveBillingAttribution`
 * so the routed workspace, rather than the actor's subscriptions, selects the
 * payer.
 */
export function deriveBillingContext(
  userId: string,
  subscription: ResolvedSubscription
): BillingContext {
  const billingEntity: BillingEntity =
    subscription && isOrgScopedSubscription(subscription, userId)
      ? { type: 'organization', id: subscription.referenceId }
      : { type: 'user', id: userId }

  const billingPeriod = resolveSubscriptionUsagePeriod(subscription) ?? {
    ...defaultBillingPeriod(),
    source: 'default' as const,
  }

  return { billingEntity, billingPeriod }
}

async function resolveBillingContext(
  userId: string,
  billingEntity?: BillingEntity,
  billingPeriod?: { start: Date; end: Date }
): Promise<BillingContext> {
  if (billingEntity && billingPeriod) {
    return { billingEntity, billingPeriod }
  }

  const subscription = await getHighestPrioritySubscription(userId)
  const derived = deriveBillingContext(userId, subscription)
  return {
    billingEntity: billingEntity ?? derived.billingEntity,
    billingPeriod: billingPeriod ?? derived.billingPeriod,
  }
}

/**
 * Returns attributed ledger usage for a billing entity/period. The ledger is
 * the sole source of truth for usage — there is no userStats baseline.
 */
export async function getBillingPeriodUsageCost(
  billingEntity: BillingEntity,
  billingPeriod: UsageQueryPeriod,
  source?: UsageLogSource | UsageLogSource[],
  executor: DbClient = db
): Promise<number> {
  const conditions = [
    eq(usageLog.billingEntityType, billingEntity.type),
    eq(usageLog.billingEntityId, billingEntity.id),
    eq(usageLog.billable, true),
    ...(billingPeriod.source === 'reporting'
      ? [gte(usageLog.createdAt, billingPeriod.start), lt(usageLog.createdAt, billingPeriod.end)]
      : [
          eq(usageLog.billingPeriodStart, billingPeriod.start),
          eq(usageLog.billingPeriodEnd, billingPeriod.end),
        ]),
  ]
  if (source) {
    conditions.push(
      Array.isArray(source) ? inArray(usageLog.source, source) : eq(usageLog.source, source)
    )
  }

  const [row] = await readLedgerBounded(executor, (tx) =>
    tx
      .select({
        cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)`,
      })
      .from(usageLog)
      .where(and(...conditions))
  )

  return Number.parseFloat(row?.cost ?? '0')
}

/**
 * Counts distinct workflow executions that produced billable ledger entries in
 * an attributed billing period. Multiple line items for one execution count as
 * one run; executions with no billable usage are intentionally excluded.
 *
 * The category filter is what keeps that last clause true now that unbilled rows
 * exist. A BYOK-only run whose base charge is zero writes nothing but a
 * `model_unbilled` row, and without this it would newly appear in a count that
 * feeds the enterprise billing preview — a customer-facing number moving because
 * of a reporting-only row.
 */
export async function getBillingPeriodWorkflowRunCount(
  billingEntity: BillingEntity,
  billingPeriod: UsageQueryPeriod,
  executor: DbClient = db
): Promise<number> {
  const [row] = await readLedgerBounded(executor, (tx) =>
    tx
      .select({
        /**
         * The exclusion goes through `notInArray`, not `<> ALL(${array})`. Interpolating
         * a JavaScript array into a `sql` template emits parenthesized scalar binds —
         * `ALL(($1))` — which Postgres rejects outright with "op ANY/ALL (array)
         * requires array on right side". Unit tests cannot catch it, because `@sim/db`
         * is mocked and no statement is ever rendered.
         */
        workflowRuns:
          sql<number>`COUNT(DISTINCT ${usageLog.executionId}) FILTER (WHERE ${usageLog.source} = 'workflow' AND ${notInArray(usageLog.category, [...UNBILLED_USAGE_CATEGORIES])})`.mapWith(
            Number
          ),
      })
      .from(usageLog)
      .where(
        and(
          eq(usageLog.billingEntityType, billingEntity.type),
          eq(usageLog.billingEntityId, billingEntity.id),
          eq(usageLog.billable, true),
          ...(billingPeriod.source === 'reporting'
            ? [
                gte(usageLog.createdAt, billingPeriod.start),
                lt(usageLog.createdAt, billingPeriod.end),
              ]
            : [
                eq(usageLog.billingPeriodStart, billingPeriod.start),
                eq(usageLog.billingPeriodEnd, billingPeriod.end),
              ])
        )
      )
  )

  return row?.workflowRuns ?? 0
}

/**
 * Period total plus the portion attributable to `source`, in a single scan.
 *
 * Two separate aggregates over the identical row set double the work and, because
 * they are separate statements, can observe different snapshots — which makes the
 * subset exceeding the total representable. One statement rules that out.
 */
export async function getBillingPeriodUsageCostWithSourceSubset(
  billingEntity: BillingEntity,
  billingPeriod: UsageQueryPeriod,
  source: UsageLogSource[],
  executor: DbClient = db
): Promise<{ total: number; subset: number }> {
  const [row] = await readLedgerBounded(executor, (tx) =>
    tx
      .select({
        total: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)`,
        subset: sql<string>`COALESCE(SUM(${usageLog.cost}) FILTER (WHERE ${inArray(usageLog.source, source)}), 0)`,
      })
      .from(usageLog)
      .where(
        and(
          eq(usageLog.billingEntityType, billingEntity.type),
          eq(usageLog.billingEntityId, billingEntity.id),
          eq(usageLog.billable, true),
          ...(billingPeriod.source === 'reporting'
            ? [
                gte(usageLog.createdAt, billingPeriod.start),
                lt(usageLog.createdAt, billingPeriod.end),
              ]
            : [
                eq(usageLog.billingPeriodStart, billingPeriod.start),
                eq(usageLog.billingPeriodEnd, billingPeriod.end),
              ])
        )
      )
  )

  return {
    total: Number.parseFloat(row?.total ?? '0'),
    subset: Number.parseFloat(row?.subset ?? '0'),
  }
}

export async function getBillingPeriodUsageCostByUser(
  billingEntity: BillingEntity,
  billingPeriod: UsageQueryPeriod,
  source?: UsageLogSource | UsageLogSource[],
  executor: DbClient = db,
  userIds?: readonly string[]
): Promise<Map<string, number>> {
  if (userIds?.length === 0) return new Map()
  if (userIds && userIds.length > 1_000) {
    throw new Error('Billing usage user filter cannot exceed 1,000 users')
  }
  const conditions = [
    eq(usageLog.billingEntityType, billingEntity.type),
    eq(usageLog.billingEntityId, billingEntity.id),
    eq(usageLog.billable, true),
    ...(billingPeriod.source === 'reporting'
      ? [gte(usageLog.createdAt, billingPeriod.start), lt(usageLog.createdAt, billingPeriod.end)]
      : [
          eq(usageLog.billingPeriodStart, billingPeriod.start),
          eq(usageLog.billingPeriodEnd, billingPeriod.end),
        ]),
  ]
  if (source) {
    conditions.push(
      Array.isArray(source) ? inArray(usageLog.source, source) : eq(usageLog.source, source)
    )
  }
  if (userIds) conditions.push(inArray(usageLog.userId, [...userIds]))

  const rows = await readLedgerBounded(executor, (tx) =>
    tx
      .select({
        userId: usageLog.userId,
        cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)`,
      })
      .from(usageLog)
      .where(and(...conditions))
      .groupBy(usageLog.userId)
  )

  return new Map(rows.map((row) => [row.userId, Number.parseFloat(row.cost ?? '0')]))
}

/**
 * Per-user ledger cost for every stamped billing period fully contained in
 * `[from, to]`. Rows are matched on their write-time period stamps
 * (`billing_period_start >= from AND billing_period_end <= to`), not on
 * `created_at`, so a row written moments after rollover but stamped with the
 * prior period is still attributed to that prior period.
 *
 * Used by the cycle-close sweep, whose window is normally exactly one period
 * (`from` = the closed period's start, `to` = its end == the current period's
 * start); a wider window absorbs multi-period catch-up after missed sweeps.
 */
export async function getStampedPeriodRangeUsageCostByUser(
  billingEntity: BillingEntity,
  range: { from: Date; to: Date },
  source?: UsageLogSource | UsageLogSource[],
  executor: DbClient = db
): Promise<Map<string, number>> {
  const conditions = [
    eq(usageLog.billingEntityType, billingEntity.type),
    eq(usageLog.billingEntityId, billingEntity.id),
    eq(usageLog.billable, true),
    gte(usageLog.billingPeriodStart, range.from),
    lte(usageLog.billingPeriodEnd, range.to),
  ]
  if (source) {
    conditions.push(
      Array.isArray(source) ? inArray(usageLog.source, source) : eq(usageLog.source, source)
    )
  }

  const rows = await readLedgerBounded(executor, (tx) =>
    tx
      .select({
        userId: usageLog.userId,
        cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)`,
      })
      .from(usageLog)
      .where(and(...conditions))
      .groupBy(usageLog.userId)
  )

  return new Map(rows.map((row) => [row.userId, Number.parseFloat(row.cost ?? '0')]))
}

/**
 * Records usage as append-only billing events.
 *
 * This intentionally avoids per-event userStats updates: userStats is retained
 * as the pre-cutover period baseline and for low-frequency billing trackers,
 * but usage writes no longer contend on the user_stats row.
 */
export async function recordUsage(params: RecordUsageParams): Promise<void> {
  // The usage ledger is written regardless of BILLING_ENABLED so it is the
  // single, universal source of truth for cost (including self-hosted, where
  // it powers the logs-page cost display). Billing *enforcement* (Stripe /
  // overage) is gated separately by callers, not here.
  const {
    userId,
    entries,
    workspaceId,
    workflowId,
    executionId,
    chatId,
    runId,
    occurredAt,
    executionActor,
    parentExecutionId,
    rootExecutionId,
    triggeringChatId,
    triggeringRunId,
    billingEntity,
    billingPeriod,
    tx,
  } = params

  const normalizedEntries = entries.map((entry) => normalizeUsageEntry(entry))
  const scaledEntries = scaleUsageLogCosts(normalizedEntries, {
    userId,
    workspaceId,
    workflowId,
    executionId,
  })

  if (scaledEntries.length === 0) {
    return
  }

  if (workspaceId && (!billingEntity || !billingPeriod)) {
    throw new Error('Workspace usage requires an explicit billing entity and billing period')
  }

  const context = await resolveBillingContext(userId, billingEntity, billingPeriod)
  const stampedOccurredAt = occurredAt ?? new Date()

  const insertedRows = await (tx ?? db)
    .insert(usageLog)
    .values(
      scaledEntries.map((entry, index) => {
        const sourceReference =
          entry.sourceReference ??
          [executionId, workflowId, workspaceId, entry.source, entry.description, index]
            .filter((part) => part !== undefined && part !== null && part !== '')
            .join(':')
        const eventKey =
          entry.eventKey ??
          stableEventKey({
            userId,
            source: entry.source,
            category: entry.category,
            description: entry.description,
            sourceReference,
            executionId,
            workflowId,
            workspaceId,
            index,
          })

        return {
          id: generateId(),
          userId,
          category: entry.category,
          source: entry.source,
          description: entry.description,
          metadata: entry.metadata ?? null,
          cost: entry.cost.toString(),
          rawCost: entry.rawCost != null ? entry.rawCost.toString() : null,
          billableCost: entry.billableCost != null ? entry.billableCost.toString() : null,
          eventKey,
          billingEntityType: context.billingEntity.type,
          billingEntityId: context.billingEntity.id,
          billingPeriodStart: context.billingPeriod.start,
          billingPeriodEnd: context.billingPeriod.end,
          vendor: entry.vendor ?? null,
          provider: entry.provider ?? null,
          toolId: entry.toolId ?? null,
          toolName: entry.toolName ?? null,
          chatId: entry.chatId ?? chatId ?? null,
          runId: entry.runId ?? runId ?? null,
          quantity: entry.quantity != null ? entry.quantity.toString() : null,
          unit: entry.unit ?? null,
          pricingSnapshot: entry.pricingSnapshot ?? null,
          billable: entry.cost > 0,
          workspaceId: workspaceId ?? null,
          workflowId: workflowId ?? null,
          executionId: executionId ?? null,
          occurredAt: stampedOccurredAt,
          actorUserId: executionActor?.actorUserId ?? null,
          actorType: executionActor?.actorType ?? null,
          apiKeyId: executionActor?.apiKeyId ?? null,
          parentExecutionId: parentExecutionId ?? null,
          rootExecutionId: rootExecutionId ?? executionId ?? null,
          triggeringChatId: triggeringChatId ?? null,
          triggeringRunId: triggeringRunId ?? null,
        }
      })
    )
    .onConflictDoNothing({
      target: usageLog.eventKey,
      where: sql`${usageLog.eventKey} IS NOT NULL`,
    })
    .returning({ cost: usageLog.cost, billable: usageLog.billable })

  const insertedCost = insertedRows.reduce((sum, row) => sum + Number.parseFloat(row.cost), 0)
  const billableInserted = insertedRows.filter((row) => row.billable).length
  const nonBillableInserted = insertedRows.length - billableInserted

  if (insertedRows.length < scaledEntries.length) {
    logUsageSkip('duplicate_event_key', {
      userId,
      workspaceId,
      workflowId,
      executionId,
      attemptedEntries: scaledEntries.length,
      insertedEntries: insertedRows.length,
      droppedEntries: scaledEntries.length - insertedRows.length,
    })
  }

  logger.info('Recorded usage to usage_log and user_stats', {
    userId,
    workspaceId,
    workflowId,
    executionId,
    totalCostAddedToUserStats: insertedCost,
    totalCost: insertedCost,
    entryCount: scaledEntries.length,
    billableInserted,
    nonBillableInserted,
    sources: [...new Set(scaledEntries.map((e) => e.source))],
    persistedCosts: scaledEntries.map((e) => ({
      category: e.category,
      source: e.source,
      description: e.description,
      cost: e.cost,
      billable: e.cost > 0,
    })),
  })
}

/**
 * Floating-point tolerance for cumulative cost comparison. Costs are dollars;
 * a sub-microcent difference is treated as "no change" so a DB round-trip
 * (decimal string -> float) can't manufacture a spurious top-up.
 */
export const CUMULATIVE_COST_EPSILON = 1e-9

/**
 * Decide whether an incoming CUMULATIVE cost for a request should bill, given
 * what has already been recorded for it.
 *
 * Billing is a monotonic top-up: only a strictly-higher cumulative bills, and
 * it bills just the delta above what's recorded; a same-or-lower cumulative is
 * a no-op. This is the core invariant that makes repeated flushes of a single
 * request converge to the true total exactly once — a partial mid-loop flush
 * (e.g. after a provider error), the recovered terminal flush, and abort-race
 * duplicates all reconcile to the maximum cumulative with no under- or
 * over-billing, independent of arrival order.
 */
export function resolveCumulativeTopUp(
  recordedCost: number,
  incomingCost: number
): { shouldBill: boolean; delta: number; newTotal: number } {
  if (incomingCost <= recordedCost + CUMULATIVE_COST_EPSILON) {
    return { shouldBill: false, delta: 0, newTotal: recordedCost }
  }
  return { shouldBill: true, delta: incomingCost - recordedCost, newTotal: incomingCost }
}

export interface RecordCumulativeUsageParams {
  /** Actor recorded in usage_log.userId. */
  userId: string
  workspaceId?: string
  /** Exact workspace payer, required whenever workspaceId is present. */
  billingEntity?: BillingEntity
  /** Exact workspace payer period, required whenever workspaceId is present. */
  billingPeriod?: { start: Date; end: Date }
  source: UsageLogSource
  /** Model name, stored as the row description. */
  model: string
  /** The request's CUMULATIVE vendor COGS so far (not a per-leg delta). */
  cost: number
  /** Stable per-request key; the single ledger row is keyed on this. */
  eventKey: string
  metadata?: UsageLogMetadata
  chatId?: string
  runId?: string
  provider?: string
  vendor?: string
  pricingSnapshot?: UsagePricingSnapshot
  /** When the underlying request started; stamped on first flush only. */
  occurredAt?: Date
  /** Parent workflow run for mothership-block / child attribution. */
  parentExecutionId?: string
  /** Root of the execution lineage tree. */
  rootExecutionId?: string
  /** Copilot chat that triggered the hosting run (rollup only). */
  triggeringChatId?: string
  /** Copilot run that triggered the hosting run (rollup only). */
  triggeringRunId?: string
  /**
   * Who triggered the request. Mothership/copilot flushes should stamp the
   * requesting user here — otherwise actor columns stay null and dashboards
   * cannot attribute spend without joining `copilot_chats`.
   */
  executionActor?: ExecutionActor
  /**
   * The Stripe-period subscription that pays for this request. When given, a top-up that
   * arrives after that subscription has moved past the period of the request's latest row is
   * recorded in a new row stamped with the subscription's current period, so a request that
   * outlives its billing period is invoiced by the period it was spent in rather than topping up
   * a period that has already been closed. A charge into a period the subscription's close marker
   * has already passed (its terminal settlement) throws {@link CumulativeUsagePeriodClosedError}.
   * Omit it for reporting-window and free payers.
   *
   * Mixed versions: code that predates period rows reads only the request key. If such code
   * (during a deploy, or after a rollback) handles a later callback for a request that already
   * has period rows, it re-adds those rows' amount to the first row. That only double-counts
   * when it lands between the rollover and that period's close, which waits at least an hour,
   * and only for runs spanning a rollover; the exposure is one run's post-rollover spend, cents
   * to dollars.
   */
  payerSubscriptionId?: string
}

export interface RecordCumulativeUsageResult {
  /** True when a new (delta) charge was recorded for this flush. */
  billed: boolean
  /** Amount newly charged by this flush (0 on a duplicate/lower flush). */
  delta: number
  /** The request's recorded cumulative cost after this flush. */
  total: number
  /** The billing period of the row this flush wrote to, or of the request's latest row. */
  billingPeriod: { start: Date; end: Date }
}

/**
 * The most period rows one request may span: its first row plus one per later billing period.
 * A request still billing twelve periods after it started is refused rather than scanned.
 */
const MAX_CUMULATIVE_PERIOD_ROWS = 12

/**
 * The ledger key of the `index`-th period a cumulative request rolled into; 0 is the request key.
 * The cost callback refuses a request key containing `@`, so these never collide with another
 * request's.
 */
function cumulativePeriodEventKey(eventKey: string, index: number): string {
  return index === 0 ? eventKey : `${eventKey}@${index}`
}

/** Decimal places kept when period row costs are summed or subtracted as floats. */
const PERIOD_COST_DECIMALS = 12

const CUMULATIVE_TOKEN_FIELDS = ['inputTokens', 'outputTokens'] as const

/**
 * A period row's share of a cumulative callback's token counts: the cumulative counts minus what
 * the request's other rows already hold, so summing the rows never counts a token twice.
 */
function periodUsageMetadata(
  metadata: UsageLogMetadata | undefined,
  otherRows: readonly { metadata: unknown }[]
): UsageLogMetadata | undefined {
  const cumulative = toRecordOrNull(metadata)
  if (!cumulative || otherRows.length === 0) return metadata
  const share: Record<string, unknown> = { ...cumulative }
  for (const field of CUMULATIVE_TOKEN_FIELDS) {
    const total = toNumberOrNull(cumulative[field])
    if (total === null) continue
    const recorded = otherRows.reduce(
      (sum, row) => sum + (toNumberOrNull(toRecordOrNull(row.metadata)?.[field]) ?? 0),
      0
    )
    share[field] = Math.max(0, total - recorded)
  }
  return share
}

interface CumulativeRowAttribution {
  workspaceId: string | null
  chatId: string | null
  runId: string | null
  actorUserId: string | null
  actorType: string | null
  parentExecutionId: string | null
  rootExecutionId: string | null
  triggeringChatId: string | null
  triggeringRunId: string | null
}

/**
 * Builds an UPDATE patch that fills only NULL attribution/lineage columns.
 * Never overwrites existing values or touches cost fields.
 */
export function buildNullOnlyAttributionFill(
  existing: CumulativeRowAttribution,
  incoming: {
    workspaceId?: string
    chatId?: string
    runId?: string
    parentExecutionId?: string
    rootExecutionId?: string
    triggeringChatId?: string
    triggeringRunId?: string
    executionActor?: ExecutionActor
  }
): Partial<{
  workspaceId: string
  chatId: string
  runId: string
  actorUserId: string
  actorType: string
  parentExecutionId: string
  rootExecutionId: string
  triggeringChatId: string
  triggeringRunId: string
}> {
  const patch: Partial<{
    workspaceId: string
    chatId: string
    runId: string
    actorUserId: string
    actorType: string
    parentExecutionId: string
    rootExecutionId: string
    triggeringChatId: string
    triggeringRunId: string
  }> = {}

  if (!existing.workspaceId && incoming.workspaceId) {
    patch.workspaceId = incoming.workspaceId
  }
  if (!existing.chatId && incoming.chatId) {
    patch.chatId = incoming.chatId
  }
  if (!existing.runId && incoming.runId) {
    patch.runId = incoming.runId
  }
  if (!existing.parentExecutionId && incoming.parentExecutionId) {
    patch.parentExecutionId = incoming.parentExecutionId
  }
  if (!existing.rootExecutionId && (incoming.rootExecutionId ?? incoming.parentExecutionId)) {
    patch.rootExecutionId = incoming.rootExecutionId ?? incoming.parentExecutionId
  }
  if (!existing.triggeringChatId && incoming.triggeringChatId) {
    patch.triggeringChatId = incoming.triggeringChatId
  }
  if (!existing.triggeringRunId && incoming.triggeringRunId) {
    patch.triggeringRunId = incoming.triggeringRunId
  }
  if (!existing.actorUserId && incoming.executionActor?.actorUserId) {
    patch.actorUserId = incoming.executionActor.actorUserId
  }
  if (!existing.actorType && incoming.executionActor?.actorType) {
    patch.actorType = incoming.executionActor.actorType
  }

  return patch
}
export type CumulativeUsageContextField =
  | 'actor'
  | 'workspace'
  | 'billing entity'
  | 'billing period'

export class CumulativeUsageContextMismatchError extends Error {
  constructor(
    readonly eventKey: string,
    readonly mismatchedFields: readonly CumulativeUsageContextField[]
  ) {
    super(
      `Cumulative usage event "${eventKey}" is already bound to a different billing context (${mismatchedFields.join(', ')})`
    )
    this.name = 'CumulativeUsageContextMismatchError'
  }
}

/**
 * A cumulative charge whose billing period the payer has already settled: the subscription ended
 * and its final invoice summed that period. The charge is refused rather than recorded where no
 * invoice will ever read it.
 */
export class CumulativeUsagePeriodClosedError extends Error {
  constructor(
    readonly eventKey: string,
    readonly billingPeriod: { start: Date; end: Date }
  ) {
    super(
      `Cumulative usage event "${eventKey}" targets a billing period that has already been settled`
    )
    this.name = 'CumulativeUsagePeriodClosedError'
  }
}

interface CumulativeUsageLedgerBinding {
  userId: string
  workspaceId: string | null
  billingEntityType: BillingEntityType | null
  billingEntityId: string | null
  billingPeriodStart: Date | null
  billingPeriodEnd: Date | null
}

function assertCumulativeUsageLedgerBinding(
  existing: CumulativeUsageLedgerBinding,
  expected: {
    userId: string
    workspaceId?: string
    billingContext: BillingContext
    eventKey: string
    /**
     * A request whose first charge landed after its period closed, or after an anchor reset moved
     * its start forward, is stamped with a later one.
     */
    allowLaterPeriod?: boolean
  }
): void {
  const mismatchedFields: CumulativeUsageContextField[] = []
  if (existing.userId !== expected.userId) {
    mismatchedFields.push('actor')
  }
  if (existing.workspaceId !== (expected.workspaceId ?? null)) {
    mismatchedFields.push('workspace')
  }
  if (
    existing.billingEntityType !== expected.billingContext.billingEntity.type ||
    existing.billingEntityId !== expected.billingContext.billingEntity.id
  ) {
    mismatchedFields.push('billing entity')
  }
  const frozenPeriod = expected.billingContext.billingPeriod
  const samePeriod =
    existing.billingPeriodStart?.getTime() === frozenPeriod.start.getTime() &&
    existing.billingPeriodEnd?.getTime() === frozenPeriod.end.getTime()
  // The same forward-only rule that rolls a charge into a new period row.
  const laterPeriod =
    expected.allowLaterPeriod === true &&
    existing.billingPeriodStart !== null &&
    existing.billingPeriodStart.getTime() > frozenPeriod.start.getTime()
  if (!samePeriod && !laterPeriod) {
    mismatchedFields.push('billing period')
  }

  if (mismatchedFields.length > 0) {
    throw new CumulativeUsageContextMismatchError(expected.eventKey, mismatchedFields)
  }
}

/**
 * PostgreSQL 17+ bounds the entire transaction below the callback's five-second
 * deadline. Older supported servers instead bound each idle interval between
 * statements, alongside the per-statement budget. Both policies release an idle
 * lock holder without waiting for its application process to resume; only the
 * newer policy also limits total elapsed transaction time.
 */
const CUMULATIVE_FLUSH_TRANSACTION_TIMEOUT_MS = 4_000
const CUMULATIVE_FLUSH_STATEMENT_TIMEOUT_MS = 3_500
const CUMULATIVE_FLUSH_LOCK_TIMEOUT_MS = 3_000
const CUMULATIVE_FLUSH_SLOW_MS = 1_000

type CumulativeUsageStage = 'pool' | 'configure' | 'lock' | 'read' | 'write' | 'commit'

/**
 * Record a request's CUMULATIVE cost idempotently with monotonic top-up.
 *
 * Keeps exactly ONE usage_log row per `eventKey` holding the MAX cumulative
 * cost ever submitted for the request, billing only the incremental delta on
 * each flush. A per-key transactional advisory lock serializes concurrent
 * flushes so the read-then-write — including the first insert — is race-free
 * (no two flushes can both believe they are first and clobber each other).
 * An existing row must match the incoming actor, workspace, payer, and billing
 * period before either a duplicate no-op or a top-up is accepted.
 * The billing context is resolved BEFORE the transaction and the lock wait is
 * bounded by `lock_timeout`. A server-enforced transaction deadline, or idle
 * transaction deadline on older PostgreSQL, releases a stalled holder. The
 * critical section uses one SELECT plus one INSERT/UPDATE on a single connection.
 *
 * Because every leg flushes its cumulative and this converges to the max,
 * there is no under-billing if the request recovers after a partial flush, no
 * over-billing from duplicate/abort-race flushes, and no lost billing if the
 * process dies between legs — each leg's cost is durably recorded as it lands.
 */
export async function recordCumulativeUsage(
  params: RecordCumulativeUsageParams
): Promise<RecordCumulativeUsageResult> {
  const {
    userId,
    workspaceId,
    billingEntity,
    billingPeriod,
    source,
    model,
    cost,
    eventKey,
    metadata,
    chatId,
    runId,
    provider,
    vendor,
    pricingSnapshot,
    occurredAt,
    parentExecutionId,
    rootExecutionId,
    triggeringChatId,
    triggeringRunId,
    executionActor,
    payerSubscriptionId,
  } = params

  const canonicalModel = normalizeUsageModelId(model)
  const envMultiplier = getUsageLogCostMultiplier()

  if (workspaceId && (!billingEntity || !billingPeriod)) {
    throw new Error('Workspace usage requires an explicit billing entity and billing period')
  }

  const billingContext = await resolveBillingContext(userId, billingEntity, billingPeriod)

  const startedAt = Date.now()
  let stage: CumulativeUsageStage = 'pool'
  let stageStartedAt = startedAt
  const stageDurationsMs: Partial<Record<CumulativeUsageStage, number>> = {}
  let succeeded = false
  let pgCode: string | undefined
  let toppedUpRowCreatedAt: Date | undefined
  const enterStage = (nextStage: CumulativeUsageStage) => {
    const now = Date.now()
    stageDurationsMs[stage] = now - stageStartedAt
    stage = nextStage
    stageStartedAt = now
  }

  try {
    const result = await db.transaction(async (tx) => {
      enterStage('configure')
      await tx.execute(sql`
        select
          set_config(
            case when current_setting('transaction_timeout', true) is null
              then 'idle_in_transaction_session_timeout'
              else 'transaction_timeout'
            end,
            ${`${CUMULATIVE_FLUSH_TRANSACTION_TIMEOUT_MS}ms`},
            true
          ),
          set_config('statement_timeout', ${`${CUMULATIVE_FLUSH_STATEMENT_TIMEOUT_MS}ms`}, true),
          set_config('lock_timeout', ${`${CUMULATIVE_FLUSH_LOCK_TIMEOUT_MS}ms`}, true)
      `)
      enterStage('lock')
      await acquireAdvisoryXactLock(tx, 'usage_log_event', eventKey)

      enterStage('read')
      const rows = await tx
        .select({
          id: usageLog.id,
          eventKey: usageLog.eventKey,
          cost: usageLog.cost,
          rawCost: usageLog.rawCost,
          pricingSnapshot: usageLog.pricingSnapshot,
          metadata: usageLog.metadata,
          userId: usageLog.userId,
          workspaceId: usageLog.workspaceId,
          billingEntityType: usageLog.billingEntityType,
          billingEntityId: usageLog.billingEntityId,
          billingPeriodStart: usageLog.billingPeriodStart,
          billingPeriodEnd: usageLog.billingPeriodEnd,
          chatId: usageLog.chatId,
          runId: usageLog.runId,
          actorUserId: usageLog.actorUserId,
          actorType: usageLog.actorType,
          parentExecutionId: usageLog.parentExecutionId,
          rootExecutionId: usageLog.rootExecutionId,
          triggeringChatId: usageLog.triggeringChatId,
          triggeringRunId: usageLog.triggeringRunId,
          createdAt: usageLog.createdAt,
        })
        .from(usageLog)
        .where(
          payerSubscriptionId
            ? inArray(
                usageLog.eventKey,
                Array.from({ length: MAX_CUMULATIVE_PERIOD_ROWS }, (_, index) =>
                  cumulativePeriodEventKey(eventKey, index)
                )
              )
            : eq(usageLog.eventKey, eventKey)
        )
        .limit(MAX_CUMULATIVE_PERIOD_ROWS)

      // Period rows are written in order under this lock, so they are the keys 0..n-1.
      const chain = payerSubscriptionId
        ? Array.from({ length: rows.length }, (_, index) =>
            rows.find((row) => row.eventKey === cumulativePeriodEventKey(eventKey, index))
          ).filter((row) => row !== undefined)
        : rows.slice(0, 1)
      if (payerSubscriptionId && chain.length !== rows.length) {
        throw new Error(`Cumulative usage event "${eventKey}" has a gap in its period rows`)
      }
      const [anchor] = chain
      if (anchor) {
        assertCumulativeUsageLedgerBinding(anchor, {
          userId,
          workspaceId,
          billingContext,
          eventKey,
          allowLaterPeriod: Boolean(payerSubscriptionId),
        })
      }

      const latest = chain.at(-1)
      const latestPeriod =
        latest?.billingPeriodStart && latest.billingPeriodEnd
          ? { start: latest.billingPeriodStart, end: latest.billingPeriodEnd }
          : billingContext.billingPeriod
      const recordedRaw = Number(
        chain
          .reduce((sum, row) => sum + Number.parseFloat(row.rawCost ?? row.cost), 0)
          .toFixed(PERIOD_COST_DECIMALS)
      )
      const { shouldBill, delta, newTotal } = resolveCumulativeTopUp(recordedRaw, cost)
      const incomingAttribution = {
        workspaceId,
        chatId,
        runId,
        parentExecutionId,
        rootExecutionId,
        triggeringChatId,
        triggeringRunId,
        executionActor,
      }

      if (!shouldBill) {
        if (latest) {
          const nullFill = buildNullOnlyAttributionFill(latest, incomingAttribution)
          if (Object.keys(nullFill).length > 0) {
            await tx.update(usageLog).set(nullFill).where(eq(usageLog.id, latest.id))
          }
        }
        enterStage('commit')
        return { billed: false, delta: 0, total: recordedRaw, billingPeriod: latestPeriod }
      }

      // The payer's current period and close marker, share-locked so a change to either (a
      // rollover, an anchor reset inside the old period, or a terminal settlement) waits for this
      // write to commit, and whatever a close later sums for the old period is final.
      const [currentPeriod] = payerSubscriptionId
        ? await tx
            .select({
              start: subscriptionTable.periodStart,
              end: subscriptionTable.periodEnd,
              closedThrough: subscriptionTable.lastClosedPeriodStart,
            })
            .from(subscriptionTable)
            .where(eq(subscriptionTable.id, payerSubscriptionId))
            .for('share')
            .limit(1)
        : []

      // Only ever forward: a subscription period that does not start after the latest row's
      // keeps topping up that row, whatever the wall clock or a replayed webhook says. A start
      // that moved forward inside the old period (anchor reset, resync) still rolls, so the old
      // period's close is never topped up after the fact.
      const rolledPeriod =
        currentPeriod?.start &&
        currentPeriod.end &&
        currentPeriod.start.getTime() > latestPeriod.start.getTime()
          ? { start: currentPeriod.start, end: currentPeriod.end }
          : null
      if (rolledPeriod && latest && chain.length >= MAX_CUMULATIVE_PERIOD_ROWS) {
        throw new Error(`Cumulative usage event "${eventKey}" spans too many billing periods`)
      }
      // A marker at or past the target period's end means that period is already settled — a
      // terminal settlement marks it whatever the subscription's bounds — so nothing would
      // ever invoice this charge.
      const targetPeriod = rolledPeriod ?? latestPeriod
      if (
        currentPeriod?.closedThrough &&
        currentPeriod.closedThrough.getTime() >= targetPeriod.end.getTime()
      ) {
        throw new CumulativeUsagePeriodClosedError(eventKey, targetPeriod)
      }

      enterStage('write')
      if (latest && !rolledPeriod) {
        const otherRows = chain.slice(0, -1)
        const otherRaw = Number(
          otherRows
            .reduce((sum, row) => sum + Number.parseFloat(row.rawCost ?? row.cost), 0)
            .toFixed(PERIOD_COST_DECIMALS)
        )
        const latestRaw =
          otherRows.length === 0
            ? newTotal
            : Number((newTotal - otherRaw).toFixed(PERIOD_COST_DECIMALS))
        const snapshotMultiplier = toNumberOrNull(
          toRecordOrNull(latest.pricingSnapshot)?.multiplier
        )
        const lockedMultiplier =
          snapshotMultiplier != null && snapshotMultiplier > 0 ? snapshotMultiplier : envMultiplier
        const latestBillable = lockedMultiplier === 1 ? latestRaw : latestRaw * lockedMultiplier
        await tx
          .update(usageLog)
          .set({
            cost: latestBillable.toString(),
            rawCost: latestRaw.toString(),
            billableCost: latestBillable.toString(),
            billable: latestRaw > 0,
            metadata: periodUsageMetadata(metadata, otherRows) ?? null,
            ...buildNullOnlyAttributionFill(latest, incomingAttribution),
          })
          .where(eq(usageLog.id, latest.id))
        toppedUpRowCreatedAt = latest.createdAt
        enterStage('commit')
        return { billed: true, delta, total: newTotal, billingPeriod: latestPeriod }
      }

      const rowMetadata = periodUsageMetadata(metadata, chain)
      await recordUsage({
        userId,
        workspaceId,
        chatId,
        runId,
        occurredAt,
        parentExecutionId,
        rootExecutionId: rootExecutionId ?? parentExecutionId,
        triggeringChatId,
        triggeringRunId,
        executionActor,
        tx,
        billingEntity: billingContext.billingEntity,
        billingPeriod: targetPeriod,
        entries: [
          {
            category: 'model',
            source,
            description: model,
            cost: chain.length === 0 ? newTotal : Number(delta.toFixed(PERIOD_COST_DECIMALS)),
            eventKey: cumulativePeriodEventKey(eventKey, chain.length),
            sourceReference: eventKey,
            ...(rowMetadata ? { metadata: rowMetadata } : {}),
            ...(provider ? { provider } : {}),
            ...(vendor ? { vendor } : {}),
            ...(pricingSnapshot ? { pricingSnapshot } : {}),
          },
        ],
      })
      enterStage('commit')
      return {
        billed: true,
        delta,
        total: newTotal,
        billingPeriod: { start: targetPeriod.start, end: targetPeriod.end },
      }
    })
    succeeded = true
    if (toppedUpRowCreatedAt) {
      invalidatePayerPrefixesForTopUp(billingContext.billingEntity, toppedUpRowCreatedAt)
    }
    return result
  } catch (error) {
    pgCode = getPostgresErrorCode(error)
    if (pgCode === '55P03') {
      logUsageSkip(
        'advisory_lock_timeout',
        { userId, eventKey, source, model: canonicalModel },
        'error'
      )
    }
    throw error
  } finally {
    const now = Date.now()
    stageDurationsMs[stage] = now - stageStartedAt
    const durationMs = now - startedAt
    if (!succeeded || durationMs >= CUMULATIVE_FLUSH_SLOW_MS) {
      logger.warn('Cumulative usage transaction did not complete promptly', {
        eventKey,
        succeeded,
        stage,
        durationMs,
        stageDurationsMs,
        ...(pgCode ? { pgCode } : {}),
      })
    }
  }
}

interface UsageLogFilter {
  source?: UsageLogSource | UsageLogSource[]
  /** When set, filters to any of these sources (takes precedence over `source`). */
  sources?: UsageLogSource[]
  workspaceId?: string
  startDate?: Date
  /**
   * Inclusive by default, which is what the personal credit-usage surfaces have
   * always meant by it.
   */
  endDate?: Date
  /**
   * Treat {@link endDate} as exclusive instead.
   *
   * Analytics windows are half-open `[start, end)` — a billing period's end
   * instant is the next period's start — so a row stamped exactly on the
   * boundary belongs to the next window. Without this the event list and the
   * export counted it while the summary and breakdowns did not, and the two
   * disagreed by one row at exactly the moment a period rolls over.
   */
  endDateExclusive?: boolean
  /**
   * Match the stamped billing period instead of a `created_at` range.
   *
   * A stripe or default period is what rows are *stamped* with, and that is the
   * predicate every analytics read uses for it. Filtering the same window on
   * `created_at` selects a different set — a row created inside the period but
   * stamped to another, or the reverse — so the event list and the CSV covered
   * different rows than the totals above them. Mutually exclusive with
   * {@link startDate}/{@link endDate}; a reporting period and a plain range still
   * use those, exactly as `buildUsageAnalyticsScope` does.
   */
  billingPeriod?: { start: Date; end: Date }
}

type UsageLogScope =
  | { kind: 'user'; userId: string }
  | { kind: 'workspace'; workspaceId: string }
  /** Every event billed to a payer, regardless of which actor or workspace produced it. */
  | { kind: 'billingEntity'; entity: BillingEntity }

function scopeCondition(scope: UsageLogScope) {
  if (scope.kind === 'user') return eq(usageLog.userId, scope.userId)
  if (scope.kind === 'workspace') return eq(usageLog.workspaceId, scope.workspaceId)
  return and(
    eq(usageLog.billingEntityType, scope.entity.type),
    eq(usageLog.billingEntityId, scope.entity.id)
  )
}

function buildUsageLogConditions(scope: UsageLogScope, filter: UsageLogFilter) {
  const conditions = [scopeCondition(scope)]
  if (filter.sources && filter.sources.length > 0) {
    conditions.push(inArray(usageLog.source, filter.sources))
  } else if (filter.source) {
    conditions.push(
      Array.isArray(filter.source)
        ? inArray(usageLog.source, filter.source)
        : eq(usageLog.source, filter.source)
    )
  }
  if (filter.workspaceId) conditions.push(eq(usageLog.workspaceId, filter.workspaceId))
  if (filter.billingPeriod) {
    conditions.push(
      eq(usageLog.billingPeriodStart, filter.billingPeriod.start),
      eq(usageLog.billingPeriodEnd, filter.billingPeriod.end)
    )
    return conditions
  }
  if (filter.startDate) conditions.push(gte(usageLog.createdAt, filter.startDate))
  if (filter.endDate) {
    conditions.push(
      filter.endDateExclusive
        ? lt(usageLog.createdAt, filter.endDate)
        : lte(usageLog.createdAt, filter.endDate)
    )
  }
  return conditions
}

/**
 * Apportions credits across every log matching the filter (not just one
 * page), so a row's `creditCost` is identical everywhere it's shown — the
 * paginated list and the CSV export both call this rather than each
 * apportioning their own subset, which would let the same row disagree
 * between the two (or between pages of the same list) since apportionment
 * depends on the complete set's total.
 */
export async function getUsageCreditsByLogId(
  userId: string,
  filter: UsageLogFilter
): Promise<Record<string, number>> {
  const rows = await dbReplica
    .select({ id: usageLog.id, cost: usageLog.cost })
    .from(usageLog)
    .where(and(...buildUsageLogConditions({ kind: 'user', userId }, filter)))
    .orderBy(desc(usageLog.createdAt), desc(usageLog.id))

  return apportionCredits(
    rows.map((row) => ({ key: row.id, dollars: Number.parseFloat(row.cost) }))
  )
}

/**
 * Caller-facing message for a `cursor` that names no usage event.
 *
 * This ledger's cursor is a raw `usage_log.id` resolved by lookup rather than an
 * opaque keyset cursor, so a value that resolves to no row carries no position at
 * all. Applying no cursor condition in that case — the previous behaviour — restarts
 * the sequence at page 1 while still reporting `hasMore`, so a pager that persisted a
 * cursor across a deploy, or across environments, walks the first page forever and
 * counts the same credits on every lap. Rejecting it makes the failure visible on the
 * request that caused it.
 *
 * The wording deliberately does not reuse `INVALID_CURSOR_MESSAGE`: that message names
 * `sortBy`/`sortOrder`, and this collection accepts neither param, so it would send the
 * caller to look for a knob that does not exist. The actionable half — restart without
 * a cursor — is the same.
 */
export const UNKNOWN_CURSOR_MESSAGE =
  'cursor does not identify a usage event. Restart pagination without a cursor; a cursor is only valid against the ledger it was issued from.'

/**
 * The rejection for an unresolvable `cursor`, classified for both kinds of caller
 * this shared ledger has.
 *
 * The v2 route reads the classification off the `cause` chain
 * (`asOrchestrationError` walks it) and renders the v2 `BAD_REQUEST` envelope. The
 * session-only internal route (`GET /api/users/me/usage-logs`) is a raw
 * `withRouteHandler` with no error policy, and its `readTypedError` matches
 * `instanceof HttpError` only — so an `OrchestrationError` alone would have made a
 * hand-typed `?cursor=` a 500 there. Being both at once is what keeps every surface
 * on 400 without either one having to learn about the other.
 *
 * `message` is the caller-facing constant above, so forwarding it verbatim (which is
 * what `withRouteHandler` does for an `HttpError`) exposes nothing internal.
 */
export class UnknownUsageCursorError extends HttpError {
  readonly statusCode = 400

  constructor() {
    super(UNKNOWN_CURSOR_MESSAGE, {
      cause: new OrchestrationError('validation', UNKNOWN_CURSOR_MESSAGE),
    })
    this.name = 'UnknownUsageCursorError'
  }
}

/**
 * Options for querying usage logs
 */
export interface GetUsageLogsOptions {
  /** Filter by a single source */
  source?: UsageLogSource
  /** Filter by any of these sources (takes precedence over `source`) */
  sources?: UsageLogSource[]
  /** Filter by workspace */
  workspaceId?: string
  /** Start date (inclusive) */
  startDate?: Date
  /** End date (inclusive, unless {@link endDateExclusive}) */
  endDate?: Date
  /**
   * Treat {@link endDate} as exclusive, matching a half-open analytics window.
   * See {@link UsageLogFilter.endDateExclusive}.
   */
  endDateExclusive?: boolean
  /**
   * Match the stamped billing period instead of a `created_at` range, so a
   * ledger listing covers the same rows an analytics read of the same window
   * does. See {@link UsageLogFilter.billingPeriod}.
   */
  billingPeriod?: { start: Date; end: Date }
  /** Maximum number of results */
  limit?: number
  /** Cursor for pagination (log ID) */
  cursor?: string
  /**
   * The cursor row's `createdAt`, when the caller already has it (e.g. a
   * multi-page export loop holding the previous page's rows in memory).
   * Skips the row lookup that would otherwise resolve it from `cursor`.
   */
  cursorCreatedAt?: Date
  keyset?: { sortOrder: ListSortOrder; cursorKeys?: CursorKey[] }
  /**
   * Whether to compute the full-filter `summary` aggregate (default `true`).
   * A cursor-paginated caller collecting every page (e.g. a CSV export) only
   * needs `logs` from each page and would otherwise pay for the same
   * cursor-independent `SUM`/`GROUP BY` scan once per page for a result it
   * never reads — set `false` to skip it.
   */
  includeSummary?: boolean
}

/**
 * Usage log entry returned from queries
 */
interface UsageLogEntry {
  id: string
  createdAt: string
  category: UsageLogCategory
  source: UsageLogSource
  description: string
  metadata?: UsageLogMetadata
  cost: number
  workspaceId?: string
  workflowId?: string
  /** Name of the referenced workflow, when `workflowId` resolves to one. */
  workflowName?: string
  executionId?: string
}

/**
 * Result from getUserUsageLogs
 */
export interface UsageLogsResult {
  logs: UsageLogEntry[]
  /** `{ totalCost: 0, bySource: {} }` when `includeSummary` is `false`. */
  summary: {
    totalCost: number
    bySource: Partial<Record<UsageLogSource, number>>
  }
  pagination: {
    nextCursor?: string
    nextCursorKeys?: CursorKey[] | null
    hasMore: boolean
  }
}

const USAGE_LOG_KEYS = [
  timestampKey(usageLog.createdAt, (row: { createdAt: Date; id: string }) => row.createdAt),
  textKey(usageLog.id, (row: { createdAt: Date; id: string }) => row.id),
]

/**
 * Gets one bounded usage-log page for an explicit actor or workspace scope.
 */
async function getUsageLogs(
  scope: UsageLogScope,
  options: GetUsageLogsOptions = {}
): Promise<UsageLogsResult> {
  const {
    source,
    sources,
    workspaceId,
    startDate,
    endDate,
    endDateExclusive,
    billingPeriod,
    limit = 50,
    cursor,
    cursorCreatedAt,
    keyset,
    includeSummary = true,
  } = options

  try {
    const conditions = buildUsageLogConditions(scope, {
      source,
      sources,
      workspaceId,
      startDate,
      endDate,
      endDateExclusive,
      billingPeriod,
    })

    if (keyset) {
      const after = resumeKeyset(USAGE_LOG_KEYS, keyset.cursorKeys, keyset.sortOrder)
      if (after) conditions.push(after)
    } else if (cursor) {
      let resolvedCursorCreatedAt = cursorCreatedAt

      if (!resolvedCursorCreatedAt) {
        /**
         * Cursor resolution stays on the primary: the page itself reads a
         * load-balanced replica, and a laggier sibling replica missing the
         * cursor row would reject a cursor that is in fact resumable.
         */
        const cursorLog = await db
          .select({ createdAt: usageLog.createdAt })
          .from(usageLog)
          .where(eq(usageLog.id, cursor))
          .limit(1)
        resolvedCursorCreatedAt = cursorLog[0]?.createdAt
      }

      if (!resolvedCursorCreatedAt) throw new UnknownUsageCursorError()

      const cursorCondition = or(
        lt(usageLog.createdAt, resolvedCursorCreatedAt),
        and(eq(usageLog.createdAt, resolvedCursorCreatedAt), lt(usageLog.id, cursor))
      )
      if (cursorCondition) conditions.push(cursorCondition)
    }

    const logs = await dbReplica
      .select({
        id: usageLog.id,
        createdAt: usageLog.createdAt,
        category: usageLog.category,
        source: usageLog.source,
        description: usageLog.description,
        metadata: usageLog.metadata,
        cost: usageLog.cost,
        workspaceId: usageLog.workspaceId,
        workflowId: usageLog.workflowId,
        workflowName: workflow.name,
        executionId: usageLog.executionId,
      })
      .from(usageLog)
      .leftJoin(workflow, eq(usageLog.workflowId, workflow.id))
      .where(and(...conditions))
      .orderBy(
        ...(keyset
          ? listOrderBy(keysetColumns(USAGE_LOG_KEYS), keyset.sortOrder)
          : [desc(usageLog.createdAt), desc(usageLog.id)])
      )
      .limit(limit + 1)

    const hasMore = logs.length > limit
    const page = keyset ? keysetPage(USAGE_LOG_KEYS, logs, limit) : undefined
    const resultLogs = page?.data ?? (hasMore ? logs.slice(0, limit) : logs)

    const transformedLogs: UsageLogEntry[] = resultLogs.map((log) => ({
      id: log.id,
      createdAt: log.createdAt.toISOString(),
      category: log.category as UsageLogCategory,
      source: log.source as UsageLogSource,
      description: log.description,
      ...(log.metadata ? { metadata: log.metadata as UsageLogMetadata } : {}),
      cost: Number.parseFloat(log.cost),
      ...(log.workspaceId ? { workspaceId: log.workspaceId } : {}),
      ...(log.workflowId ? { workflowId: log.workflowId } : {}),
      ...(log.workflowName ? { workflowName: log.workflowName } : {}),
      ...(log.executionId ? { executionId: log.executionId } : {}),
    }))

    const bySource: Record<string, number> = {}
    let totalCost = 0

    if (includeSummary) {
      const summaryConditions = buildUsageLogConditions(scope, {
        source,
        sources,
        workspaceId,
        startDate,
        endDate,
        endDateExclusive,
        billingPeriod,
      })

      const summaryResult = await dbReplica
        .select({
          source: usageLog.source,
          totalCost: sql<string>`SUM(${usageLog.cost})`,
        })
        .from(usageLog)
        .where(and(...summaryConditions))
        .groupBy(usageLog.source)

      for (const row of summaryResult) {
        const sourceCost = Number.parseFloat(row.totalCost || '0')
        bySource[row.source] = sourceCost
        totalCost += sourceCost
      }
    }

    return {
      logs: transformedLogs,
      summary: {
        totalCost,
        bySource,
      },
      pagination: {
        ...(page ? { nextCursorKeys: page.nextCursorKeys } : {}),
        nextCursor:
          hasMore && resultLogs.length > 0 ? resultLogs[resultLogs.length - 1].id : undefined,
        hasMore,
      },
    }
  } catch (error) {
    /**
     * A classified failure is caller-fixable and already carries the message the
     * surface will render, so it is reported as a warning rather than joining the
     * genuine faults this logger's error volume is watched for.
     */
    if (asOrchestrationError(error)) {
      logger.warn('Rejected a usage-log query', { error: toError(error).message, scope })
      throw error
    }
    logger.error('Failed to get usage logs', {
      error: toError(error).message,
      scope,
      options,
    })
    throw error
  }
}

/** Gets usage logs whose actor is the selected user. */
export function getUserUsageLogs(
  userId: string,
  options: GetUsageLogsOptions = {}
): Promise<UsageLogsResult> {
  return getUsageLogs({ kind: 'user', userId }, options)
}

/**
 * Gets every usage event billed to a payer, regardless of actor or workspace.
 *
 * This is the organization-wide ledger the usage panel pages through. It reuses this
 * module's keyset pagination, cursor handling, and workflow-name join rather than
 * reimplementing them — the only thing it adds is the scope predicate.
 */
export function getBillingEntityUsageLogs(
  entity: BillingEntity,
  options: GetUsageLogsOptions = {}
): Promise<UsageLogsResult> {
  return getUsageLogs({ kind: 'billingEntity', entity }, options)
}

/** Gets usage logs attributed to the selected workspace, regardless of actor. */
export function getWorkspaceUsageLogs(
  workspaceId: string,
  options: Omit<GetUsageLogsOptions, 'workspaceId'> = {}
): Promise<UsageLogsResult> {
  return getUsageLogs({ kind: 'workspace', workspaceId }, options)
}
