import { z } from 'zod'
import { organizationParamsSchema } from '@/lib/api/contracts/organization'
import { organizationIdSchema, workspaceIdSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'
import {
  usageActorTypeSchema,
  usageChargeTypeSchema,
  usageLogSourceSchema,
  workspaceUsagePeriodSchema,
} from '@/lib/api/contracts/workspace-usage'
import { BILLING_USAGE_LOG_SOURCES, INTERNAL_USAGE_LOG_SOURCES } from '@/lib/billing/usage-sources'
import { isValidTimezone } from '@/lib/core/utils/timezone'

export const organizationUsageAnalyticsQuerySchema = z.object({
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  period: workspaceUsagePeriodSchema.optional().default('30d'),
  sources: z.string().optional(),
  allTime: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  /** Optional subset: one active org workspace. Omit for all org workspaces. */
  workspaceId: workspaceIdSchema.optional(),
})

export type OrganizationUsageAnalyticsQuery = z.input<typeof organizationUsageAnalyticsQuerySchema>
export type OrganizationUsageAnalyticsQueryOutput = z.output<
  typeof organizationUsageAnalyticsQuerySchema
>

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

export const organizationUsageAnalyticsResponseSchema = z.object({
  period: z.object({
    startTime: z.string(),
    endTime: z.string(),
  }),
  /** All active org workspaces (for filter UI). Analytics may be scoped via `workspaceId`. */
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
    /** Distinct human actors (resolved actor_type = user) across the period. */
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
    /** Most expensive workflows across the scoped org workspaces (top N). */
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
    /**
     * Most expensive mothership/copilot chats (top N), with workspace for deep-links.
     * Default keeps older API payloads that omitted this field from failing client
     * contract validation (which would drop the entire usage response).
     */
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
  byActor: z.array(
    costBucketSchema.extend({
      actorUserId: z.string().nullable(),
      actorType: usageActorTypeSchema.nullable(),
      usage: usageMetricsSchema,
    })
  ),
  byUser: z.array(
    costBucketSchema.extend({
      userId: z.string(),
    })
  ),
  bySource: z.array(
    costBucketSchema.extend({
      source: usageLogSourceSchema,
      /**
       * Display label for this bucket. Required because Local mothership and
       * workspace Copilot both use ledger source `copilot` — Local mothership
       * is labeled "Arena AI".
       */
      label: z.string().min(1),
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
      /** Distinct human actors in this bucket (resolved actor_type = user). */
      activeUserCount: z.number().int().nonnegative(),
      usage: usageMetricsSchema,
    })
  ),
  /**
   * Lineage roots only — drill-down happens via workspace Usage deep-link
   * (`rootExecutionId`), not merged trees in the org API.
   */
  lineage: z.object({
    roots: z.array(
      z.object({
        workspaceId: z.string(),
        workspaceName: z.string(),
        rootExecutionId: z.string(),
        executionCount: z.number().int().nonnegative(),
        inclusiveBillableCost: z.number(),
        inclusiveRawCost: z.number(),
      })
    ),
  }),
  dataHealth: z.object({
    limitedAttribution: z.boolean(),
    warnings: z.array(dataHealthWarningSchema),
  }),
})

export type OrganizationUsageAnalytics = z.output<typeof organizationUsageAnalyticsResponseSchema>

export const getOrganizationUsageAnalyticsContract = defineRouteContract({
  method: 'GET',
  path: '/api/organizations/[id]/usage',
  params: organizationParamsSchema,
  query: organizationUsageAnalyticsQuerySchema,
  response: {
    mode: 'json',
    schema: organizationUsageAnalyticsResponseSchema,
  },
})

/**
 * Organization usage monitoring (enterprise).
 *
 * Everything on the wire is denominated in **credits**, never dollars: the ledger
 * stores dollars and the use cases convert at this boundary, matching every other
 * usage surface in the product.
 */

export const USAGE_WINDOW_PRESETS = [
  'current-period',
  'previous-period',
  '7d',
  '30d',
  'custom',
] as const
export const usageWindowPresetSchema = z.enum(USAGE_WINDOW_PRESETS).default('current-period')
export type UsageWindowPreset = z.output<typeof usageWindowPresetSchema>

export const USAGE_BREAKDOWN_DIMENSIONS = [
  'member',
  'workspace',
  'workflow',
  'model',
  'byok',
  'source',
] as const
export const usageBreakdownDimensionSchema = z
  .enum(USAGE_BREAKDOWN_DIMENSIONS)
  .describe('Usage grouping dimension.')
export type UsageBreakdownDimension = z.output<typeof usageBreakdownDimensionSchema>

/**
 * The longest custom range the ledger will scan. Declared on the contract so the
 * picker states the same limit the window resolver enforces, rather than the client
 * discovering it from a rejected request.
 */
export const MAX_CUSTOM_RANGE_DAYS = 92

export const ORGANIZATION_USAGE_BREAKDOWN_DEFAULT_LIMIT = 50
export const ORGANIZATION_USAGE_BREAKDOWN_MAX_LIMIT = 100

/**
 * A bare `YYYY-MM-DD` calendar date, and nothing else.
 *
 * `z.iso.date()` is a calendar check rather than a format one — it refuses `2026-02-30` and a
 * non-leap `2026-02-29`, so February is never answered about March — and it is pure pattern
 * matching, so no input can make it throw. Both matter: a hand-rolled round trip through
 * `toISOString` threw on an out-of-range month, and inside a refinement that escapes validation
 * entirely and answers a malformed query string with a 500.
 *
 * Absent is allowed and empty is not. A missing bound is a real state — the picker clears the
 * param rather than blanking it, and the resolver falls back to the current period — while an
 * explicit `?start-date=` is a malformed request that must not silently answer about a different
 * window. Deliberately unlike `usageLimitSchema`, which coerces `''` to its declared default;
 * these bounds have none, so omitting one changes which period you get.
 */
const isoDateSchema = z.iso
  .date({ error: 'Expected a calendar date in YYYY-MM-DD form, such as 2026-08-01' })
  .optional()

/**
 * A page size that treats an empty or absent parameter as omitted.
 *
 * `z.coerce.number()` turns `''` into `0`, which then fails `.min(1)` — so a client
 * that serializes an unset filter as `?limit=` got a 400 instead of the default the
 * schema declares. Explicit numeric values still validate normally.
 */
function usageLimitSchema(max: number, fallback: number) {
  return z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.coerce.number().int().min(1).max(max).default(fallback)
  )
}

/**
 * Shared by all four contracts so the four surfaces cannot describe different
 * windows — a mismatch here is how the tiles and the event log would disagree.
 */
const organizationUsageWindowQuerySchema = z.object({
  /*
    No `organizationId` here. The organization is the path parameter, and that is the
    one every handler authorizes and reads. Accepting a second copy in the query meant
    a request could name one organization and be answered about another — not an
    authorization hole, since `params.id` is what gets checked, but an API that reads
    as though the query mattered.
  */
  preset: usageWindowPresetSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  /**
   * IANA name; bucket boundaries are the viewer's calendar days.
   *
   * Validated here rather than only at the SQL boundary. `assertValidTimezone` is a
   * hard gate — the value reaches `AT TIME ZONE`, which takes an identifier and not
   * a bound parameter — but it throws a plain `Error`, which surfaced as a 500 for
   * what is an ordinary bad query param. Rejecting it as a contract violation makes
   * it a 400 with a usable message and leaves that gate as the backstop it is.
   */
  timezone: z
    .string()
    .min(1, 'timezone cannot be empty')
    .refine(isValidTimezone, 'Expected an IANA timezone such as America/Los_Angeles')
    .default('UTC')
    .describe('IANA timezone for calendar boundaries; defaults to UTC.'),
})

/**
 * Narrows a read to one workspace, for the Workspaces drill-down.
 *
 * Declared once and spread into both query schemas: the drill-down draws its chart
 * from the summary and its lists from the breakdown, so a workspace filter either
 * surface could express alone is one the two could disagree about.
 */
const usageWorkspaceScopeShape = {
  workspaceId: workspaceIdSchema
    .optional()
    .describe('Restrict usage to one workspace owned by the organization.'),
} as const

export const organizationUsageSummaryQuerySchema =
  organizationUsageWindowQuerySchema.extend(usageWorkspaceScopeShape)
export type OrganizationUsageSummaryQuery = z.input<typeof organizationUsageSummaryQuerySchema>

export const organizationUsageBreakdownQuerySchema = organizationUsageWindowQuerySchema.extend({
  ...usageWorkspaceScopeShape,
  dimension: usageBreakdownDimensionSchema,
  limit: usageLimitSchema(
    ORGANIZATION_USAGE_BREAKDOWN_MAX_LIMIT,
    ORGANIZATION_USAGE_BREAKDOWN_DEFAULT_LIMIT
  ),
})
export type OrganizationUsageBreakdownQuery = z.input<typeof organizationUsageBreakdownQuerySchema>

/**
 * Ledger sources, as an enum rather than free strings.
 *
 * Two problems this closes. A single selected source arrives on the wire as one
 * scalar, not a one-item array, so an `z.array(...)` alone rejected the commonest
 * filter outright — hence the union and normalization. And an unrecognized value
 * used to survive validation and reach the query as an unchecked cast, where it
 * matched nothing and returned an empty page that looked like "no usage" rather
 * than a bad request.
 */
const usageLogSourceFilterSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .pipe(z.array(z.enum(INTERNAL_USAGE_LOG_SOURCES)).max(20))

export const organizationUsageEventsQuerySchema = organizationUsageWindowQuerySchema.extend({
  source: usageLogSourceFilterSchema.optional(),
  limit: usageLimitSchema(100, 50),
  cursor: z.string().min(1).optional(),
})
export type OrganizationUsageEventsQuery = z.input<typeof organizationUsageEventsQuerySchema>

export const organizationUsageExportQuerySchema = organizationUsageEventsQuerySchema.omit({
  limit: true,
  cursor: true,
})
export type OrganizationUsageExportQuery = z.input<typeof organizationUsageExportQuerySchema>

/** Only the headline figure — see `readUsageTotals` for why nothing else lives here. */
const usageTotalsSchema = z.object({
  credits: z.number().describe('Whole credits attributed to this total or group.'),
})

const usageSeriesPointSchema = z.object({
  timestamp: z
    .string()
    .describe(
      'Start of this calendar bucket as a local wall-clock timestamp in the requested timezone.'
    ),
  credits: z.number().describe('Whole credits attributed to this total or group.'),
  events: z.number().int().describe('Number of usage events.'),
})

export const organizationUsageSummaryResponseSchema = z.object({
  window: z
    .object({
      start: z.string().describe('Inclusive reporting-window start as an ISO 8601 UTC timestamp.'),
      end: z.string().describe('Exclusive reporting-window end as an ISO 8601 UTC timestamp.'),
      source: z
        .enum(['reporting', 'stripe', 'default', 'range'])
        .describe('How the reporting window was resolved.'),
    })
    .describe('Resolved reporting window.'),
  bucket: z.enum(['day', 'week', 'month']).describe('Calendar granularity of the usage series.'),
  totals: usageTotalsSchema.describe('Total usage for the selected window.'),
  /** `null` when the prior window is not exactly derivable — no delta beats a wrong one. */
  previousTotals: usageTotalsSchema
    .nullable()
    .describe('Exact previous-period total, or null when no exact comparison is available.'),
  series: z
    .array(usageSeriesPointSchema)
    .describe('Chronological usage buckets, including buckets with no usage.'),
})

export const organizationUsageBreakdownRowSchema = z.object({
  id: z.string().describe('Group identifier; an empty ID represents unattributed usage.'),
  label: z.string().describe('Display label for the usage group.'),
  credits: z.number().describe('Whole credits attributed to this total or group.'),
  events: z.number().int().describe('Number of usage events.'),
  /** 0..1 of the window total, not of the visible rows. */
  share: z
    .number()
    .min(0)
    .max(1)
    .describe('Fraction of total cost, or total tokens for BYOK, between zero and one.'),
  /** Model dimensions only — resolved server-side so the client needs no model registry. */
  providerId: z.string().optional().describe('Model provider identifier, when applicable.'),
  /** Model dimensions only; BYOK rows carry no cost, so this is their only usage figure. */
  tokens: z.number().int().optional().describe('Input and output tokens for model or BYOK groups.'),
})
export const organizationUsageBreakdownResponseSchema = z.object({
  dimension: usageBreakdownDimensionSchema,
  rows: z
    .array(organizationUsageBreakdownRowSchema)
    .describe('Top usage groups ordered by cost, or tokens for BYOK.'),
  /** The truncated tail, so the visible rows plus this reconcile to `totalCredits`. */
  other: z
    .object({
      credits: z.number().describe('Whole credits attributed to this total or group.'),
      events: z.number().int().describe('Number of usage events.'),
      rowCount: z.number().int().describe('Number of groups omitted from rows.'),
      /** Tokens for the omitted rows, so the token-denominated BYOK tab still adds up. */
      tokens: z
        .number()
        .int()
        .nonnegative()
        .describe('Input and output tokens attributed to omitted groups.'),
    })
    .describe('Combined usage for groups omitted by the limit.'),
  totalCredits: z
    .number()
    .describe(
      'Whole credits represented by this breakdown; workflow includes only workflow-attributed usage.'
    ),
})

/**
 * The dashboard's breakdown row: member rows add an avatar, which the public v2
 * breakdown (the shared schema above) omits.
 */
const organizationUsageBreakdownViewRowSchema = organizationUsageBreakdownRowSchema.extend({
  image: z.string().optional(),
})
export type OrganizationUsageBreakdownRow = z.output<typeof organizationUsageBreakdownViewRowSchema>

const organizationUsageBreakdownViewSchema = organizationUsageBreakdownResponseSchema.extend({
  rows: z.array(organizationUsageBreakdownViewRowSchema),
})
export type OrganizationUsageBreakdown = z.output<typeof organizationUsageBreakdownViewSchema>

/** Rows on each overview card; the matching tab holds the full ranking. */
export const ORGANIZATION_USAGE_OVERVIEW_ROW_LIMIT = 5

const billingUsageLogSourceSchema = z.enum(BILLING_USAGE_LOG_SOURCES)
export type OrganizationUsageSource = z.output<typeof billingUsageLogSourceSchema>

export const organizationUsageOverviewResponseSchema = organizationUsageSummaryResponseSchema
  .omit({ series: true })
  .extend({
    /**
     * The allowance, only for the whole organization over its current period — the
     * one window it is measured against. Null elsewhere rather than a misleading ratio.
     */
    limitCredits: z.number().int().nonnegative().nullable(),
    series: z
      .array(
        usageSeriesPointSchema.omit({ events: true }).extend({
          sources: z
            .partialRecord(billingUsageLogSourceSchema, z.number().int().positive())
            .describe('Credits per source in this bucket; sources with none are omitted.'),
        })
      )
      .max(1000)
      .describe('Chronological buckets, including buckets with no usage.'),
    /** The Members tab's ranking, cut to the card. */
    members: organizationUsageBreakdownViewSchema.extend({
      rows: z
        .array(organizationUsageBreakdownViewRowSchema)
        .max(ORGANIZATION_USAGE_OVERVIEW_ROW_LIMIT),
    }),
  })
export type OrganizationUsageOverview = z.output<typeof organizationUsageOverviewResponseSchema>

export const organizationUsageEventSchema = z.object({
  id: z.string().describe('Unique usage-ledger event identifier.'),
  createdAt: z.string(),
  source: z.string(),
  description: z.string(),
  workflowName: z.string().nullable(),
  credits: z.number().describe('Whole credits attributed to this total or group.'),
  hasCost: z.boolean(),
})
export type OrganizationUsageEvent = z.output<typeof organizationUsageEventSchema>

export const organizationUsageEventsResponseSchema = z.object({
  events: z.array(organizationUsageEventSchema),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
})
export type OrganizationUsageEventPage = z.output<typeof organizationUsageEventsResponseSchema>

export const getOrganizationUsageOverviewContract = defineRouteContract({
  method: 'GET',
  path: '/api/organizations/[id]/usage/overview',
  params: z.object({ id: organizationIdSchema }),
  query: organizationUsageSummaryQuerySchema,
  response: { mode: 'json', schema: organizationUsageOverviewResponseSchema },
})

export const getOrganizationUsageBreakdownContract = defineRouteContract({
  method: 'GET',
  path: '/api/organizations/[id]/usage/breakdown',
  params: z.object({ id: organizationIdSchema }),
  query: organizationUsageBreakdownQuerySchema,
  response: { mode: 'json', schema: organizationUsageBreakdownViewSchema },
})

export const listOrganizationUsageEventsContract = defineRouteContract({
  method: 'GET',
  path: '/api/organizations/[id]/usage/events',
  params: z.object({ id: organizationIdSchema }),
  query: organizationUsageEventsQuerySchema,
  response: { mode: 'json', schema: organizationUsageEventsResponseSchema },
})

/** `mode: 'text'` — a CSV body has no JSON schema to validate. */
export const exportOrganizationUsageContract = defineRouteContract({
  method: 'GET',
  path: '/api/organizations/[id]/usage/export',
  params: z.object({ id: organizationIdSchema }),
  query: organizationUsageExportQuerySchema,
  response: { mode: 'text' },
})
