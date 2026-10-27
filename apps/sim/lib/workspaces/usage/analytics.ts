import { dbReplica } from '@sim/db'
import {
  copilotChats,
  copilotRuns,
  usageLog,
  workflow,
  workflowExecutionLogs,
} from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm'
import {
  type UsageChargeTypeValue,
  usageLogSourceSchema,
  type WorkspaceUsageAnalytics,
} from '@/lib/api/contracts/workspace-usage'
import type { UsageLogSource } from '@/lib/billing/core/usage-log'
import { COPILOT_USAGE_SOURCES } from '@/lib/billing/core/usage-log'
import { dollarsToCredits } from '@/lib/billing/credits/conversion'
import {
  applyEmbeddedToolChargeTypeSplit,
  computeEmbeddedToolVirtualSplit,
  mergeEmbeddedToolBucketRows,
  subtractEmbeddedFromBucketRows,
} from '@/lib/workspaces/usage/embedded-tool-virtual-split'
import {
  buildCopilotByChatTypeQuery,
  buildExecutionConditions,
  buildExpensiveCopilotChatsQuery,
  buildExpensiveWorkflowsQuery,
  buildLedgerConditions,
  buildLedgerJoinConditions,
  bySourceDisplayBucketExpr,
  bySourceDisplayLabelExpr,
  bySourceLedgerSourceExpr,
  byToolBucketIdExpr,
  chargeTypeExpr,
  coerceToDate,
  densifyTimeSeries,
  EMPTY_USAGE_METRICS,
  executionBucketExpr,
  isHumanActorCondition,
  ledgerCostSelect,
  ledgerOccurredAt,
  ledgerPeriodBounds,
  mapBySourceBucketRow,
  mapExpensiveCopilotChatRows,
  mapExpensiveWorkflowRows,
  mapUsageMetrics,
  normalizeBucketKey,
  parseActorType,
  parseChargeType,
  parseChatType,
  parseDecimal,
  parseIntMetric,
  periodRange,
  type ResolvedPeriod,
  resolvedActorTypeExpr,
  resolvedActorUserIdExpr,
  resolveExplicitPeriod,
  resolvePeriodFromDateCandidates,
  shouldUseHourlyTimeBuckets,
  sortByBillableCostDesc,
  timeBucketExpr,
  usageMetricsSelect,
} from '@/lib/workspaces/usage/ledger-helpers'

const logger = createLogger('WorkspaceUsageAnalytics')

const WORKFLOW_SOURCE: UsageLogSource = 'workflow'

export interface WorkspaceUsageAnalyticsOptions {
  workspaceId: string
  startTime?: string
  endTime?: string
  period?: '1d' | '7d' | '30d' | '90d'
  sources?: UsageLogSource[]
  allTime?: boolean
  rootExecutionId?: string
}

async function resolvePeriod(
  workspaceId: string,
  options: WorkspaceUsageAnalyticsOptions
): Promise<ResolvedPeriod> {
  if (options.allTime) {
    const [usageBounds, executionBounds, chatBounds, runBounds] = await Promise.all([
      dbReplica
        .select({
          minAt: sql<Date | null>`min(${ledgerOccurredAt()})`,
          maxAt: sql<Date | null>`max(${ledgerOccurredAt()})`,
        })
        .from(usageLog)
        .where(eq(usageLog.workspaceId, workspaceId)),
      dbReplica
        .select({
          minAt: sql<Date | null>`min(${workflowExecutionLogs.startedAt})`,
          maxAt: sql<Date | null>`max(${workflowExecutionLogs.startedAt})`,
        })
        .from(workflowExecutionLogs)
        .where(eq(workflowExecutionLogs.workspaceId, workspaceId)),
      dbReplica
        .select({
          minAt: sql<Date | null>`min(${copilotChats.createdAt})`,
          maxAt: sql<Date | null>`max(${copilotChats.createdAt})`,
        })
        .from(copilotChats)
        .where(eq(copilotChats.workspaceId, workspaceId)),
      dbReplica
        .select({
          minAt: sql<Date | null>`min(${copilotRuns.startedAt})`,
          maxAt: sql<Date | null>`max(${copilotRuns.startedAt})`,
        })
        .from(copilotRuns)
        .where(eq(copilotRuns.workspaceId, workspaceId)),
    ])

    return resolvePeriodFromDateCandidates([
      usageBounds[0]?.minAt,
      usageBounds[0]?.maxAt,
      executionBounds[0]?.minAt,
      executionBounds[0]?.maxAt,
      chatBounds[0]?.minAt,
      chatBounds[0]?.maxAt,
      runBounds[0]?.minAt,
      runBounds[0]?.maxAt,
    ])
  }

  return resolveExplicitPeriod(options)
}

/**
 * Aggregates workspace usage across the billing ledger, workflow execution logs,
 * and copilot chat/run tables for admin analytics dashboards.
 */
export async function getWorkspaceUsageAnalytics(
  options: WorkspaceUsageAnalyticsOptions
): Promise<WorkspaceUsageAnalytics> {
  const { workspaceId, sources, rootExecutionId } = options

  try {
    const period = await resolvePeriod(workspaceId, options)

    if (Number.isNaN(period.start.getTime()) || Number.isNaN(period.end.getTime())) {
      throw new Error('Invalid time range')
    }

    if (period.start > period.end) {
      throw new Error('Invalid time range')
    }

    const ledgerWorkspaceCondition = eq(usageLog.workspaceId, workspaceId)
    const ledgerConditions = buildLedgerConditions(ledgerWorkspaceCondition, period, sources)
    const ledgerJoinConditions = buildLedgerJoinConditions(ledgerWorkspaceCondition, period)
    const executionConditions = buildExecutionConditions(
      eq(workflowExecutionLogs.workspaceId, workspaceId),
      period
    )
    const useHourlyBuckets = shouldUseHourlyTimeBuckets(options, period)
    const bucketExpr = timeBucketExpr(useHourlyBuckets)
    const executionBucket = executionBucketExpr(useHourlyBuckets)

    const chargeType = chargeTypeExpr()
    const toolBucketId = byToolBucketIdExpr()

    const [
      bySourceRows,
      byChargeTypeRows,
      summaryUsageRows,
      attributionRows,
      workflowExecutionSummary,
      workflowLedgerSummary,
      workflowByTriggerRows,
      expensiveWorkflowRows,
      copilotChatSummary,
      copilotRunSummary,
      copilotByTypeRows,
      copilotByModelRows,
      copilotByChatRows,
      byUserRows,
      byActorRows,
      byModelRows,
      byProviderRows,
      byToolRows,
      copilotModelSpendRows,
      byVendorRows,
      timeSeriesLedgerRows,
      timeSeriesExecutionRows,
      activeUserBucketRows,
      activeUserPeriodRows,
      lineageRootRows,
      lineageDrillDownRows,
      lineageDrillDownTotals,
      triggeredWorkflowRows,
      dataHealthLedgerRows,
      dataHealthExecutionRows,
    ] = await Promise.all([
      dbReplica
        .select({
          source: bySourceLedgerSourceExpr(),
          label: bySourceDisplayLabelExpr(),
          ...ledgerCostSelect(),
          ...usageMetricsSelect(),
        })
        .from(usageLog)
        .where(and(...ledgerConditions))
        .groupBy(
          bySourceDisplayBucketExpr(),
          bySourceLedgerSourceExpr(),
          bySourceDisplayLabelExpr()
        ),

      dbReplica
        .select({
          chargeType,
          ...ledgerCostSelect(),
        })
        .from(usageLog)
        .where(and(...ledgerConditions))
        .groupBy(chargeType),

      dbReplica
        .select(usageMetricsSelect())
        .from(usageLog)
        .where(and(...ledgerConditions)),

      dbReplica
        .select({
          missingChatIdCost: sql<string>`coalesce(sum(case when ${usageLog.source} in (${sql.join(
            COPILOT_USAGE_SOURCES.map((s) => sql`${s}`),
            sql`, `
          )}) and ${usageLog.chatId} is null then ${usageLog.cost}::numeric else 0 end), 0)`,
          missingChatIdCount: sql<number>`count(case when ${usageLog.source} in (${sql.join(
            COPILOT_USAGE_SOURCES.map((s) => sql`${s}`),
            sql`, `
          )}) and ${usageLog.chatId} is null then 1 end)::int`,
          missingChatIdRawCost: sql<string>`coalesce(sum(case when ${usageLog.source} in (${sql.join(
            COPILOT_USAGE_SOURCES.map((s) => sql`${s}`),
            sql`, `
          )}) and ${usageLog.chatId} is null then coalesce(${usageLog.rawCost}, ${usageLog.cost})::numeric else 0 end), 0)`,
          missingExecutionIdCost: sql<string>`coalesce(sum(case when ${usageLog.source} = ${WORKFLOW_SOURCE} and ${usageLog.executionId} is null then ${usageLog.cost}::numeric else 0 end), 0)`,
          missingExecutionIdCount: sql<number>`count(case when ${usageLog.source} = ${WORKFLOW_SOURCE} and ${usageLog.executionId} is null then 1 end)::int`,
          missingExecutionIdRawCost: sql<string>`coalesce(sum(case when ${usageLog.source} = ${WORKFLOW_SOURCE} and ${usageLog.executionId} is null then coalesce(${usageLog.rawCost}, ${usageLog.cost})::numeric else 0 end), 0)`,
        })
        .from(usageLog)
        .where(and(...ledgerConditions)),

      dbReplica
        .select({
          total: sql<number>`count(*)::int`,
          withProjectedCost: sql<number>`count(case when ${workflowExecutionLogs.costTotal} is not null and ${workflowExecutionLogs.costTotal}::numeric > 0 then 1 end)::int`,
          totalProjectedCost: sql<string>`coalesce(sum(${workflowExecutionLogs.costTotal}::numeric), 0)`,
        })
        .from(workflowExecutionLogs)
        .where(and(...executionConditions)),

      dbReplica
        .select({
          totalLedgerCost: sql<string>`coalesce(sum(${usageLog.cost}::numeric), 0)`,
        })
        .from(usageLog)
        .where(
          and(
            ...ledgerConditions,
            eq(usageLog.source, WORKFLOW_SOURCE),
            isNotNull(usageLog.executionId)
          )
        ),

      dbReplica
        .select({
          trigger: workflowExecutionLogs.trigger,
          executionCount: sql<number>`count(distinct ${workflowExecutionLogs.executionId})::int`,
          ...ledgerCostSelect(),
        })
        .from(workflowExecutionLogs)
        .leftJoin(
          usageLog,
          and(
            eq(usageLog.executionId, workflowExecutionLogs.executionId),
            eq(usageLog.source, WORKFLOW_SOURCE),
            ...ledgerJoinConditions
          )
        )
        .where(and(...executionConditions))
        .groupBy(workflowExecutionLogs.trigger),

      buildExpensiveWorkflowsQuery({
        executionScope: eq(workflowExecutionLogs.workspaceId, workspaceId),
        ledgerJoinConditions,
        period,
      }),

      dbReplica
        .select({
          total: sql<number>`count(distinct ${copilotChats.id})::int`,
          withLedgerCost: sql<number>`count(distinct case when ${usageLog.id} is not null then ${copilotChats.id} end)::int`,
        })
        .from(copilotChats)
        .leftJoin(
          copilotRuns,
          and(
            eq(copilotRuns.chatId, copilotChats.id),
            ...periodRange(copilotRuns.startedAt, period)
          )
        )
        .leftJoin(usageLog, and(eq(usageLog.chatId, copilotChats.id), ...ledgerJoinConditions))
        .where(
          and(
            eq(copilotChats.workspaceId, workspaceId),
            or(
              and(...periodRange(copilotChats.createdAt, period)),
              isNotNull(usageLog.id),
              isNotNull(copilotRuns.id)
            )
          )
        ),

      dbReplica
        .select({
          total: sql<number>`count(distinct ${copilotRuns.id})::int`,
        })
        .from(copilotRuns)
        .where(
          and(
            eq(copilotRuns.workspaceId, workspaceId),
            ...periodRange(copilotRuns.startedAt, period)
          )
        ),

      buildCopilotByChatTypeQuery({
        chatScope: eq(copilotChats.workspaceId, workspaceId),
        ledgerJoinConditions,
        period,
        runWorkspaceCondition: eq(copilotRuns.workspaceId, workspaceId),
      }),

      dbReplica
        .select({
          model: copilotChats.model,
          ...ledgerCostSelect(),
        })
        .from(copilotChats)
        .innerJoin(usageLog, eq(usageLog.chatId, copilotChats.id))
        .where(
          and(
            eq(copilotChats.workspaceId, workspaceId),
            ...ledgerJoinConditions,
            inArray(usageLog.source, COPILOT_USAGE_SOURCES)
          )
        )
        .groupBy(copilotChats.model),

      buildExpensiveCopilotChatsQuery({
        chatScope: eq(copilotChats.workspaceId, workspaceId),
        ledgerJoinConditions,
        period,
      }),

      dbReplica
        .select({
          userId: usageLog.userId,
          ...ledgerCostSelect(),
        })
        .from(usageLog)
        .where(and(...ledgerConditions))
        .groupBy(usageLog.userId),

      dbReplica
        .select({
          actorUserId: sql<string | null>`${resolvedActorUserIdExpr()}`,
          actorType: sql<string | null>`${resolvedActorTypeExpr()}`,
          ...ledgerCostSelect(),
          ...usageMetricsSelect(),
        })
        .from(usageLog)
        .leftJoin(copilotChats, eq(copilotChats.id, usageLog.chatId))
        .where(and(...ledgerConditions))
        .groupBy(resolvedActorUserIdExpr(), resolvedActorTypeExpr()),

      // Model & tool usage is workflow-oriented. Mothership/copilot spend
      // (including home chat billed as description "mothership") lives under
      // the Mothership & copilot section via COPILOT_USAGE_SOURCES.
      dbReplica
        .select({
          model: usageLog.description,
          ...ledgerCostSelect(),
        })
        .from(usageLog)
        .where(
          and(
            ...ledgerConditions,
            eq(usageLog.category, 'model'),
            notInArray(usageLog.source, COPILOT_USAGE_SOURCES)
          )
        )
        .groupBy(usageLog.description),

      dbReplica
        .select({
          provider: usageLog.provider,
          ...ledgerCostSelect(),
        })
        .from(usageLog)
        .where(and(...ledgerConditions, isNotNull(usageLog.provider)))
        .groupBy(usageLog.provider),

      dbReplica
        .select({
          toolId: toolBucketId,
          ...ledgerCostSelect(),
        })
        .from(usageLog)
        .where(and(...ledgerConditions, eq(usageLog.category, 'tool'), isNotNull(usageLog.toolId)))
        .groupBy(toolBucketId),

      dbReplica
        .select(ledgerCostSelect())
        .from(usageLog)
        .where(
          and(
            ...ledgerConditions,
            eq(usageLog.category, 'model'),
            inArray(usageLog.source, COPILOT_USAGE_SOURCES)
          )
        ),

      dbReplica
        .select({
          vendor: sql<string>`coalesce(${usageLog.vendor}, ${usageLog.description})`,
          ...ledgerCostSelect(),
        })
        .from(usageLog)
        .where(and(...ledgerConditions, eq(usageLog.category, 'external')))
        .groupBy(sql`coalesce(${usageLog.vendor}, ${usageLog.description})`),

      dbReplica
        .select({
          bucketStart: bucketExpr,
          ...ledgerCostSelect(),
          ...usageMetricsSelect(),
        })
        .from(usageLog)
        .where(and(...ledgerConditions))
        .groupBy(bucketExpr),

      dbReplica
        .select({
          bucketStart: executionBucket,
          executionCount: sql<number>`count(*)::int`,
        })
        .from(workflowExecutionLogs)
        .where(and(...executionConditions))
        .groupBy(executionBucket),

      dbReplica
        .select({
          bucketStart: bucketExpr,
          activeUserCount: sql<number>`count(distinct ${resolvedActorUserIdExpr()})::int`,
        })
        .from(usageLog)
        .leftJoin(copilotChats, eq(copilotChats.id, usageLog.chatId))
        .where(and(...ledgerConditions, isHumanActorCondition()))
        .groupBy(bucketExpr),

      dbReplica
        .select({
          activeUserCount: sql<number>`count(distinct ${resolvedActorUserIdExpr()})::int`,
        })
        .from(usageLog)
        .leftJoin(copilotChats, eq(copilotChats.id, usageLog.chatId))
        .where(and(...ledgerConditions, isHumanActorCondition())),

      dbReplica
        .select({
          rootExecutionId: workflowExecutionLogs.rootExecutionId,
          executionCount: sql<number>`count(distinct ${workflowExecutionLogs.executionId})::int`,
          inclusiveBillableCost: sql<string>`coalesce(sum(${usageLog.cost}::numeric), 0)`,
          inclusiveRawCost: sql<string>`coalesce(sum(coalesce(${usageLog.rawCost}, ${usageLog.cost})::numeric), 0)`,
        })
        .from(workflowExecutionLogs)
        .leftJoin(
          usageLog,
          and(
            eq(usageLog.executionId, workflowExecutionLogs.executionId),
            eq(usageLog.source, WORKFLOW_SOURCE),
            ...ledgerJoinConditions
          )
        )
        .where(and(...executionConditions, isNotNull(workflowExecutionLogs.rootExecutionId)))
        .groupBy(workflowExecutionLogs.rootExecutionId),

      rootExecutionId
        ? dbReplica
            .select({
              executionId: workflowExecutionLogs.executionId,
              parentExecutionId: workflowExecutionLogs.parentExecutionId,
              workflowId: workflowExecutionLogs.workflowId,
              workflowName: workflow.name,
              startedAt: workflowExecutionLogs.startedAt,
              trigger: workflowExecutionLogs.trigger,
              actorUserId: workflowExecutionLogs.actorUserId,
              actorType: workflowExecutionLogs.actorType,
              billableCost: sql<string>`coalesce(sum(${usageLog.cost}::numeric), 0)`,
              rawCost: sql<string>`coalesce(sum(coalesce(${usageLog.rawCost}, ${usageLog.cost})::numeric), 0)`,
            })
            .from(workflowExecutionLogs)
            .leftJoin(workflow, eq(workflow.id, workflowExecutionLogs.workflowId))
            .leftJoin(
              usageLog,
              and(
                eq(usageLog.executionId, workflowExecutionLogs.executionId),
                eq(usageLog.source, WORKFLOW_SOURCE),
                ...ledgerJoinConditions
              )
            )
            .where(
              and(
                eq(workflowExecutionLogs.workspaceId, workspaceId),
                or(
                  eq(workflowExecutionLogs.rootExecutionId, rootExecutionId),
                  eq(workflowExecutionLogs.executionId, rootExecutionId)
                )
              )
            )
            .groupBy(
              workflowExecutionLogs.executionId,
              workflowExecutionLogs.parentExecutionId,
              workflowExecutionLogs.workflowId,
              workflow.name,
              workflowExecutionLogs.startedAt,
              workflowExecutionLogs.trigger,
              workflowExecutionLogs.actorUserId,
              workflowExecutionLogs.actorType
            )
        : Promise.resolve([]),

      rootExecutionId
        ? dbReplica
            .select({
              inclusiveBillableCost: sql<string>`coalesce(sum(${usageLog.cost}::numeric), 0)`,
              inclusiveRawCost: sql<string>`coalesce(sum(coalesce(${usageLog.rawCost}, ${usageLog.cost})::numeric), 0)`,
            })
            .from(usageLog)
            .where(
              and(
                eq(usageLog.workspaceId, workspaceId),
                eq(usageLog.source, WORKFLOW_SOURCE),
                or(
                  eq(usageLog.rootExecutionId, rootExecutionId),
                  eq(usageLog.executionId, rootExecutionId)
                ),
                ...ledgerJoinConditions
              )
            )
        : Promise.resolve([]),

      dbReplica
        .select({
          triggeringChatId: workflowExecutionLogs.triggeringChatId,
          executionCount: sql<number>`count(distinct ${workflowExecutionLogs.executionId})::int`,
          billableCost: sql<string>`coalesce(sum(${usageLog.cost}::numeric), 0)`,
          rawCost: sql<string>`coalesce(sum(coalesce(${usageLog.rawCost}, ${usageLog.cost})::numeric), 0)`,
        })
        .from(workflowExecutionLogs)
        .leftJoin(
          usageLog,
          and(
            eq(usageLog.executionId, workflowExecutionLogs.executionId),
            eq(usageLog.source, WORKFLOW_SOURCE),
            ...ledgerJoinConditions
          )
        )
        .where(and(...executionConditions, isNotNull(workflowExecutionLogs.triggeringChatId)))
        .groupBy(workflowExecutionLogs.triggeringChatId),

      dbReplica
        .select({
          totalRows: sql<number>`count(*)::int`,
          nullWorkspaceRows: sql<number>`count(case when ${usageLog.workspaceId} is null then 1 end)::int`,
          missingActorRows: sql<number>`count(case when ${usageLog.actorUserId} is null or ${usageLog.actorType} is null then 1 end)::int`,
        })
        .from(usageLog)
        .where(
          and(
            or(eq(usageLog.workspaceId, workspaceId), isNull(usageLog.workspaceId)),
            ...ledgerPeriodBounds(period)
          )
        ),

      dbReplica
        .select({
          executionsWithCostNoLedger: sql<number>`count(case when coalesce(${workflowExecutionLogs.costTotal}::numeric, 0) > 0 and coalesce(ledger.ledger_sum, 0) = 0 then 1 end)::int`,
          costTotalDriftCount: sql<number>`count(case when abs(coalesce(${workflowExecutionLogs.costTotal}::numeric, 0) - coalesce(ledger.ledger_sum, 0)) > 0.000001 then 1 end)::int`,
        })
        .from(workflowExecutionLogs)
        .leftJoin(
          sql`(
            select
              ${usageLog.executionId} as execution_id,
              sum(${usageLog.cost}::numeric) as ledger_sum
            from ${usageLog}
            where ${usageLog.workspaceId} = ${workspaceId}
              and ${usageLog.source} = ${WORKFLOW_SOURCE}
              and ${usageLog.executionId} is not null
            group by ${usageLog.executionId}
          ) ledger`,
          sql`ledger.execution_id = ${workflowExecutionLogs.executionId}`
        )
        .where(
          and(
            ...executionConditions,
            inArray(workflowExecutionLogs.status, ['completed', 'failed', 'cancelled'])
          )
        ),
    ])

    const modelMetadataRows = await dbReplica
      .select({
        executionId: usageLog.executionId,
        description: usageLog.description,
        provider: usageLog.provider,
        cost: usageLog.cost,
        rawCost: usageLog.rawCost,
        metadata: usageLog.metadata,
      })
      .from(usageLog)
      .where(
        and(...ledgerConditions, eq(usageLog.category, 'model'), isNotNull(usageLog.executionId))
      )

    const embeddedToolSplit = computeEmbeddedToolVirtualSplit(modelMetadataRows)

    const bySource = sortByBillableCostDesc(
      bySourceRows.flatMap((row) => {
        const mapped = mapBySourceBucketRow(row)
        if (!mapped) {
          logger.warn('Skipping bySource row with invalid ledger source', {
            workspaceId,
            source: row.source,
          })
          return []
        }
        return [mapped]
      })
    )

    const CHARGE_TYPE_ORDER: UsageChargeTypeValue[] = [
      'base_run',
      'provider',
      'tool',
      'cost_block',
      'mothership',
      'other',
    ]
    const byChargeType = applyEmbeddedToolChargeTypeSplit(
      byChargeTypeRows
        .map((row) => ({
          chargeType: parseChargeType(row.chargeType),
          billableCost: parseDecimal(row.billableCost),
          rawCost: parseDecimal(row.rawCost),
          count: parseIntMetric(row.count),
        }))
        .sort(
          (a, b) =>
            CHARGE_TYPE_ORDER.indexOf(a.chargeType) - CHARGE_TYPE_ORDER.indexOf(b.chargeType)
        ),
      embeddedToolSplit
    )

    const totalBillableCost = bySource.reduce((sum, row) => sum + row.billableCost, 0)
    const totalRawCost = bySource.reduce((sum, row) => sum + row.rawCost, 0)
    const ledgerEntryCount = bySource.reduce((sum, row) => sum + row.count, 0)
    const summaryUsage = mapUsageMetrics(summaryUsageRows[0] ?? {})

    const attribution = attributionRows[0]
    const workflowSummary = workflowExecutionSummary[0]
    const workflowLedger = workflowLedgerSummary[0]
    const chatSummary = copilotChatSummary[0]
    const runSummary = copilotRunSummary[0]

    const executionCountByBucket = new Map(
      timeSeriesExecutionRows.map((row) => [
        coerceToDate(row.bucketStart)?.toISOString() ?? String(row.bucketStart),
        parseIntMetric(row.executionCount),
      ])
    )

    const activeUserCountByBucket = new Map(
      activeUserBucketRows.map((row) => [
        coerceToDate(row.bucketStart)?.toISOString() ?? String(row.bucketStart),
        parseIntMetric(row.activeUserCount),
      ])
    )

    const timeSeries = timeSeriesLedgerRows.map((row) => {
      const bucketStart = coerceToDate(row.bucketStart)?.toISOString() ?? String(row.bucketStart)
      return {
        bucketStart,
        billableCost: parseDecimal(row.billableCost),
        rawCost: parseDecimal(row.rawCost),
        executionCount: executionCountByBucket.get(bucketStart) ?? 0,
        activeUserCount: activeUserCountByBucket.get(bucketStart) ?? 0,
        usage: mapUsageMetrics(row),
      }
    })

    for (const row of timeSeriesExecutionRows) {
      const bucketStart = coerceToDate(row.bucketStart)?.toISOString() ?? String(row.bucketStart)
      if (!timeSeries.some((bucket) => bucket.bucketStart === bucketStart)) {
        timeSeries.push({
          bucketStart,
          billableCost: 0,
          rawCost: 0,
          executionCount: row.executionCount,
          activeUserCount: activeUserCountByBucket.get(bucketStart) ?? 0,
          usage: { ...EMPTY_USAGE_METRICS },
        })
      }
    }

    for (const row of activeUserBucketRows) {
      const bucketStart = coerceToDate(row.bucketStart)?.toISOString() ?? String(row.bucketStart)
      if (!timeSeries.some((bucket) => bucket.bucketStart === bucketStart)) {
        timeSeries.push({
          bucketStart,
          billableCost: 0,
          rawCost: 0,
          executionCount: 0,
          activeUserCount: row.activeUserCount,
          usage: { ...EMPTY_USAGE_METRICS },
        })
      }
    }

    const densifiedTimeSeries = densifyTimeSeries(timeSeries, period, useHourlyBuckets)

    const periodActiveUserCount = activeUserPeriodRows[0]?.activeUserCount ?? 0

    const triggeredWorkflowTotal = triggeredWorkflowRows.reduce(
      (acc, row) => ({
        executionCount: acc.executionCount + parseIntMetric(row.executionCount),
        billableCost: acc.billableCost + parseDecimal(row.billableCost),
        rawCost: acc.rawCost + parseDecimal(row.rawCost),
      }),
      { executionCount: 0, billableCost: 0, rawCost: 0 }
    )

    const dataHealthLedger = dataHealthLedgerRows[0]
    const dataHealthExecution = dataHealthExecutionRows[0]
    const totalLedgerRows = dataHealthLedger?.totalRows ?? 0
    const missingActorRows = dataHealthLedger?.missingActorRows ?? 0
    const nullWorkspaceRows = dataHealthLedger?.nullWorkspaceRows ?? 0
    const executionsWithCostNoLedger = dataHealthExecution?.executionsWithCostNoLedger ?? 0
    const costTotalDriftCount = dataHealthExecution?.costTotalDriftCount ?? 0

    const warnings: WorkspaceUsageAnalytics['dataHealth']['warnings'] = []

    if (nullWorkspaceRows > 0) {
      warnings.push({
        id: 'null-workspace-id',
        severity: 'error',
        label: 'Ledger rows missing workspace',
        count: nullWorkspaceRows,
        detail: 'usage_log.workspace_id is null for rows in this period.',
      })
    }

    if (executionsWithCostNoLedger > 0) {
      warnings.push({
        id: 'executions-cost-no-ledger',
        severity: 'warning',
        label: 'Executions with cost but no ledger',
        count: executionsWithCostNoLedger,
        detail: 'workflow_execution_logs.cost_total > 0 with no matching workflow ledger rows.',
      })
    }

    if (costTotalDriftCount > 0) {
      warnings.push({
        id: 'cost-total-drift',
        severity: 'warning',
        label: 'Execution cost vs ledger drift',
        count: costTotalDriftCount,
        detail: 'cost_total does not match the sum of workflow ledger rows.',
      })
    }

    if (missingActorRows > 0) {
      warnings.push({
        id: 'missing-actor-attribution',
        severity: 'warning',
        label: 'Rows missing actor attribution',
        count: missingActorRows,
        detail: 'actor_user_id or actor_type is null — common for pre-cutover data.',
      })
    }

    const limitedAttribution = totalLedgerRows > 0 && missingActorRows / totalLedgerRows > 0.1

    const drillDownTotals = lineageDrillDownTotals[0]
    const drillDown =
      rootExecutionId && lineageDrillDownRows.length > 0
        ? {
            rootExecutionId,
            inclusiveBillableCost: parseDecimal(drillDownTotals?.inclusiveBillableCost),
            inclusiveRawCost: parseDecimal(drillDownTotals?.inclusiveRawCost),
            executions: lineageDrillDownRows
              .map((row) => ({
                executionId: row.executionId,
                parentExecutionId: row.parentExecutionId,
                workflowId: row.workflowId,
                workflowName: row.workflowName,
                startedAt: coerceToDate(row.startedAt)?.toISOString() ?? String(row.startedAt),
                trigger: row.trigger ?? 'unknown',
                billableCost: parseDecimal(row.billableCost),
                rawCost: parseDecimal(row.rawCost),
                actorUserId: row.actorUserId,
                actorType: parseActorType(row.actorType),
              }))
              .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
          }
        : undefined

    return {
      period: {
        startTime: period.start.toISOString(),
        endTime: period.end.toISOString(),
      },
      summary: {
        billableCost: totalBillableCost,
        rawCost: totalRawCost,
        billableCostCredits: dollarsToCredits(totalBillableCost),
        ledgerEntryCount,
        executionCount: parseIntMetric(workflowSummary?.total),
        chatCount: parseIntMetric(chatSummary?.total),
        runCount: parseIntMetric(runSummary?.total),
        activeUserCount: parseIntMetric(periodActiveUserCount),
        usage: summaryUsage,
      },
      bySource,
      byChargeType,
      attribution: {
        missingChatId: {
          billableCost: parseDecimal(attribution?.missingChatIdCost),
          rawCost: parseDecimal(attribution?.missingChatIdRawCost),
          count: parseIntMetric(attribution?.missingChatIdCount),
        },
        missingExecutionId: {
          billableCost: parseDecimal(attribution?.missingExecutionIdCost),
          rawCost: parseDecimal(attribution?.missingExecutionIdRawCost),
          count: parseIntMetric(attribution?.missingExecutionIdCount),
        },
      },
      workflow: {
        executions: {
          total: parseIntMetric(workflowSummary?.total),
          withProjectedCost: parseIntMetric(workflowSummary?.withProjectedCost),
          totalProjectedCost: parseDecimal(workflowSummary?.totalProjectedCost),
          totalLedgerCost: parseDecimal(workflowLedger?.totalLedgerCost),
        },
        byTrigger: sortByBillableCostDesc(
          workflowByTriggerRows.map((row) => ({
            trigger: normalizeBucketKey(row.trigger, 'unknown'),
            executionCount: parseIntMetric(row.executionCount),
            billableCost: parseDecimal(row.billableCost),
            rawCost: parseDecimal(row.rawCost),
            count: parseIntMetric(row.count),
          }))
        ),
        byWorkflow: mapExpensiveWorkflowRows(expensiveWorkflowRows).map((row) => ({
          workflowId: row.workflowId,
          workflowName: row.workflowName,
          executionCount: parseIntMetric(row.executionCount),
          billableCost: row.billableCost,
          rawCost: row.rawCost,
          count: parseIntMetric(row.count),
        })),
      },
      copilot: {
        chats: {
          total: parseIntMetric(chatSummary?.total),
          withLedgerCost: parseIntMetric(chatSummary?.withLedgerCost),
        },
        runs: {
          total: parseIntMetric(runSummary?.total),
        },
        byChatType: sortByBillableCostDesc(
          copilotByTypeRows.map((row) => ({
            chatType: parseChatType(row.chatType),
            chatCount: parseIntMetric(row.chatCount),
            runCount: parseIntMetric(row.runCount),
            billableCost: parseDecimal(row.billableCost),
            rawCost: parseDecimal(row.rawCost),
            count: parseIntMetric(row.count),
          }))
        ),
        byChat: mapExpensiveCopilotChatRows(
          copilotByChatRows.filter(
            (row): row is typeof row & { workspaceId: string } => row.workspaceId !== null
          )
        ).map((row) => ({
          chatId: row.chatId,
          title: row.title,
          chatType: row.chatType,
          userId: row.userId,
          runCount: parseIntMetric(row.runCount),
          billableCost: row.billableCost,
          rawCost: row.rawCost,
          count: parseIntMetric(row.count),
        })),
        byModel: sortByBillableCostDesc(
          copilotByModelRows.map((row) => ({
            model: normalizeBucketKey(row.model),
            billableCost: parseDecimal(row.billableCost),
            rawCost: parseDecimal(row.rawCost),
            count: parseIntMetric(row.count),
          }))
        ),
        modelSpend: {
          billableCost: parseDecimal(copilotModelSpendRows[0]?.billableCost),
          rawCost: parseDecimal(copilotModelSpendRows[0]?.rawCost),
          count: parseIntMetric(copilotModelSpendRows[0]?.count),
        },
        triggeredWorkflows: {
          executionCount: triggeredWorkflowTotal.executionCount,
          billableCost: triggeredWorkflowTotal.billableCost,
          rawCost: triggeredWorkflowTotal.rawCost,
          byChat: sortByBillableCostDesc(
            triggeredWorkflowRows
              .filter(
                (row): row is typeof row & { triggeringChatId: string } =>
                  row.triggeringChatId !== null
              )
              .map((row) => ({
                triggeringChatId: row.triggeringChatId,
                executionCount: parseIntMetric(row.executionCount),
                billableCost: parseDecimal(row.billableCost),
                rawCost: parseDecimal(row.rawCost),
              }))
          ),
        },
      },
      byUser: sortByBillableCostDesc(
        byUserRows.map((row) => ({
          userId: row.userId,
          billableCost: parseDecimal(row.billableCost),
          rawCost: parseDecimal(row.rawCost),
          count: parseIntMetric(row.count),
        }))
      ),
      byActor: sortByBillableCostDesc(
        byActorRows.map((row) => ({
          actorUserId: row.actorUserId,
          actorType: parseActorType(row.actorType),
          billableCost: parseDecimal(row.billableCost),
          rawCost: parseDecimal(row.rawCost),
          count: parseIntMetric(row.count),
          usage: mapUsageMetrics(row),
        }))
      ),
      byModel: sortByBillableCostDesc(
        subtractEmbeddedFromBucketRows(
          byModelRows.map((row) => ({
            model: normalizeBucketKey(row.model),
            billableCost: parseDecimal(row.billableCost),
            rawCost: parseDecimal(row.rawCost),
            count: parseIntMetric(row.count),
          })),
          (row) => row.model,
          embeddedToolSplit.byModelEmbedded
        )
      ),
      byProvider: sortByBillableCostDesc(
        subtractEmbeddedFromBucketRows(
          byProviderRows
            .filter((row): row is typeof row & { provider: string } => row.provider !== null)
            .map((row) => ({
              provider: row.provider,
              billableCost: parseDecimal(row.billableCost),
              rawCost: parseDecimal(row.rawCost),
              count: parseIntMetric(row.count),
            })),
          (row) => row.provider,
          embeddedToolSplit.byProviderEmbedded
        )
      ),
      byTool: mergeEmbeddedToolBucketRows(
        byToolRows
          .filter((row): row is typeof row & { toolId: string } => row.toolId !== null)
          .map((row) => ({
            toolId: row.toolId,
            billableCost: parseDecimal(row.billableCost),
            rawCost: parseDecimal(row.rawCost),
            count: parseIntMetric(row.count),
          })),
        embeddedToolSplit.byToolEmbedded
      ),
      byVendor: sortByBillableCostDesc(
        byVendorRows.map((row) => ({
          vendor: normalizeBucketKey(row.vendor),
          billableCost: parseDecimal(row.billableCost),
          rawCost: parseDecimal(row.rawCost),
          count: parseIntMetric(row.count),
        }))
      ),
      timeSeries: densifiedTimeSeries,
      lineage: {
        roots: lineageRootRows
          .filter(
            (row): row is typeof row & { rootExecutionId: string } => row.rootExecutionId !== null
          )
          .map((row) => ({
            rootExecutionId: row.rootExecutionId,
            executionCount: row.executionCount,
            inclusiveBillableCost: parseDecimal(row.inclusiveBillableCost),
            inclusiveRawCost: parseDecimal(row.inclusiveRawCost),
          }))
          .sort((a, b) => b.inclusiveBillableCost - a.inclusiveBillableCost)
          .slice(0, 25),
        drillDown,
      },
      dataHealth: {
        limitedAttribution,
        warnings,
      },
    }
  } catch (error) {
    logger.error('Failed to compute workspace usage analytics', {
      error: toError(error).message,
      workspaceId,
      options,
    })
    throw error
  }
}

export class InvalidUsageSourcesError extends Error {
  constructor(public readonly invalidSources: string[]) {
    super(`Invalid usage sources: ${invalidSources.join(', ')}`)
    this.name = 'InvalidUsageSourcesError'
  }
}

/**
 * Parses and validates comma-separated usage_log source filters against the
 * contract enum. Throws when any token is not a recognized source.
 */
export function parseWorkspaceUsageSources(
  sourcesParam: string | undefined
): UsageLogSource[] | undefined {
  if (!sourcesParam) return undefined

  const values = sourcesParam
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (values.length === 0) return undefined

  const invalid = values.filter((value) => !usageLogSourceSchema.safeParse(value).success)
  if (invalid.length > 0) {
    throw new InvalidUsageSourcesError(invalid)
  }

  return values as UsageLogSource[]
}
