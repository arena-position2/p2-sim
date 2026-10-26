import { z } from 'zod'
import { workspaceIdSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'
import {
  usageActorTypeSchema,
  usageChargeTypeSchema,
  usageLogSourceSchema,
  workspaceUsagePeriodSchema,
} from '@/lib/api/contracts/workspace-usage'

export const userUsageAnalyticsQuerySchema = z.object({
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  period: workspaceUsagePeriodSchema.optional().default('30d'),
  sources: z.string().optional(),
  allTime: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  /**
   * Optional membership workspace subset. Omit for all membership workspaces.
   * When the UI wants the current route workspace, the client passes that id.
   */
  workspaceId: workspaceIdSchema.optional(),
  /** Lineage drill-down — only applied when a single workspace is selected. */
  rootExecutionId: z.string().min(1).optional(),
})

export type UserUsageAnalyticsQuery = z.input<typeof userUsageAnalyticsQuerySchema>
export type UserUsageAnalyticsQueryOutput = z.output<typeof userUsageAnalyticsQuerySchema>

const costBucketSchema = z.object({
  billableCost: z.number(),
  rawCost: z.number(),
  count: z.number().int().nonnegative(),
})

const usageMetricsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  invocationCount: z.number().int().nonnegative(),
})

const dataHealthWarningSchema = z.object({
  id: z.string(),
  severity: z.enum(['warning', 'error']),
  label: z.string(),
  count: z.number().int().nonnegative(),
  detail: z.string().optional(),
})

export const userUsageAnalyticsResponseSchema = z.object({
  period: z.object({
    startTime: z.string(),
    endTime: z.string(),
  }),
  /** Membership workspaces (for filter UI). Analytics may be scoped via `workspaceId`. */
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    })
  ),
  summary: z.object({
    billableCost: z.number(),
    rawCost: z.number(),
    billableCostCredits: z.number().int(),
    ledgerEntryCount: z.number().int().nonnegative(),
    executionCount: z.number().int().nonnegative(),
    chatCount: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    /** Always 0 or 1 for self-scoped analytics (kept for chart parity). */
    activeUserCount: z.number().int().nonnegative(),
    usage: usageMetricsSchema,
  }),
  byWorkspace: z.array(
    costBucketSchema.extend({
      workspaceId: z.string(),
      workspaceName: z.string(),
      usage: usageMetricsSchema,
    })
  ),
  /**
   * API runs this user triggered in a workspace they do not belong to.
   * Kept apart from `byWorkspace`, which only sums their own workspaces.
   */
  byApi: z.array(
    costBucketSchema.extend({
      workspaceId: z.string(),
      workspaceName: z.string(),
      workflowId: z.string(),
      workflowName: z.string().nullable(),
      actorUserId: z.string().nullable(),
      executionCount: z.number().int().nonnegative(),
      usage: usageMetricsSchema,
    })
  ),
  byChargeType: z.array(
    costBucketSchema.extend({
      chargeType: usageChargeTypeSchema,
    })
  ),
  attribution: z.object({
    missingChatId: costBucketSchema,
    missingExecutionId: costBucketSchema,
  }),
  workflow: z.object({
    executions: z.object({
      total: z.number().int().nonnegative(),
      withProjectedCost: z.number().int().nonnegative(),
      totalProjectedCost: z.number(),
      totalLedgerCost: z.number(),
    }),
    byTrigger: z.array(
      costBucketSchema.extend({
        trigger: z.string(),
        executionCount: z.number().int().nonnegative(),
      })
    ),
    /** Most expensive workflows across the scoped membership workspaces (top N). */
    byWorkflow: z.array(
      costBucketSchema.extend({
        workspaceId: z.string(),
        workspaceName: z.string(),
        workflowId: z.string().nullable(),
        workflowName: z.string().nullable(),
        executionCount: z.number().int().nonnegative(),
      })
    ),
  }),
  copilot: z.object({
    chats: z.object({
      total: z.number().int().nonnegative(),
      withLedgerCost: z.number().int().nonnegative(),
    }),
    runs: z.object({
      total: z.number().int().nonnegative(),
    }),
    byChatType: z.array(
      costBucketSchema.extend({
        chatType: z.enum(['mothership', 'copilot']),
        chatCount: z.number().int().nonnegative(),
        runCount: z.number().int().nonnegative(),
      })
    ),
    byChat: z
      .array(
        costBucketSchema.extend({
          workspaceId: z.string(),
          workspaceName: z.string(),
          chatId: z.string(),
          title: z.string().nullable(),
          chatType: z.enum(['mothership', 'copilot']),
          userId: z.string(),
          runCount: z.number().int().nonnegative(),
        })
      )
      .default([]),
    byModel: z.array(
      costBucketSchema.extend({
        model: z.string(),
      })
    ),
    /**
     * Sum of mothership + Copilot *model* ledger spend (category=model).
     * Tool spend for those sources is under By Tools as "Copilot tools".
     */
    modelSpend: z.object({
      billableCost: z.number(),
      rawCost: z.number(),
      count: z.number().int().nonnegative(),
    }),
    triggeredWorkflows: z.object({
      executionCount: z.number().int().nonnegative(),
      billableCost: z.number(),
      rawCost: z.number(),
      byChat: z.array(
        z.object({
          workspaceId: z.string(),
          workspaceName: z.string(),
          triggeringChatId: z.string(),
          executionCount: z.number().int().nonnegative(),
          billableCost: z.number(),
          rawCost: z.number(),
        })
      ),
    }),
  }),
  bySource: z.array(
    costBucketSchema.extend({
      source: usageLogSourceSchema,
      usage: usageMetricsSchema,
    })
  ),
  byModel: z.array(
    costBucketSchema.extend({
      model: z.string(),
    })
  ),
  byProvider: z.array(
    costBucketSchema.extend({
      provider: z.string(),
    })
  ),
  byTool: z.array(
    costBucketSchema.extend({
      toolId: z.string(),
    })
  ),
  byVendor: z.array(
    costBucketSchema.extend({
      vendor: z.string(),
    })
  ),
  timeSeries: z.array(
    z.object({
      bucketStart: z.string(),
      billableCost: z.number(),
      rawCost: z.number(),
      executionCount: z.number().int().nonnegative(),
      activeUserCount: z.number().int().nonnegative(),
      usage: usageMetricsSchema,
    })
  ),
  /**
   * Lineage roots / drill-down only when a single workspace is selected.
   * Multi-workspace (All) returns empty roots — drill-down is not merged across workspaces.
   */
  lineage: z.object({
    roots: z.array(
      z.object({
        rootExecutionId: z.string(),
        executionCount: z.number().int().nonnegative(),
        inclusiveBillableCost: z.number(),
        inclusiveRawCost: z.number(),
      })
    ),
    drillDown: z
      .object({
        rootExecutionId: z.string(),
        inclusiveBillableCost: z.number(),
        inclusiveRawCost: z.number(),
        executions: z.array(
          z.object({
            executionId: z.string(),
            parentExecutionId: z.string().nullable(),
            workflowId: z.string().nullable(),
            workflowName: z.string().nullable(),
            startedAt: z.string(),
            trigger: z.string(),
            billableCost: z.number(),
            rawCost: z.number(),
            actorUserId: z.string().nullable(),
            actorType: usageActorTypeSchema.nullable(),
          })
        ),
      })
      .optional(),
  }),
  dataHealth: z.object({
    limitedAttribution: z.boolean(),
    warnings: z.array(dataHealthWarningSchema),
  }),
})

export type UserUsageAnalytics = z.output<typeof userUsageAnalyticsResponseSchema>

export const getUserUsageAnalyticsContract = defineRouteContract({
  method: 'GET',
  path: '/api/users/me/usage',
  query: userUsageAnalyticsQuerySchema,
  response: {
    mode: 'json',
    schema: userUsageAnalyticsResponseSchema,
  },
})
