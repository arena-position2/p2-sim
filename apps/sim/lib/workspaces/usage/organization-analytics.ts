import { dbReplica } from '@sim/db'
import {
  copilotChats,
  copilotRuns,
  usageLog,
  workflowExecutionLogs,
  workspace,
} from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm'
import type { OrganizationUsageAnalytics } from '@/lib/api/contracts/organization-usage'
import type { UsageChargeTypeValue } from '@/lib/api/contracts/workspace-usage'
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
  listExternalApiCostBuckets,
  listExternalApiUsage,
  mapBySourceBucketRow,
  mapExpensiveCopilotChatRows,
  mapExpensiveWorkflowRows,
  mapUsageMetrics,
  mergeExternalApiCostBuckets,
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
  WORKFLOW_SOURCE,
} from '@/lib/workspaces/usage/ledger-helpers'

const logger = createLogger('OrganizationUsageAnalytics')

export class InvalidOrganizationWorkspaceError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`Workspace ${workspaceId} is not an active workspace in this organization`)
    this.name = 'InvalidOrganizationWorkspaceError'
  }
}

export interface OrganizationUsageAnalyticsOptions {
  organizationId: string
  startTime?: string
  endTime?: string
  period?: '1d' | '7d' | '30d' | '90d'
  sources?: UsageLogSource[]
  allTime?: boolean
  /** Optional subset to a single active org workspace. */
  workspaceId?: string
}

interface OrgWorkspaceRef {
  id: string
  name: string
}

async function listActiveOrganizationWorkspaces(
  organizationId: string
): Promise<OrgWorkspaceRef[]> {
  return dbReplica
    .select({ id: workspace.id, name: workspace.name })
    .from(workspace)
    .where(and(eq(workspace.organizationId, organizationId), isNull(workspace.archivedAt)))
    .orderBy(asc(workspace.name))
}

async function resolveOrganizationPeriod(
  workspaceIds: string[],
  options: OrganizationUsageAnalyticsOptions
): Promise<ResolvedPeriod> {
  if (options.allTime) {
    const [usageBounds, executionBounds, chatBounds, runBounds] = await Promise.all([
      dbReplica
        .select({
          minAt: sql<Date | null>`min(${ledgerOccurredAt()})`,
          maxAt: sql<Date | null>`max(${ledgerOccurredAt()})`,
        })
        .from(usageLog)
        .where(inArray(usageLog.workspaceId, workspaceIds)),
      dbReplica
        .select({
          minAt: sql<Date | null>`min(${workflowExecutionLogs.startedAt})`,
          maxAt: sql<Date | null>`max(${workflowExecutionLogs.startedAt})`,
        })
        .from(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.workspaceId, workspaceIds)),
      dbReplica
        .select({
          minAt: sql<Date | null>`min(${copilotChats.createdAt})`,
          maxAt: sql<Date | null>`max(${copilotChats.createdAt})`,
        })
        .from(copilotChats)
        .where(inArray(copilotChats.workspaceId, workspaceIds)),
      dbReplica
        .select({
          minAt: sql<Date | null>`min(${copilotRuns.startedAt})`,
          maxAt: sql<Date | null>`max(${copilotRuns.startedAt})`,
        })
        .from(copilotRuns)
        .where(inArray(copilotRuns.workspaceId, workspaceIds)),
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

function emptyOrganizationAnalytics(
  workspaces: OrgWorkspaceRef[],
  scopedWorkspaces: OrgWorkspaceRef[],
  period: ResolvedPeriod,
  useHourlyBuckets = false
): OrganizationUsageAnalytics {
  return {
    period: {
      startTime: period.start.toISOString(),
      endTime: period.end.toISOString(),
    },
    workspaces,
    summary: {
      billableCost: 0,
      rawCost: 0,
      billableCostCredits: 0,
      ledgerEntryCount: 0,
      executionCount: 0,
      chatCount: 0,
      runCount: 0,
      activeUserCount: 0,
      usage: { ...EMPTY_USAGE_METRICS },
    },
    byWorkspace: scopedWorkspaces.map((ws) => ({
      workspaceId: ws.id,
      workspaceName: ws.name,
      billableCost: 0,
      rawCost: 0,
      count: 0,
      usage: { ...EMPTY_USAGE_METRICS },
    })),
    byApi: [],
    byChargeType: [],
    attribution: {
      missingChatId: { billableCost: 0, rawCost: 0, count: 0 },
      missingExecutionId: { billableCost: 0, rawCost: 0, count: 0 },
    },
    workflow: {
      executions: {
        total: 0,
        withProjectedCost: 0,
        totalProjectedCost: 0,
        totalLedgerCost: 0,
      },
      byTrigger: [],
      byWorkflow: [],
    },
    copilot: {
      chats: { total: 0, withLedgerCost: 0 },
      runs: { total: 0 },
      byChatType: [],
      byChat: [],
      byModel: [],
      modelSpend: { billableCost: 0, rawCost: 0, count: 0 },
      triggeredWorkflows: {
        executionCount: 0,
        billableCost: 0,
        rawCost: 0,
        byChat: [],
      },
    },
    byActor: [],
    byUser: [],
    bySource: [],
    byModel: [],
    byProvider: [],
    byTool: [],
    byVendor: [],
    timeSeries: densifyTimeSeries([], period, useHourlyBuckets),
    lineage: { roots: [] },
    dataHealth: { limitedAttribution: false, warnings: [] },
  }
}

/**
 * Aggregates organization usage across active org workspaces for admin dashboards.
 * Optional `workspaceId` subsets analytics to one org workspace; lineage drill-down
 * is not computed here — clients deep-link into workspace Usage with `rootExecutionId`.
 */
export async function getOrganizationUsageAnalytics(
  options: OrganizationUsageAnalyticsOptions
): Promise<OrganizationUsageAnalytics> {
  const { organizationId, sources, workspaceId: filterWorkspaceId } = options

  try {
    const allWorkspaces = await listActiveOrganizationWorkspaces(organizationId)

    if (allWorkspaces.length === 0) {
      const period = resolveExplicitPeriod(options)
      return emptyOrganizationAnalytics([], [], period, shouldUseHourlyTimeBuckets(options, period))
    }

    let scopedWorkspaces = allWorkspaces
    if (filterWorkspaceId) {
      const match = allWorkspaces.find((ws) => ws.id === filterWorkspaceId)
      if (!match) {
        throw new InvalidOrganizationWorkspaceError(filterWorkspaceId)
      }
      scopedWorkspaces = [match]
    }

    const workspaceIds = scopedWorkspaces.map((ws) => ws.id)
    const workspaceNameById = new Map(allWorkspaces.map((ws) => [ws.id, ws.name]))

    const period = await resolveOrganizationPeriod(workspaceIds, options)

    if (Number.isNaN(period.start.getTime()) || Number.isNaN(period.end.getTime())) {
      throw new Error('Invalid time range')
    }

    if (period.start > period.end) {
      throw new Error('Invalid time range')
    }

    const ledgerWorkspaceCondition = inArray(usageLog.workspaceId, workspaceIds)
    const ledgerConditions = buildLedgerConditions(ledgerWorkspaceCondition, period, sources)
    const ledgerJoinConditions = buildLedgerJoinConditions(ledgerWorkspaceCondition, period)
    const executionWorkspaceCondition = inArray(workflowExecutionLogs.workspaceId, workspaceIds)
    const executionConditions = buildExecutionConditions(executionWorkspaceCondition, period)
    const useHourlyBuckets = shouldUseHourlyTimeBuckets(options, period)
    const bucketExpr = timeBucketExpr(useHourlyBuckets)
    const executionBucket = executionBucketExpr(useHourlyBuckets)
    const chargeType = chargeTypeExpr()
    const toolBucketId = byToolBucketIdExpr()
    const workspaceIdsSql = sql.join(
      workspaceIds.map((id) => sql`${id}`),
      sql`, `
    )

    const [
      bySourceRows,
      byChargeTypeRows,
      summaryUsageRows,
      attributionRows,
      byWorkspaceRows,
      workflowExecutionSummary,
      workflowLedgerSummary,
      workflowByTriggerRows,
      expensiveWorkflowRows,
      copilotChatSummary,
      copilotRunSummary,
      copilotByTypeRows,
      copilotByModelRows,
      expensiveChatRows,
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
          workspaceId: usageLog.workspaceId,
          ...ledgerCostSelect(),
          ...usageMetricsSelect(),
        })
        .from(usageLog)
        .where(and(...ledgerConditions))
        .groupBy(usageLog.workspaceId),

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
        executionScope: executionWorkspaceCondition,
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
            inArray(copilotChats.workspaceId, workspaceIds),
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
            inArray(copilotRuns.workspaceId, workspaceIds),
            ...periodRange(copilotRuns.startedAt, period)
          )
        ),

      buildCopilotByChatTypeQuery({
        chatScope: inArray(copilotChats.workspaceId, workspaceIds),
        ledgerJoinConditions,
        period,
        runWorkspaceCondition: inArray(copilotRuns.workspaceId, workspaceIds),
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
            inArray(copilotChats.workspaceId, workspaceIds),
            ...ledgerJoinConditions,
            inArray(usageLog.source, COPILOT_USAGE_SOURCES)
          )
        )
        .groupBy(copilotChats.model),

      buildExpensiveCopilotChatsQuery({
        chatScope: inArray(copilotChats.workspaceId, workspaceIds),
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
          workspaceId: workflowExecutionLogs.workspaceId,
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
        .groupBy(workflowExecutionLogs.rootExecutionId, workflowExecutionLogs.workspaceId),

      dbReplica
        .select({
          triggeringChatId: workflowExecutionLogs.triggeringChatId,
          workspaceId: workflowExecutionLogs.workspaceId,
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
        .groupBy(workflowExecutionLogs.triggeringChatId, workflowExecutionLogs.workspaceId),

      dbReplica
        .select({
          totalRows: sql<number>`count(*)::int`,
          nullWorkspaceRows: sql<number>`count(case when ${usageLog.workspaceId} is null then 1 end)::int`,
          missingActorRows: sql<number>`count(case when ${usageLog.actorUserId} is null or ${usageLog.actorType} is null then 1 end)::int`,
        })
        .from(usageLog)
        .where(
          and(
            or(inArray(usageLog.workspaceId, workspaceIds), isNull(usageLog.workspaceId)),
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
            where ${usageLog.workspaceId} in (${workspaceIdsSql})
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

    const externalApiPayer = and(
      eq(usageLog.billingEntityType, 'organization'),
      eq(usageLog.billingEntityId, organizationId)
    )
    const externalApiQuery = externalApiPayer
      ? {
          payerCondition: externalApiPayer,
          homeOrganizationIds: [organizationId],
          period,
        }
      : null
    const [byApi, externalApiBuckets] = await Promise.all([
      externalApiQuery ? listExternalApiUsage(externalApiQuery) : [],
      externalApiQuery ? listExternalApiCostBuckets({ ...externalApiQuery, useHourlyBuckets }) : [],
    ])

    const embeddedToolSplit = computeEmbeddedToolVirtualSplit(modelMetadataRows)

    const bySource = sortByBillableCostDesc(
      bySourceRows.flatMap((row) => {
        const mapped = mapBySourceBucketRow(row)
        if (!mapped) {
          logger.warn('Skipping bySource row with invalid ledger source', {
            organizationId,
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

    const costByWorkspaceId = new Map(
      byWorkspaceRows
        .filter((row): row is typeof row & { workspaceId: string } => row.workspaceId !== null)
        .map((row) => [
          row.workspaceId,
          {
            billableCost: parseDecimal(row.billableCost),
            rawCost: parseDecimal(row.rawCost),
            count: parseIntMetric(row.count),
            usage: mapUsageMetrics(row),
          },
        ])
    )

    const byWorkspace = scopedWorkspaces
      .map((ws) => {
        const costs = costByWorkspaceId.get(ws.id)
        return {
          workspaceId: ws.id,
          workspaceName: ws.name,
          billableCost: costs?.billableCost ?? 0,
          rawCost: costs?.rawCost ?? 0,
          count: costs?.count ?? 0,
          usage: costs?.usage ?? { ...EMPTY_USAGE_METRICS },
        }
      })
      .sort((a, b) => b.billableCost - a.billableCost)

    const executionCountByBucket = new Map(
      timeSeriesExecutionRows.map((row) => [
        coerceToDate(row.bucketStart)?.toISOString() ?? String(row.bucketStart),
        row.executionCount,
      ])
    )

    const activeUserCountByBucket = new Map(
      activeUserBucketRows.map((row) => [
        coerceToDate(row.bucketStart)?.toISOString() ?? String(row.bucketStart),
        row.activeUserCount,
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

    mergeExternalApiCostBuckets(timeSeries, externalApiBuckets)

    const densifiedTimeSeries = densifyTimeSeries(timeSeries, period, useHourlyBuckets)

    const periodActiveUserCount = activeUserPeriodRows[0]?.activeUserCount ?? 0

    const triggeredWorkflowTotal = triggeredWorkflowRows.reduce(
      (acc, row) => ({
        executionCount: acc.executionCount + row.executionCount,
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

    const warnings: OrganizationUsageAnalytics['dataHealth']['warnings'] = []

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

    return {
      period: {
        startTime: period.start.toISOString(),
        endTime: period.end.toISOString(),
      },
      workspaces: allWorkspaces,
      summary: {
        billableCost: totalBillableCost,
        rawCost: totalRawCost,
        billableCostCredits: dollarsToCredits(totalBillableCost),
        ledgerEntryCount,
        executionCount: workflowSummary?.total ?? 0,
        chatCount: chatSummary?.total ?? 0,
        runCount: runSummary?.total ?? 0,
        activeUserCount: periodActiveUserCount,
        usage: summaryUsage,
      },
      byWorkspace,
      byApi,
      byChargeType,
      attribution: {
        missingChatId: {
          billableCost: parseDecimal(attribution?.missingChatIdCost),
          rawCost: parseDecimal(attribution?.missingChatIdRawCost),
          count: attribution?.missingChatIdCount ?? 0,
        },
        missingExecutionId: {
          billableCost: parseDecimal(attribution?.missingExecutionIdCost),
          rawCost: parseDecimal(attribution?.missingExecutionIdRawCost),
          count: attribution?.missingExecutionIdCount ?? 0,
        },
      },
      workflow: {
        executions: {
          total: workflowSummary?.total ?? 0,
          withProjectedCost: workflowSummary?.withProjectedCost ?? 0,
          totalProjectedCost: parseDecimal(workflowSummary?.totalProjectedCost),
          totalLedgerCost: parseDecimal(workflowLedger?.totalLedgerCost),
        },
        byTrigger: sortByBillableCostDesc(
          workflowByTriggerRows.map((row) => ({
            trigger: row.trigger,
            executionCount: row.executionCount,
            billableCost: parseDecimal(row.billableCost),
            rawCost: parseDecimal(row.rawCost),
            count: parseIntMetric(row.count),
          }))
        ),
        byWorkflow: mapExpensiveWorkflowRows(expensiveWorkflowRows).map((row) => ({
          workspaceId: row.workspaceId,
          workspaceName:
            row.workspaceName ?? workspaceNameById.get(row.workspaceId) ?? row.workspaceId,
          workflowId: row.workflowId,
          workflowName: row.workflowName,
          executionCount: row.executionCount,
          billableCost: row.billableCost,
          rawCost: row.rawCost,
          count: parseIntMetric(row.count),
        })),
      },
      copilot: {
        chats: {
          total: chatSummary?.total ?? 0,
          withLedgerCost: chatSummary?.withLedgerCost ?? 0,
        },
        runs: {
          total: runSummary?.total ?? 0,
        },
        byChatType: sortByBillableCostDesc(
          copilotByTypeRows.map((row) => ({
            chatType: parseChatType(row.chatType),
            chatCount: row.chatCount,
            runCount: row.runCount,
            billableCost: parseDecimal(row.billableCost),
            rawCost: parseDecimal(row.rawCost),
            count: parseIntMetric(row.count),
          }))
        ),
        byChat: mapExpensiveCopilotChatRows(
          expensiveChatRows.filter(
            (row): row is typeof row & { workspaceId: string } => row.workspaceId !== null
          )
        ).map((row) => ({
          workspaceId: row.workspaceId,
          workspaceName:
            row.workspaceName ?? workspaceNameById.get(row.workspaceId) ?? row.workspaceId,
          chatId: row.chatId,
          title: row.title,
          chatType: row.chatType,
          userId: row.userId,
          runCount: row.runCount,
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
                (row): row is typeof row & { triggeringChatId: string; workspaceId: string } =>
                  row.triggeringChatId !== null && row.workspaceId !== null
              )
              .map((row) => ({
                workspaceId: row.workspaceId,
                workspaceName: workspaceNameById.get(row.workspaceId) ?? row.workspaceId,
                triggeringChatId: row.triggeringChatId,
                executionCount: row.executionCount,
                billableCost: parseDecimal(row.billableCost),
                rawCost: parseDecimal(row.rawCost),
              }))
          ),
        },
      },
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
      byUser: sortByBillableCostDesc(
        byUserRows.map((row) => ({
          userId: row.userId,
          billableCost: parseDecimal(row.billableCost),
          rawCost: parseDecimal(row.rawCost),
          count: parseIntMetric(row.count),
        }))
      ),
      bySource,
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
            (row): row is typeof row & { rootExecutionId: string; workspaceId: string } =>
              row.rootExecutionId !== null && row.workspaceId !== null
          )
          .map((row) => ({
            workspaceId: row.workspaceId,
            workspaceName: workspaceNameById.get(row.workspaceId) ?? row.workspaceId,
            rootExecutionId: row.rootExecutionId,
            executionCount: row.executionCount,
            inclusiveBillableCost: parseDecimal(row.inclusiveBillableCost),
            inclusiveRawCost: parseDecimal(row.inclusiveRawCost),
          }))
          .sort((a, b) => b.inclusiveBillableCost - a.inclusiveBillableCost)
          .slice(0, 25),
      },
      dataHealth: {
        limitedAttribution,
        warnings,
      },
    }
  } catch (error) {
    if (!(error instanceof InvalidOrganizationWorkspaceError)) {
      logger.error('Failed to compute organization usage analytics', {
        error: toError(error).message,
        organizationId,
        options,
      })
    }
    throw error
  }
}
