import { db } from '@sim/db'
import {
  usageLog,
  workflow,
  workflowExecutionLogs,
  workflowExecutionSnapshots,
} from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import {
  type DescribedError,
  describeError,
  getErrorMessage,
  getPostgresErrorCode,
} from '@sim/utils/errors'
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import { BASE_EXECUTION_CHARGE } from '@/lib/billing/constants'
import {
  collectTraceExecutionArtifacts,
  resolveExternalDescription,
} from '@/lib/billing/core/cost-block-reprice'
import { getHighestPrioritySubscription } from '@/lib/billing/core/plan'
import type { ModelUsageByModel } from '@/lib/billing/core/record-model-usage'
import {
  buildToolLlmCostFields,
  buildToolLlmCostFromModelUsage,
} from '@/lib/billing/core/tool-llm-cost'
import {
  normalizeUsageModelId,
  normalizeUsageToolId,
} from '@/lib/billing/core/usage-entry-normalize'
import {
  billableReconciliationAmount,
  deriveBillingContext,
  rawUsageAmountFromBillable,
  recordUsage,
  stableEventKey,
  type UsageEntry,
  type UsageLogCategory,
  type UsageLogMetadata,
  type UsagePricingSnapshot,
} from '@/lib/billing/core/usage-log'
import {
  describeRetryableInfrastructureError,
  withInfrastructureRetry,
} from '@/lib/core/errors/retryable-infrastructure'
import { mapWithConcurrency } from '@/lib/core/utils/concurrency'
import { isLargeValueRef } from '@/lib/execution/payloads/large-value-ref'
import { reconcileImageProviderAndModel } from '@/lib/image-generation/block-model-config'
import {
  extractEmbeddedToolCostsFromSpan,
  getSpanToolOutputCost,
  IMAGE_AGGREGATE_TOOL_IDS,
  isImageGenerationBillingKey,
  normalizeEmbeddedToolCosts,
} from '@/lib/logs/embedded-tool-costs'
import {
  type CostSummaryExternalCharge,
  calculateCostSummary,
} from '@/lib/logs/execution/logging-factory'
import { materializeExecutionData, TRACE_STORE_REF_KEY } from '@/lib/logs/execution/trace-store'
import type { WorkflowState } from '@/lib/logs/types'
import {
  FALAI_HOSTED_KEY_MARKUP_MULTIPLIER,
  FALAI_IMAGE_FALLBACK_PROVIDER_COST_DOLLARS,
  FALAI_VIDEO_FALLBACK_PROVIDER_COST_DOLLARS,
} from '@/lib/tools/falai-pricing'
import { calculateHostedImageToolCost } from '@/lib/tools/image-pricing'
import { BlockType } from '@/executor/constants'
import { CostBlockHandler } from '@/executor/handlers/cost/cost-handler'
import type {
  BlockLog,
  BlockState,
  ExecutionContext,
  NormalizedBlockOutput,
} from '@/executor/types'
import { resolveBlockModelCost, shouldBillModelUsage } from '@/providers/utils'
import type { SerializedBlock, SerializedConnection, SerializedWorkflow } from '@/serializer/types'
import { browserUseHosting, readBrowserUseTotalCostUsd } from '@/tools/browser_use/hosting'
import { exaHosting } from '@/tools/exa/hosting'
import { semrushHosting } from '@/tools/semrush/hosting'
import { searchTool as serperSearchTool } from '@/tools/serper/search'
import type { ToolHostingPricing } from '@/tools/types'
import { falaiVideoTool } from '@/tools/video/falai'

const logger = createLogger('HistoricalWorkflowReconciliation')

export const RECONCILIATION_EPSILON = 1e-6

export const HISTORICAL_RECONCILE_VERSION = 'historical-reconcile-v1'

export const HISTORICAL_RECONCILE_PRICING_MODE = 'current-catalog' as const

/**
 * Tool IDs / block signals eligible when `--only-priced-tools` is enabled.
 * Pure model/token reprice (agent LLM runs without these tools) is out of scope.
 */
export const RECONCILE_PRICED_TOOL_ALLOWLIST = [
  // Hosted tools
  'exa_search',
  'exa_get_contents',
  'exa_find_similar_links',
  'exa_answer',
  'exa_research',
  'firecrawl_scrape',
  'firecrawl_parse',
  'firecrawl_crawl',
  'serper_search',
  'semrush_query',
  'semrush_organic_positions',
  'browser_use_run_task',
  'image_generate',
  'openai_image',
  'google_nano_banana',
  'video_falai',
  // LLM-on-tool-output
  'google_ads_v1_query',
  'google_ads_query',
  'facebook_ads_query',
  'development_generate_app',
  'development_edit_app',
  'figma_to_html_ai',
  'figma_create',
] as const

/** Allowlisted tool ids that bill via LLM tokens on tool output (not vendor credits). */
const LLM_ON_TOOL_ALLOWLIST = new Set([
  'google_ads_v1_query',
  'google_ads_query',
  'facebook_ads_query',
  'development_generate_app',
  'development_edit_app',
  'figma_to_html_ai',
  'figma_create',
])

export type ReconcilePricedToolId = (typeof RECONCILE_PRICED_TOOL_ALLOWLIST)[number]

const RECONCILE_PRICED_TOOL_ALLOWLIST_SET = new Set<string>(RECONCILE_PRICED_TOOL_ALLOWLIST)

/** Hosted-tool output metadata that counts as priced-tool evidence. */
const PRICED_HOSTED_TOOL_SIGNALS = new Set([
  'firecrawl_credits',
  'exa_cost_dollars',
  'falai_cost_dollars',
  'image_billing',
  'browser_use_cost',
])

export type HistoricalReconcilePricingMode = typeof HISTORICAL_RECONCILE_PRICING_MODE

/** Default page size when listing terminal executions for audit / dry-run. */
export const HISTORICAL_RECONCILE_DEFAULT_BATCH_SIZE = 1000

/** Default concurrent evidence loads per page. */
export const HISTORICAL_RECONCILE_DEFAULT_CONCURRENCY = 8

/** Maximum wall-clock time for one execution's evidence load and reprice. */
export const HISTORICAL_RECONCILE_DEFAULT_EXECUTION_TIMEOUT_MS = 120_000

/** Emit progress after this many attempted executions (and once at completion). */
export const HISTORICAL_RECONCILE_PROGRESS_INTERVAL = 100

/** Also emit progress at least this often while a dry-run page is in flight. */
export const HISTORICAL_RECONCILE_PROGRESS_HEARTBEAT_MS = 30_000

/** Transient DB/network retries for long-running reconciliation pages. */
export const HISTORICAL_RECONCILE_DB_RETRY_ATTEMPTS = 5

const HISTORICAL_RECONCILE_LOCK_TIMEOUT_MS = 10_000
const MISSING_PRICED_TOOL_SCOPE_WARNING = 'priced_tool_scope_missing_regenerate_artifact'

export interface ReconciliationTargetLine {
  category: UsageLogCategory
  description: string
  target: number
  reason?: string
  evidenceSource?: string
  metadata?: UsageLogMetadata
  toolId?: string
  vendor?: string
  quantity?: number
  unit?: string
  pricingSnapshot?: UsagePricingSnapshot
}

export interface HistoricalReconcileShadowRecord {
  executionId: string
  workflowId: string | null
  workspaceId: string
  startedAt: string
  status: string
  ledgerSum: number
  ledgerLines: LedgerLineSummary[]
  costTotal: number | null
  targetSum: number
  positiveDelta: number
  negativeDelta: number
  confidence: ReconciliationConfidence
  applyEligible: boolean
  pricedToolScope: boolean
  primaryClass: ReconciliationClass
  warnings: string[]
  blockers: string[]
  targets: ReconciliationTargetLine[]
  pricingMode: HistoricalReconcilePricingMode
}

export interface HistoricalAdjustmentBuildResult {
  entries: UsageEntry[]
  positiveDeltaTotal: number
  negativeDeltaTotal: number
  skippedNegativeLines: Array<{
    category: UsageLogCategory
    description: string
    target: number
    billed: number
    delta: number
  }>
}

export type HistoricalReconcileApplyStatus = 'applied' | 'skipped' | 'unchanged' | 'error'

export interface ApplyHistoricalReconciliationResult {
  executionId: string
  status: HistoricalReconcileApplyStatus
  reason?: string
  entriesInserted: number
  positiveDeltaApplied: number
  negativeDeltaSkipped: number
  ledgerSumBefore: number
  ledgerSumAfter: number
  costTotalBefore: number | null
  costTotalAfter: number
}

export interface ApplyHistoricalReconciliationBatchResult {
  processed: number
  applied: number
  unchanged: number
  skipped: number
  errors: number
  totalPositiveDeltaApplied: number
  totalNegativeDeltaSkipped: number
  results: ApplyHistoricalReconciliationResult[]
}

export const TERMINAL_EXECUTION_STATUSES = ['completed', 'failed', 'cancelled'] as const

export type ReconciliationClass =
  | 'reconciled'
  | 'ledger_projection_drift'
  | 'span_cost_legacy'
  | 'cost_stripped_needs_reprice'
  | 'missing_trace_data'
  | 'cost_block'
  | 'hosted_tool'
  | 'agent_embedded_tool'
  | 'mothership_risk'
  | 'out_of_scope'

export type ReconciliationConfidence = 'high' | 'medium' | 'low'

export interface HistoricalExecutionFilter {
  workflowId?: string
  executionId?: string
  workspaceId?: string
  since?: Date
  until?: Date
  /** Optional total cap on executions to process across all pages. */
  limit?: number
  /** Page size for keyset pagination. Defaults to {@link HISTORICAL_RECONCILE_DEFAULT_BATCH_SIZE}. */
  batchSize?: number
  /** Concurrent evidence loads within a page. Defaults to {@link HISTORICAL_RECONCILE_DEFAULT_CONCURRENCY}. */
  concurrency?: number
  /** Per-execution deadline. Defaults to {@link HISTORICAL_RECONCILE_DEFAULT_EXECUTION_TIMEOUT_MS}. */
  executionTimeoutMs?: number
  /**
   * When true, executions without allowlisted priced-tool / cost-block evidence
   * are classified `out_of_scope` and are not apply-eligible.
   */
  onlyPricedTools?: boolean
}

/** Keyset cursor for descending `(started_at, execution_id)` pagination. */
export interface HistoricalExecutionCursor {
  startedAt: Date
  executionId: string
}

export interface HistoricalReconcileProgress {
  attempted: number
  succeeded: number
  skipped: number
  failed: number
  pages: number
  /** Executions skipped because they were already present in a resumed export artifact. */
  resumedSkipped?: number
  /** Executions currently in flight, including their wall-clock runtime. */
  activeExecutions?: Array<{ executionId: string; elapsedMs: number }>
  done: boolean
}

export type HistoricalReconcileProgressCallback = (progress: HistoricalReconcileProgress) => void

export interface HistoricalReconcileFailure {
  executionId: string
  error: string
  cause: DescribedError
  postgresCode?: string
}

export interface HistoricalExecutionRow {
  executionId: string
  workflowId: string | null
  workspaceId: string
  startedAt: Date
  status: string
  trigger: string
  stateSnapshotId: string
  costTotal: number | null
  ledgerSum: number
  drift: number
  modelsUsed: string[] | null
}

export interface LedgerLineSummary {
  category: string
  description: string
  cost: number
}

export interface TraceEvidenceSummary {
  hasTraceSpans: boolean
  traceSpanCount: number
  traceStoreExternalized: boolean
  traceStoreMaterialized: boolean
  traceStoreExpired: boolean
  spansWithInlineCost: number
  spansWithTokensNoCost: number
  spansWithHostedToolMetadata: number
  spansWithEmbeddedToolCost: number
  spansWithCostBlockType: number
  modelsInSpans: string[]
  hostedToolSignals: string[]
}

export interface ExecutionEvidence {
  executionId: string
  workflowId: string | null
  workspaceId: string
  startedAt: Date
  status: string
  trigger: string
  stateSnapshotId: string
  costTotal: number | null
  ledgerSum: number
  drift: number
  billingReconciliationPending: boolean
  billingReconciliationReason: string | null
  ledgerLines: LedgerLineSummary[]
  mothershipLedgerSum: number
  trace: TraceEvidenceSummary
  hasSnapshot: boolean
  snapshotHasCostBlocks: boolean
  snapshotState: WorkflowState | null
  traceSpans: TraceSpanLike[] | undefined
  modelsUsed: string[] | null
}

export interface ComputeTargetLedgerOptions {
  pricingMode?: HistoricalReconcilePricingMode
  /**
   * When true, executions without allowlisted priced-tool / cost-block evidence
   * are classified `out_of_scope` and are not apply-eligible.
   */
  onlyPricedTools?: boolean
}

export interface ShadowRepriceSummary {
  total: number
  attempted: number
  skipped: number
  /** Executions skipped because they were already present in a resumed export artifact. */
  resumedSkipped: number
  failed: number
  failures: HistoricalReconcileFailure[]
  withTargets: number
  withPositiveDelta: number
  withNegativeDelta: number
  totalPositiveDelta: number
  totalNegativeDelta: number
  records: HistoricalReconcileShadowRecord[]
}

export interface ExecutionClassification {
  executionId: string
  workflowId: string | null
  workspaceId: string
  startedAt: Date
  status: string
  primaryClass: ReconciliationClass
  secondaryClasses: ReconciliationClass[]
  confidence: ReconciliationConfidence
  blockers: string[]
  warnings: string[]
  evidenceSources: string[]
  applyEligible: boolean
  costTotal: number | null
  ledgerSum: number
  drift: number
}

export interface ReconciliationAuditSummary {
  total: number
  attempted: number
  skipped: number
  failed: number
  failures: HistoricalReconcileFailure[]
  byClass: Record<ReconciliationClass, number>
  byConfidence: Record<ReconciliationConfidence, number>
  applyEligible: number
  withDrift: number
  topRiskExamples: ExecutionClassification[]
  classifications: ExecutionClassification[]
}

interface TraceSpanLike {
  type?: string
  name?: string
  toolId?: string
  model?: string
  status?: string
  cost?: { input?: number; output?: number; total?: number; toolCost?: number }
  tokens?: {
    input?: number
    output?: number
    total?: number
    prompt?: number
    completion?: number
  }
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  children?: TraceSpanLike[]
}

function parseDecimal(value: string | null | undefined): number {
  if (value == null) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function hasTokenCounts(span: TraceSpanLike): boolean {
  const tokens = span.tokens
  if (!tokens) return false
  const input = tokens.input ?? tokens.prompt ?? 0
  const output = tokens.output ?? tokens.completion ?? 0
  const total = tokens.total ?? 0
  return input > 0 || output > 0 || total > 0
}

function hasInlineSpanCost(span: TraceSpanLike): boolean {
  const total = span.cost?.total
  return typeof total === 'number' && Number.isFinite(total) && total > 0
}

function readFirecrawlCreditsUsed(output: Record<string, unknown>): number | null {
  const metadata = output.metadata
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const creditsUsed = (metadata as { creditsUsed?: unknown }).creditsUsed
    if (typeof creditsUsed === 'number' && creditsUsed > 0) {
      return creditsUsed
    }
  }

  if (typeof output.creditsUsed === 'number' && output.creditsUsed > 0) {
    return output.creditsUsed
  }

  return null
}

/**
 * Reads Exa-style API-reported dollar cost from tool output
 * (`__costDollars` number or `{ total }`, then `costDollars`).
 */
function readExaLikeCostDollars(output: Record<string, unknown>): number | null {
  const candidates = [output.__costDollars, output.costDollars]
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const total = (value as { total?: unknown }).total
      if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
        return total
      }
    }
  }
  return null
}

function detectHostedToolSignals(output: Record<string, unknown> | undefined): string[] {
  if (!output) return []
  const signals: string[] = []

  if (readFirecrawlCreditsUsed(output) != null) {
    signals.push('firecrawl_credits')
  }

  if (readExaLikeCostDollars(output) != null) {
    signals.push('exa_cost_dollars')
  }

  if (typeof output.__falaiCostDollars === 'number' && output.__falaiCostDollars > 0) {
    signals.push('falai_cost_dollars')
  }

  if (output.__imageBilling && typeof output.__imageBilling === 'object') {
    signals.push('image_billing')
  }

  if (
    (typeof output.__totalCostUsd === 'number' && output.__totalCostUsd > 0) ||
    (typeof output.totalCostUsd === 'number' && output.totalCostUsd > 0)
  ) {
    signals.push('browser_use_cost')
  }

  return signals
}

function walkTraceSpans(
  spans: TraceSpanLike[] | undefined,
  visit: (span: TraceSpanLike) => void
): void {
  if (!spans) return
  for (const span of spans) {
    visit(span)
    walkTraceSpans(span.children, visit)
  }
}

/**
 * Inspects trace span trees for reconciliation evidence without mutating spans.
 */
export function analyzeTraceSpans(traceSpans: TraceSpanLike[] | undefined): TraceEvidenceSummary {
  const models = new Set<string>()
  const hostedToolSignals = new Set<string>()
  let spansWithInlineCost = 0
  let spansWithTokensNoCost = 0
  let spansWithHostedToolMetadata = 0
  let spansWithEmbeddedToolCost = 0
  let spansWithCostBlockType = 0

  walkTraceSpans(traceSpans, (span) => {
    if (span.model) models.add(span.model)

    if (hasInlineSpanCost(span)) {
      spansWithInlineCost += 1
    } else if (span.model && hasTokenCounts(span)) {
      spansWithTokensNoCost += 1
    }

    if (span.type === 'cost') {
      spansWithCostBlockType += 1
    }

    const toolSignals = detectHostedToolSignals(span.output)
    if (toolSignals.length > 0) {
      spansWithHostedToolMetadata += 1
      for (const signal of toolSignals) hostedToolSignals.add(signal)
    }

    if (span.type === 'agent' || span.model) {
      const embeddedCosts = extractEmbeddedToolCostsFromSpan(span)
      const embeddedTotal = Object.values(embeddedCosts).reduce((sum, value) => sum + value, 0)
      const toolCost = span.cost?.toolCost ?? 0
      if (embeddedTotal > 0 || toolCost > 0) {
        spansWithEmbeddedToolCost += 1
      }
    }
  })

  return {
    hasTraceSpans: Boolean(traceSpans && traceSpans.length > 0),
    traceSpanCount: traceSpans?.length ?? 0,
    traceStoreExternalized: false,
    traceStoreMaterialized: false,
    traceStoreExpired: false,
    spansWithInlineCost,
    spansWithTokensNoCost,
    spansWithHostedToolMetadata,
    spansWithEmbeddedToolCost,
    spansWithCostBlockType,
    modelsInSpans: [...models],
    hostedToolSignals: [...hostedToolSignals],
  }
}

/** Returns true when snapshot state contains at least one Cost block. */
export function snapshotStateHasCostBlocks(stateData: WorkflowState | null | undefined): boolean {
  if (!stateData?.blocks) return false
  return Object.values(stateData.blocks).some((block) => block.type === BlockType.COST)
}

/**
 * Returns true when `candidate` matches an allowlisted priced tool id
 * (exact match after normalize, or allowlist id prefixed by the candidate block type).
 */
export function isReconcilePricedToolId(candidate: string | null | undefined): boolean {
  if (!candidate) return false
  const normalized = normalizeUsageToolId(candidate.trim())
  if (!normalized) return false
  if (RECONCILE_PRICED_TOOL_ALLOWLIST_SET.has(normalized)) return true
  if (isImageGenerationBillingKey(normalized)) return true
  for (const allowed of RECONCILE_PRICED_TOOL_ALLOWLIST_SET) {
    if (allowed.startsWith(`${normalized}_`)) return true
  }
  return false
}

function collectSnapshotToolCandidates(state: WorkflowState | null | undefined): string[] {
  if (!state?.blocks) return []
  const candidates: string[] = []

  for (const block of Object.values(state.blocks)) {
    if (block.type) candidates.push(block.type)

    const subBlocks = block.subBlocks ?? {}
    for (const key of ['operation', 'toolId', 'tool'] as const) {
      const raw = subBlocks[key]?.value
      if (typeof raw === 'string' && raw.trim().length > 0) {
        candidates.push(raw)
        if (block.type && key === 'operation') {
          candidates.push(`${block.type}_${raw}`)
        }
      }
    }
  }

  return candidates
}

function collectTraceToolCandidates(traceSpans: TraceSpanLike[] | undefined): string[] {
  const candidates: string[] = []
  walkTraceSpans(traceSpans, (span) => {
    if (span.name) candidates.push(span.name)
    if (span.type) candidates.push(span.type)
    if (span.toolId) candidates.push(span.toolId)

    const output = span.output
    if (output && typeof output === 'object') {
      for (const key of ['toolId', 'tool', 'name', 'operation'] as const) {
        const value = output[key]
        if (typeof value === 'string' && value.trim().length > 0) {
          candidates.push(value)
        }
      }
    }
  })
  return candidates
}

/**
 * True when evidence includes an allowlisted priced tool, cost block, or
 * hosted-tool dollar/credit metadata (`__costDollars`, firecrawl credits, etc.).
 * Pure model/token spans alone do not qualify.
 */
export function executionHasPricedToolSignal(evidence: ExecutionEvidence): boolean {
  if (evidence.snapshotHasCostBlocks || evidence.trace.spansWithCostBlockType > 0) {
    return true
  }

  for (const signal of evidence.trace.hostedToolSignals) {
    if (PRICED_HOSTED_TOOL_SIGNALS.has(signal)) return true
  }

  for (const candidate of collectSnapshotToolCandidates(evidence.snapshotState)) {
    if (isReconcilePricedToolId(candidate)) return true
  }

  for (const candidate of collectTraceToolCandidates(evidence.traceSpans)) {
    if (isReconcilePricedToolId(candidate)) return true
  }

  return false
}

/**
 * True when a shadow artifact record still looks like priced-tool scope
 * (used when applying an artifact that may have been produced with `--all-tools`).
 */
export function shadowRecordHasPricedToolEvidence(
  record: HistoricalReconcileShadowRecord
): boolean {
  if (record.pricedToolScope) return true
  if (record.primaryClass === 'out_of_scope') return false
  if (record.primaryClass === 'cost_block' || record.primaryClass === 'hosted_tool') {
    return true
  }

  for (const target of record.targets) {
    if (target.category === 'external') return true
    if (isReconcilePricedToolId(target.toolId ?? target.description)) return true
    if (target.evidenceSource && PRICED_HOSTED_TOOL_SIGNALS.has(target.evidenceSource)) {
      return true
    }
  }

  for (const line of record.ledgerLines) {
    if (line.category === 'external') return true
    if (line.category === 'tool' && isReconcilePricedToolId(line.description)) return true
  }

  return false
}

function readBillingReconciliationFlags(executionData: Record<string, unknown>): {
  pending: boolean
  reason: string | null
} {
  const pending = executionData.billingReconciliationPending === true
  const reasonRaw = executionData.billingReconciliationReason
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim().length > 0 ? reasonRaw : null
  return { pending, reason }
}

function uniqueClasses(classes: ReconciliationClass[]): ReconciliationClass[] {
  return [...new Set(classes)]
}

/**
 * Classifies a single execution's evidence into reconciliation classes, confidence,
 * and apply eligibility for the historical repricer.
 */
export function classifyExecutionEvidence(
  evidence: ExecutionEvidence,
  options: { onlyPricedTools?: boolean } = {}
): ExecutionClassification {
  if (options.onlyPricedTools && !executionHasPricedToolSignal(evidence)) {
    return {
      executionId: evidence.executionId,
      workflowId: evidence.workflowId,
      workspaceId: evidence.workspaceId,
      startedAt: evidence.startedAt,
      status: evidence.status,
      primaryClass: 'out_of_scope',
      secondaryClasses: [],
      confidence: 'high',
      blockers: [],
      warnings: ['only_priced_tools_gate'],
      evidenceSources: [],
      applyEligible: false,
      costTotal: evidence.costTotal,
      ledgerSum: evidence.ledgerSum,
      drift: evidence.drift,
    }
  }

  const warnings: string[] = []
  const blockers: string[] = []
  const evidenceSources: string[] = []
  const secondaryClasses: ReconciliationClass[] = []

  const hasDrift = Math.abs(evidence.drift) > RECONCILIATION_EPSILON
  const { trace } = evidence

  if (evidence.mothershipLedgerSum > 0 && evidence.ledgerSum > 0) {
    secondaryClasses.push('mothership_risk')
    warnings.push('workflow_and_mothership_block_ledger_rows_present')
  }

  if (trace.spansWithInlineCost > 0) {
    secondaryClasses.push('span_cost_legacy')
    evidenceSources.push('legacy_span_cost')
  }

  if (trace.spansWithTokensNoCost > 0) {
    secondaryClasses.push('cost_stripped_needs_reprice')
    evidenceSources.push('tokens_repriced')
  }

  if (evidence.snapshotHasCostBlocks || trace.spansWithCostBlockType > 0) {
    secondaryClasses.push('cost_block')
    evidenceSources.push('cost_block_snapshot')
  }

  if (trace.spansWithHostedToolMetadata > 0) {
    secondaryClasses.push('hosted_tool')
    for (const signal of trace.hostedToolSignals) {
      evidenceSources.push(signal)
    }
  }

  if (trace.spansWithEmbeddedToolCost > 0) {
    secondaryClasses.push('agent_embedded_tool')
    evidenceSources.push('agent_tool_cost')
  }

  if (!evidence.hasSnapshot) {
    warnings.push('snapshot_missing')
  }

  if (evidence.billingReconciliationPending) {
    warnings.push(
      evidence.billingReconciliationReason
        ? `billing_reconciliation_pending:${evidence.billingReconciliationReason}`
        : 'billing_reconciliation_pending'
    )
  }

  const unbillableModels = trace.modelsInSpans.filter((model) => !shouldBillModelUsage(model))
  if (unbillableModels.length > 0 && trace.spansWithTokensNoCost > 0) {
    warnings.push(`byok_ambiguity:${unbillableModels.join(',')}`)
  }

  let confidence: ReconciliationConfidence = 'high'
  if (warnings.some((warning) => warning.startsWith('byok_ambiguity'))) {
    confidence = 'low'
  } else if (
    (hasDrift || evidence.billingReconciliationPending) &&
    (trace.traceStoreExpired || (trace.traceStoreExternalized && !trace.traceStoreMaterialized))
  ) {
    confidence = 'medium'
  }

  let primaryClass: ReconciliationClass

  if (!hasDrift && !evidence.billingReconciliationPending && secondaryClasses.length === 0) {
    primaryClass = 'reconciled'
  } else if (
    !hasDrift &&
    !evidence.billingReconciliationPending &&
    secondaryClasses.includes('mothership_risk')
  ) {
    primaryClass = 'mothership_risk'
    confidence = 'low'
  } else if (secondaryClasses.includes('mothership_risk') && hasDrift) {
    primaryClass = 'mothership_risk'
    confidence = 'low'
    blockers.push('manual_mothership_review_required')
  } else if (!trace.hasTraceSpans && (trace.traceStoreExpired || trace.traceStoreExternalized)) {
    primaryClass =
      hasDrift && evidence.ledgerSum > 0 ? 'ledger_projection_drift' : 'missing_trace_data'
    if (primaryClass === 'missing_trace_data') {
      evidenceSources.push('unrecoverable')
      blockers.push('trace_store_unavailable')
      confidence = 'low'
    }
  } else if (!trace.hasTraceSpans) {
    primaryClass =
      hasDrift && evidence.ledgerSum > 0 ? 'ledger_projection_drift' : 'missing_trace_data'
    if (primaryClass === 'missing_trace_data') {
      evidenceSources.push('unrecoverable')
      blockers.push('no_trace_spans')
      confidence = 'low'
    }
  } else if (hasDrift && evidence.ledgerSum > 0 && secondaryClasses.length === 0) {
    primaryClass = 'ledger_projection_drift'
  } else if (secondaryClasses.includes('span_cost_legacy')) {
    primaryClass = 'span_cost_legacy'
  } else if (secondaryClasses.includes('cost_stripped_needs_reprice')) {
    primaryClass = 'cost_stripped_needs_reprice'
    if (confidence === 'high') confidence = 'medium'
  } else if (secondaryClasses.includes('cost_block')) {
    primaryClass = 'cost_block'
  } else if (secondaryClasses.includes('hosted_tool')) {
    primaryClass = 'hosted_tool'
  } else if (secondaryClasses.includes('agent_embedded_tool')) {
    primaryClass = 'agent_embedded_tool'
  } else if (hasDrift && evidence.ledgerSum === 0) {
    primaryClass = 'missing_trace_data'
    evidenceSources.push('unrecoverable')
    blockers.push('ledger_empty_no_recoverable_evidence')
    confidence = 'low'
  } else if (hasDrift) {
    primaryClass = 'ledger_projection_drift'
  } else {
    primaryClass = 'reconciled'
  }

  const dedupedSecondary = uniqueClasses(secondaryClasses.filter((item) => item !== primaryClass))

  const applyEligible =
    blockers.length === 0 &&
    primaryClass !== 'mothership_risk' &&
    primaryClass !== 'missing_trace_data' &&
    primaryClass !== 'reconciled' &&
    primaryClass !== 'ledger_projection_drift' &&
    confidence !== 'low'

  return {
    executionId: evidence.executionId,
    workflowId: evidence.workflowId,
    workspaceId: evidence.workspaceId,
    startedAt: evidence.startedAt,
    status: evidence.status,
    primaryClass,
    secondaryClasses: dedupedSecondary,
    confidence,
    blockers,
    warnings,
    evidenceSources: [...new Set(evidenceSources)],
    applyEligible,
    costTotal: evidence.costTotal,
    ledgerSum: evidence.ledgerSum,
    drift: evidence.drift,
  }
}

function emptyClassCounts(): Record<ReconciliationClass, number> {
  return {
    reconciled: 0,
    ledger_projection_drift: 0,
    span_cost_legacy: 0,
    cost_stripped_needs_reprice: 0,
    missing_trace_data: 0,
    cost_block: 0,
    hosted_tool: 0,
    agent_embedded_tool: 0,
    mothership_risk: 0,
    out_of_scope: 0,
  }
}

/**
 * Aggregates per-execution classifications into audit counters and risk examples.
 */
export function aggregateClassificationResults(
  classifications: ExecutionClassification[],
  topRiskLimit = 20,
  accounting: {
    attempted?: number
    skipped?: number
    failed?: number
    failures?: HistoricalReconcileFailure[]
  } = {}
): ReconciliationAuditSummary {
  const byClass = emptyClassCounts()
  const byConfidence: Record<ReconciliationConfidence, number> = {
    high: 0,
    medium: 0,
    low: 0,
  }

  let applyEligible = 0
  let withDrift = 0

  for (const item of classifications) {
    byClass[item.primaryClass] += 1
    byConfidence[item.confidence] += 1
    if (item.applyEligible) applyEligible += 1
    if (Math.abs(item.drift) > RECONCILIATION_EPSILON) withDrift += 1
  }

  const topRiskExamples = [...classifications]
    .filter(
      (item) =>
        item.primaryClass !== 'reconciled' || item.warnings.length > 0 || item.blockers.length > 0
    )
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))
    .slice(0, topRiskLimit)

  return {
    total: classifications.length,
    attempted: accounting.attempted ?? classifications.length,
    skipped: accounting.skipped ?? 0,
    failed: accounting.failed ?? accounting.failures?.length ?? 0,
    failures: accounting.failures ?? [],
    byClass,
    byConfidence,
    applyEligible,
    withDrift,
    topRiskExamples,
    classifications,
  }
}

function buildExecutionFilterConditions(filter: HistoricalExecutionFilter) {
  const conditions = [inArray(workflowExecutionLogs.status, [...TERMINAL_EXECUTION_STATUSES])]

  if (filter.workflowId) {
    conditions.push(eq(workflowExecutionLogs.workflowId, filter.workflowId))
  }
  if (filter.executionId) {
    conditions.push(eq(workflowExecutionLogs.executionId, filter.executionId))
  }
  if (filter.workspaceId) {
    conditions.push(eq(workflowExecutionLogs.workspaceId, filter.workspaceId))
  }
  if (filter.since) {
    conditions.push(gte(workflowExecutionLogs.startedAt, filter.since))
  }
  if (filter.until) {
    conditions.push(lte(workflowExecutionLogs.startedAt, filter.until))
  }

  return conditions
}

function resolveBatchSize(filter: HistoricalExecutionFilter): number {
  const requested = filter.batchSize ?? HISTORICAL_RECONCILE_DEFAULT_BATCH_SIZE
  if (!Number.isFinite(requested) || requested <= 0) {
    return HISTORICAL_RECONCILE_DEFAULT_BATCH_SIZE
  }
  return Math.floor(requested)
}

function resolveConcurrency(filter: HistoricalExecutionFilter): number {
  const requested = filter.concurrency ?? HISTORICAL_RECONCILE_DEFAULT_CONCURRENCY
  if (!Number.isFinite(requested) || requested <= 0) {
    return HISTORICAL_RECONCILE_DEFAULT_CONCURRENCY
  }
  return Math.floor(requested)
}

function toHistoricalExecutionFailure(
  executionId: string,
  error: unknown
): HistoricalReconcileFailure {
  const postgresCode = getPostgresErrorCode(error)
  return {
    executionId,
    error: getErrorMessage(error),
    cause: describeError(error),
    ...(postgresCode ? { postgresCode } : {}),
  }
}

class HistoricalReconcileExecutionTimeoutError extends Error {
  constructor(executionId: string, timeoutMs: number) {
    super(`Historical reconciliation timed out for execution ${executionId} after ${timeoutMs}ms`)
    this.name = 'HistoricalReconcileExecutionTimeoutError'
  }
}

function resolveExecutionTimeoutMs(filter: HistoricalExecutionFilter, override?: number): number {
  const requested = override ?? filter.executionTimeoutMs
  return requested != null && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : HISTORICAL_RECONCILE_DEFAULT_EXECUTION_TIMEOUT_MS
}

async function withHistoricalReconcileExecutionTimeout<T>(
  executionId: string,
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new HistoricalReconcileExecutionTimeoutError(executionId, timeoutMs)),
          timeoutMs
        )
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function snapshotActiveExecutions(
  activeExecutions: ReadonlyMap<string, number>
): HistoricalReconcileProgress['activeExecutions'] {
  const now = Date.now()
  return [...activeExecutions.entries()]
    .map(([executionId, startedAt]) => ({
      executionId,
      elapsedMs: Math.max(0, now - startedAt),
    }))
    .sort((left, right) => right.elapsedMs - left.elapsedMs)
}

function withReconcileDbRetry<T>(
  operation: () => Promise<T>,
  context: Record<string, unknown>
): Promise<T> {
  return withInfrastructureRetry(operation, {
    maxAttempts: HISTORICAL_RECONCILE_DB_RETRY_ATTEMPTS,
    onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
      logger.warn('Retrying historical reconciliation DB operation after transient failure', {
        ...context,
        attempt,
        maxAttempts,
        delayMs,
        retryable: describeRetryableInfrastructureError(error),
        cause: describeError(error),
      })
    },
  })
}

/**
 * Forces a round-trip so dead pooled sockets are discarded before the next page.
 */
async function ensureDatabaseConnection(): Promise<void> {
  await withReconcileDbRetry(
    async () => {
      await db.execute(sql`select 1`)
    },
    { operation: 'db_keepalive' }
  )
}

/**
 * Lists one page of terminal workflow executions with ledger sums and projection drift.
 * Uses a stable descending keyset on `(started_at, execution_id)`.
 *
 * The `ledgerSum` subquery aliases `usage_log` and references the outer table
 * object (not its column) because in a no-join select drizzle strips table
 * qualifiers from columns embedded in select-list sql fragments, which would
 * otherwise render the correlation as the tautology
 * `"execution_id" = "execution_id"` and sum the entire table for every row.
 */
export async function listHistoricalWorkflowExecutions(
  filter: HistoricalExecutionFilter = {},
  cursor?: HistoricalExecutionCursor | null
): Promise<HistoricalExecutionRow[]> {
  return withReconcileDbRetry(() => listHistoricalWorkflowExecutionsOnce(filter, cursor), {
    operation: 'listHistoricalWorkflowExecutions',
    cursorExecutionId: cursor?.executionId,
  })
}

async function listHistoricalWorkflowExecutionsOnce(
  filter: HistoricalExecutionFilter,
  cursor?: HistoricalExecutionCursor | null
): Promise<HistoricalExecutionRow[]> {
  const conditions = buildExecutionFilterConditions(filter)

  if (cursor) {
    conditions.push(
      or(
        lt(workflowExecutionLogs.startedAt, cursor.startedAt),
        and(
          eq(workflowExecutionLogs.startedAt, cursor.startedAt),
          lt(workflowExecutionLogs.executionId, cursor.executionId)
        )
      )!
    )
  }

  const pageSize = resolveBatchSize(filter)
  const limit =
    filter.limit != null && Number.isFinite(filter.limit) && filter.limit > 0
      ? Math.min(pageSize, Math.floor(filter.limit))
      : pageSize

  const rows = await db
    .select({
      executionId: workflowExecutionLogs.executionId,
      workflowId: workflowExecutionLogs.workflowId,
      workspaceId: workflowExecutionLogs.workspaceId,
      startedAt: workflowExecutionLogs.startedAt,
      status: workflowExecutionLogs.status,
      trigger: workflowExecutionLogs.trigger,
      stateSnapshotId: workflowExecutionLogs.stateSnapshotId,
      costTotal: workflowExecutionLogs.costTotal,
      modelsUsed: workflowExecutionLogs.modelsUsed,
      ledgerSum: sql<string>`COALESCE((
        SELECT SUM(ul.cost)
        FROM ${usageLog} ul
        WHERE ul.execution_id = ${workflowExecutionLogs}.execution_id
          AND ul.source = 'workflow'
      ), 0)`,
    })
    .from(workflowExecutionLogs)
    .where(and(...conditions))
    .orderBy(desc(workflowExecutionLogs.startedAt), desc(workflowExecutionLogs.executionId))
    .limit(limit)

  return rows.map((row) => {
    const costTotal = row.costTotal != null ? parseDecimal(row.costTotal) : null
    const ledgerSum = parseDecimal(row.ledgerSum)
    return {
      executionId: row.executionId,
      workflowId: row.workflowId,
      workspaceId: row.workspaceId,
      startedAt: row.startedAt,
      status: row.status,
      trigger: row.trigger,
      stateSnapshotId: row.stateSnapshotId,
      costTotal,
      ledgerSum,
      drift: (costTotal ?? 0) - ledgerSum,
      modelsUsed: row.modelsUsed,
    }
  })
}

/**
 * Pages through historical workflow executions until exhausted or `filter.limit` is reached.
 */
export async function* iterateHistoricalWorkflowExecutionPages(
  filter: HistoricalExecutionFilter = {}
): AsyncGenerator<HistoricalExecutionRow[], void, undefined> {
  let cursor: HistoricalExecutionCursor | null = null
  let remaining =
    filter.limit != null && Number.isFinite(filter.limit) && filter.limit > 0
      ? Math.floor(filter.limit)
      : Number.POSITIVE_INFINITY

  while (remaining > 0) {
    await ensureDatabaseConnection()

    const pageFilter: HistoricalExecutionFilter = {
      ...filter,
      limit: Number.isFinite(remaining) ? remaining : undefined,
    }
    const page = await listHistoricalWorkflowExecutions(pageFilter, cursor)
    if (page.length === 0) return

    yield page

    remaining -= page.length
    const last = page[page.length - 1]
    if (!last) return

    cursor = {
      startedAt: last.startedAt,
      executionId: last.executionId,
    }

    // A short page means there are no further rows under the current filters.
    if (page.length < resolveBatchSize(filter)) return
  }
}

function emitProgress(
  onProgress: HistoricalReconcileProgressCallback | undefined,
  progress: HistoricalReconcileProgress
): void {
  onProgress?.(progress)
}

function shouldEmitProgress(attempted: number, previousEmitted: number): boolean {
  return attempted - previousEmitted >= HISTORICAL_RECONCILE_PROGRESS_INTERVAL
}

async function loadLedgerLines(executionId: string): Promise<LedgerLineSummary[]> {
  const rows = await db
    .select({
      category: usageLog.category,
      description: usageLog.description,
      cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)`,
    })
    .from(usageLog)
    .where(and(eq(usageLog.executionId, executionId), eq(usageLog.source, 'workflow')))
    .groupBy(usageLog.category, usageLog.description)
    .orderBy(asc(usageLog.category), asc(usageLog.description))

  return rows.map((row) => ({
    category: row.category,
    description: row.description,
    cost: parseDecimal(row.cost),
  }))
}

async function loadMothershipLedgerSum(executionId: string): Promise<number> {
  const [row] = await db
    .select({ cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)` })
    .from(usageLog)
    .where(
      and(eq(usageLog.parentExecutionId, executionId), eq(usageLog.source, 'mothership_block'))
    )

  return parseDecimal(row?.cost)
}

/**
 * Loads reconciliation evidence for a single workflow execution, including
 * materialized trace spans and snapshot cost-block presence.
 */
export async function loadExecutionEvidence(
  executionId: string
): Promise<ExecutionEvidence | null> {
  return withReconcileDbRetry(() => loadExecutionEvidenceOnce(executionId), {
    operation: 'loadExecutionEvidence',
    executionId,
  })
}

async function loadExecutionEvidenceOnce(executionId: string): Promise<ExecutionEvidence | null> {
  const [row] = await db
    .select({
      executionId: workflowExecutionLogs.executionId,
      workflowId: workflowExecutionLogs.workflowId,
      workspaceId: workflowExecutionLogs.workspaceId,
      startedAt: workflowExecutionLogs.startedAt,
      status: workflowExecutionLogs.status,
      trigger: workflowExecutionLogs.trigger,
      stateSnapshotId: workflowExecutionLogs.stateSnapshotId,
      costTotal: workflowExecutionLogs.costTotal,
      modelsUsed: workflowExecutionLogs.modelsUsed,
      executionData: workflowExecutionLogs.executionData,
      snapshotStateData: workflowExecutionSnapshots.stateData,
    })
    .from(workflowExecutionLogs)
    .leftJoin(
      workflowExecutionSnapshots,
      eq(workflowExecutionSnapshots.id, workflowExecutionLogs.stateSnapshotId)
    )
    .where(eq(workflowExecutionLogs.executionId, executionId))
    .limit(1)

  if (!row) return null

  const executionData = (row.executionData ?? {}) as Record<string, unknown>
  const billingFlags = readBillingReconciliationFlags(executionData)
  const traceStoreExternalized = isLargeValueRef(executionData[TRACE_STORE_REF_KEY])

  let materializedData: Record<string, unknown> = executionData
  try {
    materializedData = await materializeExecutionData(executionData, {
      workspaceId: row.workspaceId,
      workflowId: row.workflowId,
      executionId: row.executionId,
    })
  } catch (error) {
    logger.warn('Failed to materialize execution data for reconciliation evidence', {
      executionId,
      error: getErrorMessage(error),
    })
  }

  const inlineTraceSpanCount =
    typeof executionData.traceSpanCount === 'number' ? executionData.traceSpanCount : 0
  const inlineHasTraceSpans = executionData.hasTraceSpans === true
  const traceSpans = materializedData.traceSpans as TraceSpanLike[] | undefined
  const trace = analyzeTraceSpans(traceSpans)

  trace.traceStoreExternalized = traceStoreExternalized
  trace.traceStoreMaterialized = traceSpans != null
  trace.traceSpanCount = Math.max(
    trace.traceSpanCount,
    inlineTraceSpanCount,
    traceSpans?.length ?? 0
  )
  trace.hasTraceSpans = trace.hasTraceSpans || inlineHasTraceSpans
  trace.traceStoreExpired =
    traceStoreExternalized &&
    !trace.hasTraceSpans &&
    (inlineHasTraceSpans || inlineTraceSpanCount > 0)

  const [ledgerLines, mothershipLedgerSum, ledgerSumRow] = await Promise.all([
    loadLedgerLines(executionId),
    loadMothershipLedgerSum(executionId),
    db
      .select({ cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)` })
      .from(usageLog)
      .where(and(eq(usageLog.executionId, executionId), eq(usageLog.source, 'workflow'))),
  ])

  const ledgerSum = parseDecimal(ledgerSumRow[0]?.cost)
  const costTotal = row.costTotal != null ? parseDecimal(row.costTotal) : null
  const snapshotState = row.snapshotStateData as WorkflowState | null | undefined

  return {
    executionId: row.executionId,
    workflowId: row.workflowId,
    workspaceId: row.workspaceId,
    startedAt: row.startedAt,
    status: row.status,
    trigger: row.trigger,
    stateSnapshotId: row.stateSnapshotId,
    costTotal,
    ledgerSum,
    drift: (costTotal ?? 0) - ledgerSum,
    billingReconciliationPending: billingFlags.pending,
    billingReconciliationReason: billingFlags.reason,
    ledgerLines,
    mothershipLedgerSum,
    trace,
    hasSnapshot: snapshotState != null,
    snapshotHasCostBlocks: snapshotStateHasCostBlocks(snapshotState),
    snapshotState: snapshotState ?? null,
    traceSpans,
    modelsUsed: row.modelsUsed,
  }
}

/**
 * Classifies a batch of historical workflow executions for audit and rollout planning.
 * Pages through the filtered scope and loads evidence with bounded concurrency.
 */
export async function auditHistoricalWorkflowExecutions(
  filter: HistoricalExecutionFilter = {},
  options: {
    onProgress?: HistoricalReconcileProgressCallback
    onlyPricedTools?: boolean
  } = {}
): Promise<ReconciliationAuditSummary> {
  const concurrency = resolveConcurrency(filter)
  const executionTimeoutMs = resolveExecutionTimeoutMs(filter)
  const onlyPricedTools = options.onlyPricedTools ?? filter.onlyPricedTools ?? false
  const classifications: ExecutionClassification[] = []
  const failures: HistoricalReconcileFailure[] = []
  const activeExecutions = new Map<string, number>()
  let attempted = 0
  let succeeded = 0
  let skipped = 0
  let failed = 0
  let pages = 0
  let previousEmitted = -1

  const snapshotProgress = (done: boolean): HistoricalReconcileProgress => ({
    attempted,
    succeeded,
    skipped,
    failed,
    pages,
    activeExecutions: snapshotActiveExecutions(activeExecutions),
    done,
  })

  const reportProgress = (done: boolean) => {
    if (done || shouldEmitProgress(attempted, previousEmitted)) {
      emitProgress(options.onProgress, snapshotProgress(done))
      previousEmitted = attempted
    }
  }

  const heartbeat = options.onProgress
    ? setInterval(
        () => emitProgress(options.onProgress, snapshotProgress(false)),
        HISTORICAL_RECONCILE_PROGRESS_HEARTBEAT_MS
      )
    : undefined

  try {
    for await (const page of iterateHistoricalWorkflowExecutionPages(filter)) {
      pages += 1
      const pageResults = await mapWithConcurrency(page, concurrency, async (row) => {
        activeExecutions.set(row.executionId, Date.now())
        try {
          const evidence = await withHistoricalReconcileExecutionTimeout(
            row.executionId,
            executionTimeoutMs,
            () => loadExecutionEvidence(row.executionId)
          )
          attempted += 1
          if (!evidence) {
            skipped += 1
            reportProgress(false)
            return { kind: 'skipped' as const, executionId: row.executionId }
          }
          succeeded += 1
          reportProgress(false)
          return {
            kind: 'classified' as const,
            classification: classifyExecutionEvidence(evidence, { onlyPricedTools }),
          }
        } catch (error) {
          attempted += 1
          failed += 1
          reportProgress(false)
          const failure = toHistoricalExecutionFailure(row.executionId, error)
          logger.warn('Failed to classify execution', {
            executionId: failure.executionId,
            error: failure.error,
            cause: failure.cause,
            postgresCode: failure.postgresCode,
          })
          return { kind: 'failed' as const, failure }
        } finally {
          activeExecutions.delete(row.executionId)
        }
      })

      for (const result of pageResults) {
        if (result.kind === 'classified') {
          classifications.push(result.classification)
        } else if (result.kind === 'failed') {
          failures.push(result.failure)
        }
      }

      reportProgress(false)
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
  }

  reportProgress(true)

  return aggregateClassificationResults(classifications, 20, {
    attempted,
    skipped,
    failed: failures.length,
    failures,
  })
}

function extractSubBlockValues(
  subBlocks: Record<string, { value?: unknown } | null | undefined>
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(subBlocks)) {
    if (entry && typeof entry === 'object' && 'value' in entry) {
      values[key] = entry.value
    }
  }
  return values
}

function workflowSnapshotToGraph(state: WorkflowState): {
  blocks: SerializedBlock[]
  connections: SerializedConnection[]
} {
  const blocks = Object.values(state.blocks).map((block) => ({
    id: block.id,
    position: block.position,
    config: {
      tool: block.type,
      params: extractSubBlockValues(block.subBlocks),
    },
    inputs: {},
    outputs: {},
    enabled: block.enabled,
    metadata: { id: block.type, name: block.name },
  }))

  const connections = state.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
  }))

  return { blocks, connections }
}

function buildSnapshotExecutionContext(params: {
  workflowId: string
  graph: { blocks: SerializedBlock[]; connections: SerializedConnection[] }
  blockStates: Map<string, BlockState>
  blockLogs: BlockLog[]
}): ExecutionContext {
  const serializedWorkflow: SerializedWorkflow = {
    version: '1',
    blocks: params.graph.blocks,
    connections: params.graph.connections,
    loops: {},
    parallels: {},
  }

  return {
    workflowId: params.workflowId,
    blockStates: params.blockStates,
    blockLogs: params.blockLogs,
    metadata: { duration: 0 },
    environmentVariables: {},
    decisions: { router: new Map(), condition: new Map() },
    loopExecutions: new Map(),
    completedLoops: new Set(),
    executedBlocks: new Set(params.blockStates.keys()),
    activeExecutionPath: new Set(),
    workflow: serializedWorkflow,
  }
}

function cloneTraceSpans(spans: TraceSpanLike[] | undefined): TraceSpanLike[] | undefined {
  if (!spans) return undefined
  return structuredClone(spans)
}

function readSpanTokenCounts(span: TraceSpanLike): {
  input: number
  output: number
  total: number
} {
  const tokens = span.tokens
  const input = tokens?.input ?? tokens?.prompt ?? 0
  const output = tokens?.output ?? tokens?.completion ?? 0
  const total = tokens?.total ?? input + output
  return { input, output, total }
}

function computeStandaloneToolCost(span: TraceSpanLike): {
  cost: number
  reason: string
  evidenceSource: string
} | null {
  if (span.type !== 'tool' || !span.output) return null

  const output = span.output
  const creditsUsed = readFirecrawlCreditsUsed(output)
  if (creditsUsed != null) {
    return {
      cost: creditsUsed * 0.001,
      reason: 'firecrawl_credits',
      evidenceSource: 'firecrawl_credits',
    }
  }

  const exaCost = readExaLikeCostDollars(output)
  if (exaCost != null) {
    return {
      cost: exaCost,
      reason: 'exa_cost_dollars',
      evidenceSource: 'exa_cost_dollars',
    }
  }

  const browserUseReported = readBrowserUseTotalCostUsd(output)
  if (
    browserUseReported != null &&
    browserUseReported > 0 &&
    (resolveSpanToolId(span) === 'browser_use_run_task' ||
      typeof output.__totalCostUsd === 'number')
  ) {
    return {
      cost: browserUseReported,
      reason: 'browser_use_cost',
      evidenceSource: 'browser_use_cost',
    }
  }

  if (typeof output.__falaiCostDollars === 'number' && output.__falaiCostDollars > 0) {
    return {
      cost: output.__falaiCostDollars * FALAI_HOSTED_KEY_MARKUP_MULTIPLIER,
      reason: 'falai_cost_dollars',
      evidenceSource: 'falai_cost_dollars',
    }
  }

  if (output.__imageBilling) {
    try {
      const { cost } = calculateHostedImageToolCost(span.input ?? {}, output)
      return {
        cost,
        reason: 'image_billing',
        evidenceSource: 'image_billing',
      }
    } catch {
      // Fall through to catalog reprice from input / output.metadata.
    }
  }

  const imageCatalog = computeImageCatalogToolCost(span)
  if (imageCatalog) {
    return imageCatalog
  }

  const hostedCatalog = computeHostedCatalogToolCost(span)
  if (hostedCatalog) {
    return hostedCatalog
  }

  const llmOnTool = computeLlmOnToolCost(span)
  if (llmOnTool) {
    return llmOnTool
  }

  const outputCost = getSpanToolOutputCost(span)
  if (outputCost > 0) {
    return {
      cost: outputCost,
      reason: 'tool_output_cost',
      evidenceSource: 'tool_output_cost',
    }
  }

  return null
}

/** Resolves the tool id used for allowlist / catalog routing. */
function resolveSpanToolId(span: TraceSpanLike): string {
  const raw = span.toolId?.trim() || span.name?.trim() || ''
  return normalizeUsageToolId(raw)
}

/** True when a tool span failed and must not receive catalog fallback charges. */
function isFailedToolSpan(span: TraceSpanLike): boolean {
  if (span.status === 'error') return true
  const output = span.output
  if (!output) return true
  if (output.error === true) return true
  if (typeof output.error === 'string' && output.error.trim().length > 0) return true
  return false
}

/**
 * Invokes live hosting `getCost` so reconcile rates stay shared with runtime billing.
 * Returns null when pricing throws or yields a non-positive cost.
 */
function extractHostingGetCost(
  pricing: ToolHostingPricing<Record<string, unknown>>,
  params: Record<string, unknown>,
  output: Record<string, unknown>
): number | null {
  if (pricing.type === 'per_request') {
    return pricing.cost > 0 ? pricing.cost : null
  }
  if (pricing.type !== 'custom') return null

  try {
    const result = pricing.getCost(params, output)
    const cost = typeof result === 'number' ? result : result.cost
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
      return cost
    }
    return null
  } catch {
    return null
  }
}

/** True when an image span should use the Fal.ai image floor (Fal model, no billing event). */
function isFalImageToolSpan(span: TraceSpanLike): boolean {
  const input = span.input ?? {}
  const output = span.output ?? {}
  const metadata =
    output.metadata && typeof output.metadata === 'object' && !Array.isArray(output.metadata)
      ? (output.metadata as Record<string, unknown>)
      : {}

  if (input.provider === 'falai' || output.provider === 'falai' || metadata.provider === 'falai') {
    return true
  }

  const modelCandidate =
    (typeof input.model === 'string' && input.model) ||
    (typeof output.model === 'string' && output.model) ||
    (typeof metadata.model === 'string' && metadata.model) ||
    undefined
  const providerCandidate =
    (typeof input.provider === 'string' && input.provider) ||
    (typeof output.provider === 'string' && output.provider) ||
    (typeof metadata.provider === 'string' && metadata.provider) ||
    undefined

  const reconciled = reconcileImageProviderAndModel({
    provider: providerCandidate,
    model: modelCandidate,
  })
  return reconciled.provider === 'falai'
}

/** True when a video tool span produced a billable video (not a failed generate). */
function isSuccessfulVideoToolSpan(span: TraceSpanLike): boolean {
  if (isFailedToolSpan(span) || !span.output) return false
  const output = span.output
  if (typeof output.videoUrl === 'string' && output.videoUrl.length > 0) return true
  if (typeof output.video === 'string' && output.video.length > 0) return true
  return true
}

/**
 * Catalog-fallback pricing for allowlisted hosted tools when vendor `__*` fields
 * were stripped. Reuses live hosting `getCost` / Fal floors — does not invent
 * Firecrawl credits.
 */
function computeHostedCatalogToolCost(span: TraceSpanLike): {
  cost: number
  reason: string
  evidenceSource: string
} | null {
  const toolId = resolveSpanToolId(span)
  if (!toolId || !span.output || isFailedToolSpan(span)) return null

  const params = span.input ?? {}
  const output = span.output

  if (toolId.startsWith('exa_')) {
    const cost = extractHostingGetCost(exaHosting.pricing, params, output)
    if (cost != null) {
      return {
        cost,
        reason: 'hosted_catalog_reprice',
        evidenceSource: 'hosted_catalog_reprice',
      }
    }
  }

  if (toolId === 'serper_search' && serperSearchTool?.hosting) {
    const cost = extractHostingGetCost(
      serperSearchTool.hosting.pricing as ToolHostingPricing<Record<string, unknown>>,
      params,
      output
    )
    if (cost != null) {
      return {
        cost,
        reason: 'hosted_catalog_reprice',
        evidenceSource: 'hosted_catalog_reprice',
      }
    }
  }

  if (toolId.startsWith('semrush_')) {
    const cost = extractHostingGetCost(semrushHosting.pricing, params, output)
    if (cost != null) {
      return {
        cost,
        reason: 'hosted_catalog_reprice',
        evidenceSource: 'hosted_catalog_reprice',
      }
    }
  }

  if (toolId === 'browser_use_run_task') {
    const cost = extractHostingGetCost(browserUseHosting.pricing, params, output)
    if (cost != null) {
      return {
        cost,
        reason: 'hosted_catalog_reprice',
        evidenceSource: 'hosted_catalog_reprice',
      }
    }
  }

  if (toolId === 'video_falai' && isSuccessfulVideoToolSpan(span) && falaiVideoTool?.hosting) {
    const fromGetCost = extractHostingGetCost(
      falaiVideoTool.hosting.pricing as ToolHostingPricing<Record<string, unknown>>,
      params,
      output
    )
    if (fromGetCost != null) {
      return {
        cost: fromGetCost,
        reason: 'falai_cost_dollars',
        evidenceSource: 'falai_cost_dollars',
      }
    }
    return {
      cost: FALAI_VIDEO_FALLBACK_PROVIDER_COST_DOLLARS * FALAI_HOSTED_KEY_MARKUP_MULTIPLIER,
      reason: 'falai_video_catalog_reprice',
      evidenceSource: 'falai_video_catalog_reprice',
    }
  }

  if (
    (IMAGE_AGGREGATE_TOOL_IDS.has(toolId) || isImageGenerationBillingKey(toolId)) &&
    isSuccessfulImageToolSpan(span) &&
    isFalImageToolSpan(span)
  ) {
    return {
      cost: FALAI_IMAGE_FALLBACK_PROVIDER_COST_DOLLARS * FALAI_HOSTED_KEY_MARKUP_MULTIPLIER,
      reason: 'falai_image_catalog_reprice',
      evidenceSource: 'falai_image_catalog_reprice',
    }
  }

  return null
}

/** True when the tool id is an allowlisted LLM-on-tool block. */
function isLlmOnToolId(toolId: string): boolean {
  if (LLM_ON_TOOL_ALLOWLIST.has(toolId)) return true
  if (toolId.startsWith('google_ads_')) return true
  if (toolId.startsWith('development_')) return true
  return false
}

/**
 * Rebuilds LLM-on-tool cost from retained `llmUsage` or tokens+model when
 * `output.cost` was stripped before persist.
 */
function computeLlmOnToolCost(span: TraceSpanLike): {
  cost: number
  reason: string
  evidenceSource: string
} | null {
  const toolId = resolveSpanToolId(span)
  if (!toolId || !isLlmOnToolId(toolId) || !span.output || isFailedToolSpan(span)) {
    return null
  }

  const output = span.output

  if (output.llmUsage && typeof output.llmUsage === 'object' && !Array.isArray(output.llmUsage)) {
    const fields = buildToolLlmCostFromModelUsage(output.llmUsage as ModelUsageByModel)
    if (fields && fields.cost.total > 0) {
      return {
        cost: fields.cost.total,
        reason: 'llm_on_tool_rebuild',
        evidenceSource: 'llm_on_tool_rebuild',
      }
    }
  }

  const metadata =
    output.metadata && typeof output.metadata === 'object' && !Array.isArray(output.metadata)
      ? (output.metadata as Record<string, unknown>)
      : null

  const model =
    (typeof output.model === 'string' && output.model.trim()) ||
    (typeof span.model === 'string' && span.model.trim()) ||
    (typeof metadata?.aiModel === 'string' && metadata.aiModel.trim()) ||
    ''

  let inputTokens = 0
  let outputTokens = 0
  const tokens = output.tokens
  if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
    const record = tokens as Record<string, unknown>
    inputTokens = typeof record.input === 'number' ? record.input : 0
    outputTokens = typeof record.output === 'number' ? record.output : 0
  } else if (metadata) {
    inputTokens = typeof metadata.inputTokens === 'number' ? metadata.inputTokens : 0
    outputTokens = typeof metadata.outputTokens === 'number' ? metadata.outputTokens : 0
  }

  const fields = buildToolLlmCostFields(model, inputTokens, outputTokens)
  if (!fields || !(fields.cost.total > 0)) return null

  return {
    cost: fields.cost.total,
    reason: 'llm_on_tool_rebuild',
    evidenceSource: 'llm_on_tool_rebuild',
  }
}

/**
 * True when an image tool span produced a billable image (not a failed generate).
 */
function isSuccessfulImageToolSpan(span: TraceSpanLike): boolean {
  const output = span.output
  if (!output) return false
  if (output.error === true) return false
  if (typeof output.message === 'string' && /no image data/i.test(output.message)) {
    return false
  }
  if (output.__imageBilling && typeof output.__imageBilling === 'object') return true
  if (typeof output.imageUrl === 'string' && output.imageUrl.length > 0) return true
  if (typeof output.image === 'string' && output.image.length > 0) return true
  if (Array.isArray(output.images) && output.images.length > 0) return true
  return false
}

/**
 * Prices a successful cost-stripped image tool from catalog dimensions on
 * `input` / `output.metadata` when `__imageBilling` was not retained.
 */
function computeImageCatalogToolCost(span: TraceSpanLike): {
  cost: number
  reason: string
  evidenceSource: string
} | null {
  const toolName = span.name?.trim() || span.toolId?.trim() || ''
  if (
    !toolName ||
    (!IMAGE_AGGREGATE_TOOL_IDS.has(toolName) && !isImageGenerationBillingKey(toolName))
  ) {
    return null
  }
  if (!span.output || !isSuccessfulImageToolSpan(span)) return null

  try {
    const { cost } = calculateHostedImageToolCost(span.input ?? {}, span.output)
    if (!(cost > 0)) return null
    return {
      cost,
      reason: 'image_catalog_reprice',
      evidenceSource: 'image_catalog_reprice',
    }
  } catch {
    return null
  }
}

/**
 * Promotes retained `output.cost` onto `span.cost` for agent/model spans so
 * calculateCostSummary can see model totals that were never copied to the span
 * root. Tool spans are left alone — hosted-tool reprice prefers `__costDollars`
 * / credits / `__imageBilling` over a possibly-stale `output.cost`.
 */
function promoteOutputCostToSpan(span: TraceSpanLike): void {
  if (span.type === 'tool') return
  if (hasInlineSpanCost(span)) return
  const outputCost = span.output?.cost
  if (!outputCost || typeof outputCost !== 'object' || Array.isArray(outputCost)) return
  const record = outputCost as Record<string, unknown>
  const total = record.total
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return

  span.cost = {
    input: typeof record.input === 'number' ? record.input : 0,
    output: typeof record.output === 'number' ? record.output : 0,
    total,
    ...(typeof record.toolCost === 'number' && record.toolCost > 0
      ? { toolCost: record.toolCost }
      : {}),
  }
}

/**
 * Seeds `output.cost.total` on a cloned tool span so
 * {@link extractEmbeddedToolCostsFromSpan} can fold it into the parent agent.
 */
function seedToolOutputCost(span: TraceSpanLike, cost: number): void {
  if (!(cost > 0)) return
  const existing =
    span.output?.cost && typeof span.output.cost === 'object' && !Array.isArray(span.output.cost)
      ? (span.output.cost as Record<string, unknown>)
      : {}
  span.output = {
    ...(span.output ?? {}),
    cost: {
      ...existing,
      total: cost,
    },
  }
}

/**
 * Enriches cost-stripped trace spans with repriced model, tool, and embedded-tool costs.
 */
export function enrichTraceSpansForReprice(
  traceSpans: TraceSpanLike[] | undefined
): TraceSpanLike[] | undefined {
  const cloned = cloneTraceSpans(traceSpans)
  if (!cloned) return undefined

  const visit = (span: TraceSpanLike, underAgent: boolean) => {
    const isAgent = span.type === 'agent' || Boolean(span.model)
    const nextUnderAgent = underAgent || isAgent

    // Enrich children first so agent-embedded tool costs exist before fold-up.
    span.children?.forEach((child) => visit(child, nextUnderAgent))

    promoteOutputCostToSpan(span)

    if (!hasInlineSpanCost(span)) {
      if (span.model && hasTokenCounts(span) && shouldBillModelUsage(span.model)) {
        const { input, output } = readSpanTokenCounts(span)
        const modelCost = resolveBlockModelCost({
          model: span.model,
          promptTokens: input,
          completionTokens: output,
        })
        span.cost = {
          input: modelCost.input,
          output: modelCost.output,
          total: modelCost.total,
        }
      } else if (span.type === 'tool' && !underAgent) {
        const toolCost = computeStandaloneToolCost(span)
        if (toolCost) {
          span.cost = { total: toolCost.cost }
        }
      }
    }

    if (span.type === 'tool' && underAgent && getSpanToolOutputCost(span) <= 0) {
      const toolCost = computeStandaloneToolCost(span)
      if (toolCost) {
        seedToolOutputCost(span, toolCost.cost)
      }
    }

    if (isAgent && (!hasInlineSpanCost(span) || (span.cost?.toolCost ?? 0) <= 0)) {
      const embeddedRaw = extractEmbeddedToolCostsFromSpan(span)
      const embeddedTotal = Object.values(embeddedRaw).reduce((sum, value) => sum + value, 0)
      if (embeddedTotal > 0) {
        const toolCost = embeddedTotal
        const normalized = normalizeEmbeddedToolCosts(embeddedRaw, toolCost)
        const normalizedTotal = Object.values(normalized).reduce((sum, value) => sum + value, 0)
        const modelOnlyTotal = Math.max(0, (span.cost?.total ?? 0) - (span.cost?.toolCost ?? 0))
        span.cost = {
          ...(span.cost ?? {}),
          input: span.cost?.input ?? 0,
          output: span.cost?.output ?? 0,
          toolCost: normalizedTotal,
          total: modelOnlyTotal + normalizedTotal,
        }
      }
    }
  }

  for (const span of cloned) {
    visit(span, false)
  }

  return cloned
}

async function computeSnapshotCostBlockTargets(params: {
  workflowId: string
  snapshotState: WorkflowState
  traceSpans: TraceSpanLike[] | undefined
  warnings: string[]
}): Promise<ReconciliationTargetLine[]> {
  const costBlockIds = Object.values(params.snapshotState.blocks)
    .filter((block) => block.type === BlockType.COST)
    .map((block) => block.id)

  if (costBlockIds.length === 0 || !params.traceSpans?.length) {
    return []
  }

  const graph = workflowSnapshotToGraph(params.snapshotState)
  const { blockStates, blockLogs } = collectTraceExecutionArtifacts(
    params.traceSpans as Parameters<typeof collectTraceExecutionArtifacts>[0]
  )
  const ctx = buildSnapshotExecutionContext({
    workflowId: params.workflowId,
    graph,
    blockStates,
    blockLogs,
  })

  const handler = new CostBlockHandler()
  const targets: ReconciliationTargetLine[] = []

  for (const costBlockId of costBlockIds) {
    const costBlock = graph.blocks.find((block) => block.id === costBlockId)
    if (!costBlock || costBlock.metadata?.id !== BlockType.COST) {
      continue
    }

    const mode = String(costBlock.config.params.mode ?? 'fixed')
    if (mode === 'expression') {
      params.warnings.push(`expression_cost_block_skipped:${costBlockId}`)
      continue
    }

    const inputs = { ...costBlock.config.params }
    const output = (await handler.executeWithNode(ctx, costBlock, inputs, {
      nodeId: costBlockId,
    })) as NormalizedBlockOutput

    if (!output.recorded || !output.cost?.total || output.cost.total <= RECONCILIATION_EPSILON) {
      continue
    }

    const raw = (output.raw ?? {}) as Record<string, unknown>
    const description = resolveExternalDescription(costBlock.metadata?.name ?? costBlockId, raw)

    targets.push({
      category: 'external',
      description,
      target: output.cost.total,
      reason: 'cost_block_snapshot',
      evidenceSource: 'cost_block_snapshot',
      vendor: typeof raw.vendor === 'string' ? raw.vendor : undefined,
      quantity: typeof raw.quantity === 'number' ? raw.quantity : output.units,
      unit: typeof raw.unit === 'string' ? raw.unit : undefined,
      metadata: {
        ...(typeof raw.amount === 'number' ? { originalAmount: raw.amount } : {}),
        ...(typeof raw.currency === 'string' ? { originalCurrency: raw.currency } : {}),
        ...(typeof raw.exchangeRate === 'number' ? { exchangeRate: raw.exchangeRate } : {}),
        ...(typeof raw.sourceBlockId === 'string' ? { sourceBlockId: raw.sourceBlockId } : {}),
        ...(typeof raw.responsePath === 'string' ? { responsePath: raw.responsePath } : {}),
        ...(typeof raw.quantityPath === 'string' ? { quantityPath: raw.quantityPath } : {}),
        ...(typeof raw.unitPrice === 'number' ? { unitPrice: raw.unitPrice } : {}),
        ...(typeof raw.source === 'string' ? { source: raw.source } : {}),
      },
    })
  }

  return targets
}

function externalChargeToTargetLine(
  description: string,
  charge: CostSummaryExternalCharge,
  evidenceSource: string
): ReconciliationTargetLine {
  return {
    category: 'external',
    description,
    target: charge.total,
    reason: evidenceSource,
    evidenceSource,
    vendor: charge.vendor,
    quantity: charge.quantity,
    unit: charge.unit,
    metadata: charge.metadata,
  }
}

function mergeTargetLines(lines: ReconciliationTargetLine[]): ReconciliationTargetLine[] {
  const merged = new Map<string, ReconciliationTargetLine>()

  for (const line of lines) {
    const key = ledgerLineKey(line.category, line.description)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...line })
      continue
    }

    existing.target += line.target
    if (!existing.reason && line.reason) existing.reason = line.reason
    if (!existing.evidenceSource && line.evidenceSource) {
      existing.evidenceSource = line.evidenceSource
    }
  }

  return [...merged.values()]
}

/**
 * Computes canonical target ledger lines from execution evidence using trace spans,
 * snapshot state, token repricing, and hosted-tool output metadata.
 */
export async function computeTargetLedgerLines(
  evidence: ExecutionEvidence,
  options: ComputeTargetLedgerOptions = {}
): Promise<{ targets: ReconciliationTargetLine[]; warnings: string[] }> {
  const pricingMode = options.pricingMode ?? HISTORICAL_RECONCILE_PRICING_MODE
  const warnings: string[] = []
  const targets: ReconciliationTargetLine[] = []

  if (
    !evidence.trace.hasTraceSpans &&
    !evidence.snapshotHasCostBlocks &&
    evidence.trace.traceStoreExpired
  ) {
    warnings.push('trace_store_unavailable')
    return { targets, warnings }
  }

  const enrichedSpans = enrichTraceSpansForReprice(evidence.traceSpans)
  const costSummary = calculateCostSummary(enrichedSpans)

  if (costSummary.baseExecutionCharge > 0) {
    targets.push({
      category: 'fixed',
      description: 'execution_fee',
      target: costSummary.baseExecutionCharge,
      reason: 'base_execution_charge',
      evidenceSource: 'base_execution_charge',
    })
  }

  for (const [modelName, modelData] of Object.entries(costSummary.models)) {
    const hasUsage =
      modelData.total > 0 ||
      modelData.tokens.total > 0 ||
      modelData.tokens.input > 0 ||
      modelData.tokens.output > 0
    if (!hasUsage) continue

    const evidenceSource =
      evidence.trace.spansWithInlineCost > 0 ? 'legacy_span_cost' : 'tokens_repriced'

    targets.push({
      category: 'model',
      description: normalizeUsageModelId(modelName),
      target: modelData.total,
      reason: evidenceSource,
      evidenceSource,
      metadata: {
        inputTokens: modelData.tokens.input,
        outputTokens: modelData.tokens.output,
        ...(modelData.toolCost != null && modelData.toolCost > 0
          ? { toolCost: modelData.toolCost }
          : {}),
        ...(modelData.embeddedToolCosts && Object.keys(modelData.embeddedToolCosts).length > 0
          ? { embeddedToolCosts: modelData.embeddedToolCosts }
          : {}),
      },
    })
  }

  for (const [description, charge] of Object.entries(costSummary.charges)) {
    if (charge.total <= 0) continue
    targets.push({
      category: 'tool',
      description: normalizeUsageToolId(description),
      target: charge.total,
      reason: 'standalone_tool_charge',
      evidenceSource:
        evidence.trace.spansWithHostedToolMetadata > 0
          ? (evidence.trace.hostedToolSignals[0] ?? 'hosted_tool')
          : 'tool_output_cost',
      toolId: normalizeUsageToolId(description),
    })
  }

  for (const [description, charge] of Object.entries(costSummary.external)) {
    if (charge.total <= 0) continue
    targets.push(externalChargeToTargetLine(description, charge, 'legacy_span_cost'))
  }

  if (
    evidence.snapshotHasCostBlocks &&
    evidence.snapshotState &&
    evidence.workflowId &&
    Object.keys(costSummary.external).length === 0
  ) {
    const snapshotTargets = await computeSnapshotCostBlockTargets({
      workflowId: evidence.workflowId,
      snapshotState: evidence.snapshotState,
      traceSpans: enrichedSpans,
      warnings,
    })
    targets.push(...snapshotTargets)
  }

  if (targets.length === 0 && !evidence.trace.hasTraceSpans) {
    warnings.push('unrecoverable')
  }

  if (pricingMode !== HISTORICAL_RECONCILE_PRICING_MODE) {
    warnings.push(`unsupported_pricing_mode:${pricingMode}`)
  }

  return {
    targets: mergeTargetLines(targets),
    warnings,
  }
}

function buildShadowRecord(params: {
  evidence: ExecutionEvidence
  classification: ExecutionClassification
  pricedToolScope: boolean
  targets: ReconciliationTargetLine[]
  warnings: string[]
  pricingMode?: HistoricalReconcilePricingMode
}): HistoricalReconcileShadowRecord {
  const alreadyBilled = new Map(
    params.evidence.ledgerLines.map((line) => [
      ledgerLineKey(line.category, line.description),
      line.cost,
    ])
  )

  const adjustment = buildHistoricalAdjustmentEntries({
    executionId: params.evidence.executionId,
    targets: params.targets,
    alreadyBilled,
    pricingMode: params.pricingMode,
  })

  const targetSum =
    params.targets.reduce(
      (sum, line) => sum + billableReconciliationAmount(line.category, line.target),
      0
    ) ||
    (params.evidence.trace.hasTraceSpans
      ? billableReconciliationAmount('fixed', BASE_EXECUTION_CHARGE)
      : 0)

  return {
    executionId: params.evidence.executionId,
    workflowId: params.evidence.workflowId,
    workspaceId: params.evidence.workspaceId,
    startedAt: params.evidence.startedAt.toISOString(),
    status: params.evidence.status,
    ledgerSum: params.evidence.ledgerSum,
    ledgerLines: params.evidence.ledgerLines,
    costTotal: params.evidence.costTotal,
    targetSum,
    positiveDelta: adjustment.positiveDeltaTotal,
    negativeDelta: adjustment.negativeDeltaTotal,
    confidence: params.classification.confidence,
    applyEligible:
      params.classification.applyEligible && adjustment.positiveDeltaTotal > RECONCILIATION_EPSILON,
    pricedToolScope: params.pricedToolScope,
    primaryClass: params.classification.primaryClass,
    warnings: [...new Set([...params.classification.warnings, ...params.warnings])],
    blockers: params.classification.blockers,
    targets: params.targets,
    pricingMode: params.pricingMode ?? HISTORICAL_RECONCILE_PRICING_MODE,
  }
}

/**
 * Maps a shadow reprice record into the verify-costs API response shape.
 */
export function toVerifyExecutionCostsResponse(record: HistoricalReconcileShadowRecord): {
  executionId: string
  workflowId: string | null
  workspaceId: string
  confidence: ReconciliationConfidence
  primaryClass: ReconciliationClass
  applyEligible: boolean
  blockers: string[]
  warnings: string[]
  billed: { total: number; lines: LedgerLineSummary[] }
  expected: {
    total: number
    lines: Array<{
      category: UsageLogCategory
      description: string
      target: number
      evidenceSource?: string
    }>
  }
  deltas: { positive: number; negative: number }
  onlyPricedTools: true
} {
  return {
    executionId: record.executionId,
    workflowId: record.workflowId,
    workspaceId: record.workspaceId,
    confidence: record.confidence,
    primaryClass: record.primaryClass,
    applyEligible: record.applyEligible,
    blockers: record.blockers,
    warnings: record.warnings,
    billed: {
      total: record.ledgerSum,
      lines: record.ledgerLines,
    },
    expected: {
      total: record.targetSum,
      lines: record.targets.map((line) => ({
        category: line.category,
        description: line.description,
        target: billableReconciliationAmount(line.category, line.target),
        ...(line.evidenceSource ? { evidenceSource: line.evidenceSource } : {}),
      })),
    },
    deltas: {
      positive: record.positiveDelta,
      negative: record.negativeDelta,
    },
    onlyPricedTools: true,
  }
}

/**
 * Computes a single execution's shadow repricing artifact without writing to the ledger.
 */
export async function computeShadowRepriceForExecution(
  executionId: string,
  options: ComputeTargetLedgerOptions = {}
): Promise<HistoricalReconcileShadowRecord | null> {
  const evidence = await loadExecutionEvidence(executionId)
  if (!evidence) return null

  const classification = classifyExecutionEvidence(evidence, {
    onlyPricedTools: options.onlyPricedTools,
  })
  const pricedToolScope = executionHasPricedToolSignal(evidence)
  const { targets, warnings } = await computeTargetLedgerLines(evidence, options)

  return buildShadowRecord({
    evidence,
    classification,
    pricedToolScope,
    targets,
    warnings,
    pricingMode: options.pricingMode,
  })
}

/**
 * Dry-run batch shadow repricer for historical workflow executions.
 * Pages through the filtered scope and reprices with bounded concurrency.
 *
 * Supports streaming export via `onRecord` (awaited per successful record) and
 * resumable runs via `excludeExecutionIds` (executions already present in a
 * previous artifact are skipped before any evidence load).
 */
export async function dryRunHistoricalWorkflowReprices(
  filter: HistoricalExecutionFilter = {},
  options: ComputeTargetLedgerOptions & {
    onProgress?: HistoricalReconcileProgressCallback
    /** Awaited immediately when each record completes; use for crash-safe incremental NDJSON export. */
    onRecord?: (record: HistoricalReconcileShadowRecord) => void | Promise<void>
    /** Execution IDs to skip (e.g. already exported by a previous interrupted run). */
    excludeExecutionIds?: ReadonlySet<string>
    /** Per-execution deadline overriding the filter/default. */
    executionTimeoutMs?: number
  } = {}
): Promise<ShadowRepriceSummary> {
  const concurrency = resolveConcurrency(filter)
  const executionTimeoutMs = resolveExecutionTimeoutMs(filter, options.executionTimeoutMs)
  const onlyPricedTools = options.onlyPricedTools ?? filter.onlyPricedTools ?? false
  const excludeExecutionIds = options.excludeExecutionIds
  const repriceOptions: ComputeTargetLedgerOptions = {
    pricingMode: options.pricingMode,
    onlyPricedTools,
  }
  const records: HistoricalReconcileShadowRecord[] = []
  const failures: HistoricalReconcileFailure[] = []
  const activeExecutions = new Map<string, number>()
  let attempted = 0
  let succeeded = 0
  let skipped = 0
  let failed = 0
  let resumedSkipped = 0
  let pages = 0
  let previousEmittedUnits = -1

  const snapshotProgress = (done: boolean): HistoricalReconcileProgress => ({
    attempted,
    succeeded,
    skipped,
    failed,
    pages,
    resumedSkipped,
    activeExecutions: snapshotActiveExecutions(activeExecutions),
    done,
  })

  const reportProgress = (done: boolean) => {
    const units = attempted + resumedSkipped
    if (done || shouldEmitProgress(units, previousEmittedUnits)) {
      emitProgress(options.onProgress, snapshotProgress(done))
      previousEmittedUnits = units
    }
  }

  // Live counters above are updated inside workers, so this heartbeat surfaces
  // mid-page progress during slow evidence loads (trace materialization etc).
  const heartbeat = options.onProgress
    ? setInterval(
        () => emitProgress(options.onProgress, snapshotProgress(false)),
        HISTORICAL_RECONCILE_PROGRESS_HEARTBEAT_MS
      )
    : undefined

  try {
    for await (const page of iterateHistoricalWorkflowExecutionPages(filter)) {
      pages += 1
      const rows = excludeExecutionIds
        ? page.filter((row) => !excludeExecutionIds.has(row.executionId))
        : page
      resumedSkipped += page.length - rows.length

      const pageResults = await mapWithConcurrency(rows, concurrency, async (row) => {
        activeExecutions.set(row.executionId, Date.now())
        let record: HistoricalReconcileShadowRecord | null
        try {
          record = await withHistoricalReconcileExecutionTimeout(
            row.executionId,
            executionTimeoutMs,
            () => computeShadowRepriceForExecution(row.executionId, repriceOptions)
          )
          attempted += 1
          if (!record) {
            skipped += 1
            reportProgress(false)
            return { kind: 'skipped' as const, executionId: row.executionId }
          }
        } catch (error) {
          attempted += 1
          failed += 1
          reportProgress(false)
          const failure = toHistoricalExecutionFailure(row.executionId, error)
          logger.warn('Failed to shadow-reprice execution', {
            executionId: failure.executionId,
            error: failure.error,
            cause: failure.cause,
            postgresCode: failure.postgresCode,
          })
          return { kind: 'failed' as const, failure }
        } finally {
          activeExecutions.delete(row.executionId)
        }

        if (options.onRecord) {
          try {
            await options.onRecord(record)
          } catch (error) {
            return { kind: 'export-failed' as const, error }
          }
        }

        succeeded += 1
        reportProgress(false)
        return { kind: 'record' as const, record }
      })

      const exportFailure = pageResults.find((result) => result.kind === 'export-failed')
      if (exportFailure?.kind === 'export-failed') {
        throw exportFailure.error
      }

      for (const result of pageResults) {
        if (result.kind === 'record') {
          records.push(result.record)
        } else if (result.kind === 'failed') {
          failures.push(result.failure)
        }
      }

      reportProgress(false)
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
  }

  reportProgress(true)

  let withPositiveDelta = 0
  let withNegativeDelta = 0
  let totalPositiveDelta = 0
  let totalNegativeDelta = 0

  for (const record of records) {
    if (record.positiveDelta > RECONCILIATION_EPSILON) withPositiveDelta += 1
    if (record.negativeDelta > RECONCILIATION_EPSILON) withNegativeDelta += 1
    totalPositiveDelta += record.positiveDelta
    totalNegativeDelta += record.negativeDelta
  }

  return {
    total: records.length,
    attempted,
    skipped,
    resumedSkipped,
    failed: failures.length,
    failures,
    withTargets: records.filter((record) => record.targets.length > 0).length,
    withPositiveDelta,
    withNegativeDelta,
    totalPositiveDelta,
    totalNegativeDelta,
    records,
  }
}

function ledgerLineKey(category: string, description: string): string {
  return `${category}::${description}`
}

/**
 * Builds append-only positive adjustment rows for a historical reconciliation apply.
 * Negative deltas are reported in the result but never emitted as ledger entries.
 */
export function buildHistoricalAdjustmentEntries(params: {
  executionId: string
  targets: ReconciliationTargetLine[]
  alreadyBilled: Map<string, number>
  pricingMode?: HistoricalReconcilePricingMode
}): HistoricalAdjustmentBuildResult {
  const pricingMode = params.pricingMode ?? HISTORICAL_RECONCILE_PRICING_MODE
  const entries: UsageEntry[] = []
  const skippedNegativeLines: HistoricalAdjustmentBuildResult['skippedNegativeLines'] = []
  let positiveDeltaTotal = 0
  let negativeDeltaTotal = 0

  for (const line of params.targets) {
    const key = ledgerLineKey(line.category, line.description)
    const billed = params.alreadyBilled.get(key) ?? 0
    const billableTarget = billableReconciliationAmount(line.category, line.target)
    const delta = billableTarget - billed

    if (delta < -RECONCILIATION_EPSILON) {
      negativeDeltaTotal += Math.abs(delta)
      skippedNegativeLines.push({
        category: line.category,
        description: line.description,
        target: billableTarget,
        billed,
        delta,
      })
      continue
    }

    if (delta <= RECONCILIATION_EPSILON) {
      continue
    }

    positiveDeltaTotal += delta
    const rawDelta = rawUsageAmountFromBillable(line.category, delta)
    entries.push({
      category: line.category,
      source: 'workflow',
      description: line.description,
      cost: rawDelta,
      rawCost: rawDelta,
      billableCost: delta,
      metadata: {
        ...(line.metadata && typeof line.metadata === 'object' && !Array.isArray(line.metadata)
          ? line.metadata
          : {}),
        backfill: HISTORICAL_RECONCILE_VERSION,
        repricedTarget: line.target,
        billedBefore: billed,
        ...(line.reason ? { reconcileReason: line.reason } : {}),
        ...(line.evidenceSource ? { evidenceSource: line.evidenceSource } : {}),
      },
      eventKey: stableEventKey({
        backfill: HISTORICAL_RECONCILE_VERSION,
        executionId: params.executionId,
        category: line.category,
        description: line.description,
        billedBefore: billed.toFixed(8),
        target: line.target.toFixed(8),
        pricingMode,
      }),
      ...(line.toolId ? { toolId: line.toolId } : {}),
      ...(line.vendor ? { vendor: line.vendor } : {}),
      ...(line.quantity != null ? { quantity: line.quantity } : {}),
      ...(line.unit ? { unit: line.unit } : {}),
      ...(line.pricingSnapshot ? { pricingSnapshot: line.pricingSnapshot } : {}),
      ...(line.category === 'tool' && !line.toolId ? { toolId: line.description } : {}),
      ...(line.category === 'model' && line.metadata
        ? {
            quantity:
              ((line.metadata as { inputTokens?: number }).inputTokens ?? 0) +
              ((line.metadata as { outputTokens?: number }).outputTokens ?? 0),
            unit: 'tokens',
          }
        : {}),
    })
  }

  return {
    entries,
    positiveDeltaTotal,
    negativeDeltaTotal,
    skippedNegativeLines,
  }
}

async function loadAlreadyBilledWorkflowLedger(
  executionId: string,
  executor: Pick<typeof db, 'select'> = db
): Promise<Map<string, number>> {
  const rows = await executor
    .select({
      category: usageLog.category,
      description: usageLog.description,
      cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)`,
    })
    .from(usageLog)
    .where(and(eq(usageLog.executionId, executionId), eq(usageLog.source, 'workflow')))
    .groupBy(usageLog.category, usageLog.description)

  const alreadyBilled = new Map<string, number>()
  for (const row of rows) {
    alreadyBilled.set(ledgerLineKey(row.category, row.description), parseDecimal(row.cost))
  }
  return alreadyBilled
}

async function loadWorkflowLedgerSum(
  executionId: string,
  executor: Pick<typeof db, 'select'> = db
): Promise<number> {
  const [row] = await executor
    .select({ cost: sql<string>`COALESCE(SUM(${usageLog.cost}), 0)` })
    .from(usageLog)
    .where(and(eq(usageLog.executionId, executionId), eq(usageLog.source, 'workflow')))

  return parseDecimal(row?.cost)
}

/**
 * Resolves the billing user for a workflow execution, preferring the execution log
 * attribution and falling back to the workflow owner.
 */
export async function resolveExecutionBillingUserId(params: {
  executionId: string
  workflowId?: string | null
}): Promise<string | null> {
  const [executionRow] = await db
    .select({
      userId: workflowExecutionLogs.userId,
      workflowId: workflowExecutionLogs.workflowId,
    })
    .from(workflowExecutionLogs)
    .where(eq(workflowExecutionLogs.executionId, params.executionId))
    .limit(1)

  if (executionRow?.userId) {
    return executionRow.userId
  }

  const workflowId = params.workflowId ?? executionRow?.workflowId
  if (!workflowId) {
    return null
  }

  const [workflowRow] = await db
    .select({ userId: workflow.userId })
    .from(workflow)
    .where(eq(workflow.id, workflowId))
    .limit(1)

  return workflowRow?.userId ?? null
}

/**
 * Parses one NDJSON shadow artifact line produced by the reconciliation dry-run.
 */
export function parseHistoricalReconcileShadowRecord(
  line: string
): HistoricalReconcileShadowRecord | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as Partial<HistoricalReconcileShadowRecord>
    if (
      typeof parsed.executionId !== 'string' ||
      typeof parsed.workspaceId !== 'string' ||
      typeof parsed.startedAt !== 'string' ||
      !Array.isArray(parsed.targets)
    ) {
      return null
    }

    return {
      executionId: parsed.executionId,
      workflowId: parsed.workflowId ?? null,
      workspaceId: parsed.workspaceId,
      startedAt: parsed.startedAt,
      status: parsed.status ?? 'unknown',
      ledgerSum: typeof parsed.ledgerSum === 'number' ? parsed.ledgerSum : 0,
      ledgerLines: Array.isArray(parsed.ledgerLines)
        ? parsed.ledgerLines.filter(
            (line): line is LedgerLineSummary =>
              line != null &&
              typeof line === 'object' &&
              typeof (line as LedgerLineSummary).category === 'string' &&
              typeof (line as LedgerLineSummary).description === 'string' &&
              typeof (line as LedgerLineSummary).cost === 'number'
          )
        : [],
      costTotal: typeof parsed.costTotal === 'number' ? parsed.costTotal : null,
      targetSum: typeof parsed.targetSum === 'number' ? parsed.targetSum : 0,
      positiveDelta: typeof parsed.positiveDelta === 'number' ? parsed.positiveDelta : 0,
      negativeDelta: typeof parsed.negativeDelta === 'number' ? parsed.negativeDelta : 0,
      confidence: parsed.confidence ?? 'low',
      applyEligible: parsed.applyEligible === true && typeof parsed.pricedToolScope === 'boolean',
      pricedToolScope: parsed.pricedToolScope === true,
      primaryClass: parsed.primaryClass ?? 'missing_trace_data',
      warnings: [
        ...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
        ...(typeof parsed.pricedToolScope === 'boolean' ? [] : [MISSING_PRICED_TOOL_SCOPE_WARNING]),
      ],
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      targets: parsed.targets,
      pricingMode: parsed.pricingMode ?? HISTORICAL_RECONCILE_PRICING_MODE,
    }
  } catch {
    return null
  }
}

/**
 * Applies one gated historical reconciliation record: positive append-only ledger
 * adjustments plus an exact `cost_total` refresh from the workflow ledger sum.
 */
export async function applyHistoricalReconciliation(params: {
  record: HistoricalReconcileShadowRecord
  userId: string
  requireEligible?: boolean
}): Promise<ApplyHistoricalReconciliationResult> {
  const { record, userId } = params
  const requireEligible = params.requireEligible ?? true

  if (record.warnings.includes(MISSING_PRICED_TOOL_SCOPE_WARNING)) {
    return {
      executionId: record.executionId,
      status: 'skipped',
      reason: 'artifact_missing_priced_tool_scope',
      entriesInserted: 0,
      positiveDeltaApplied: 0,
      negativeDeltaSkipped: record.negativeDelta,
      ledgerSumBefore: record.ledgerSum,
      ledgerSumAfter: record.ledgerSum,
      costTotalBefore: record.costTotal,
      costTotalAfter: record.costTotal ?? record.ledgerSum,
    }
  }

  if (requireEligible && !record.applyEligible) {
    return {
      executionId: record.executionId,
      status: 'skipped',
      reason: 'not_apply_eligible',
      entriesInserted: 0,
      positiveDeltaApplied: 0,
      negativeDeltaSkipped: record.negativeDelta,
      ledgerSumBefore: record.ledgerSum,
      ledgerSumAfter: record.ledgerSum,
      costTotalBefore: record.costTotal,
      costTotalAfter: record.costTotal ?? record.ledgerSum,
    }
  }

  if (record.blockers.length > 0) {
    return {
      executionId: record.executionId,
      status: 'skipped',
      reason: `blocked:${record.blockers.join(',')}`,
      entriesInserted: 0,
      positiveDeltaApplied: 0,
      negativeDeltaSkipped: record.negativeDelta,
      ledgerSumBefore: record.ledgerSum,
      ledgerSumAfter: record.ledgerSum,
      costTotalBefore: record.costTotal,
      costTotalAfter: record.costTotal ?? record.ledgerSum,
    }
  }

  const billingContext = deriveBillingContext(userId, await getHighestPrioritySubscription(userId))

  const startedAt = new Date(record.startedAt)
  if (Number.isNaN(startedAt.getTime())) {
    return {
      executionId: record.executionId,
      status: 'error',
      reason: 'invalid_started_at',
      entriesInserted: 0,
      positiveDeltaApplied: 0,
      negativeDeltaSkipped: record.negativeDelta,
      ledgerSumBefore: record.ledgerSum,
      ledgerSumAfter: record.ledgerSum,
      costTotalBefore: record.costTotal,
      costTotalAfter: record.costTotal ?? record.ledgerSum,
    }
  }

  try {
    let ledgerSumBefore = record.ledgerSum
    let entriesInserted = 0
    let positiveDeltaApplied = 0
    let negativeDeltaSkipped = 0
    let ledgerSumAfter = record.ledgerSum
    let costTotalAfter = record.costTotal ?? record.ledgerSum

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('lock_timeout', ${`${HISTORICAL_RECONCILE_LOCK_TIMEOUT_MS}ms`}, true)`
      )
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${record.executionId}, 0))`
      )

      const alreadyBilled = await loadAlreadyBilledWorkflowLedger(record.executionId, tx)
      ledgerSumBefore = await loadWorkflowLedgerSum(record.executionId, tx)

      const adjustment = buildHistoricalAdjustmentEntries({
        executionId: record.executionId,
        targets: record.targets,
        alreadyBilled,
        pricingMode: record.pricingMode,
      })

      negativeDeltaSkipped = adjustment.negativeDeltaTotal

      if (adjustment.entries.length > 0) {
        await recordUsage({
          userId,
          entries: adjustment.entries,
          workspaceId: record.workspaceId,
          workflowId: record.workflowId ?? undefined,
          executionId: record.executionId,
          occurredAt: startedAt,
          tx,
          billingEntity: billingContext.billingEntity,
          billingPeriod: billingContext.billingPeriod,
        })
        entriesInserted = adjustment.entries.length
        positiveDeltaApplied = adjustment.positiveDeltaTotal
      }

      ledgerSumAfter = await loadWorkflowLedgerSum(record.executionId, tx)
      costTotalAfter = ledgerSumAfter

      await tx
        .update(workflowExecutionLogs)
        .set({ costTotal: ledgerSumAfter.toString() })
        .where(eq(workflowExecutionLogs.executionId, record.executionId))
    })

    const status: HistoricalReconcileApplyStatus = entriesInserted > 0 ? 'applied' : 'unchanged'

    return {
      executionId: record.executionId,
      status,
      entriesInserted,
      positiveDeltaApplied,
      negativeDeltaSkipped,
      ledgerSumBefore,
      ledgerSumAfter,
      costTotalBefore: record.costTotal,
      costTotalAfter,
    }
  } catch (error) {
    const isLockTimeout = getPostgresErrorCode(error) === '55P03'
    logger.error('Failed to apply historical reconciliation', {
      executionId: record.executionId,
      error: getErrorMessage(error),
      lockTimeout: isLockTimeout,
    })

    return {
      executionId: record.executionId,
      status: 'error',
      reason: isLockTimeout ? 'advisory_lock_timeout' : getErrorMessage(error, 'apply_failed'),
      entriesInserted: 0,
      positiveDeltaApplied: 0,
      negativeDeltaSkipped: record.negativeDelta,
      ledgerSumBefore: record.ledgerSum,
      ledgerSumAfter: record.ledgerSum,
      costTotalBefore: record.costTotal,
      costTotalAfter: record.costTotal ?? record.ledgerSum,
    }
  }
}

export interface ApplyHistoricalReconciliationBatchFilter {
  workflowId?: string
  executionId?: string
  workspaceId?: string
  limit?: number
  /**
   * When true (CLI default), skip shadow records outside the priced-tool allowlist
   * even if the artifact was produced with `--all-tools`.
   */
  onlyPricedTools?: boolean
}

/**
 * Applies a batch of shadow artifact records with optional CLI filters.
 */
export async function applyHistoricalReconciliationBatch(params: {
  records: HistoricalReconcileShadowRecord[]
  filter?: ApplyHistoricalReconciliationBatchFilter
  requireEligible?: boolean
}): Promise<ApplyHistoricalReconciliationBatchResult> {
  const filter = params.filter ?? {}
  const requireEligible = params.requireEligible ?? true
  const onlyPricedTools = filter.onlyPricedTools ?? false

  let candidates = params.records
  if (filter.workflowId) {
    candidates = candidates.filter((record) => record.workflowId === filter.workflowId)
  }
  if (filter.executionId) {
    candidates = candidates.filter((record) => record.executionId === filter.executionId)
  }
  if (filter.workspaceId) {
    candidates = candidates.filter((record) => record.workspaceId === filter.workspaceId)
  }
  if (onlyPricedTools) {
    candidates = candidates.filter((record) => shadowRecordHasPricedToolEvidence(record))
  }
  if (filter.limit != null && filter.limit > 0) {
    candidates = candidates.slice(0, filter.limit)
  }

  const results: ApplyHistoricalReconciliationResult[] = []
  let applied = 0
  let unchanged = 0
  let skipped = 0
  let errors = 0
  let totalPositiveDeltaApplied = 0
  let totalNegativeDeltaSkipped = 0

  for (const record of candidates) {
    const userId = await resolveExecutionBillingUserId({
      executionId: record.executionId,
      workflowId: record.workflowId,
    })

    if (!userId) {
      results.push({
        executionId: record.executionId,
        status: 'error',
        reason: 'billing_user_not_found',
        entriesInserted: 0,
        positiveDeltaApplied: 0,
        negativeDeltaSkipped: record.negativeDelta,
        ledgerSumBefore: record.ledgerSum,
        ledgerSumAfter: record.ledgerSum,
        costTotalBefore: record.costTotal,
        costTotalAfter: record.costTotal ?? record.ledgerSum,
      })
      errors += 1
      continue
    }

    const result = await applyHistoricalReconciliation({
      record,
      userId,
      requireEligible,
    })
    results.push(result)

    if (result.status === 'applied') {
      applied += 1
      totalPositiveDeltaApplied += result.positiveDeltaApplied
    } else if (result.status === 'unchanged') {
      unchanged += 1
    } else if (result.status === 'skipped') {
      skipped += 1
    } else {
      errors += 1
    }

    totalNegativeDeltaSkipped += result.negativeDeltaSkipped
  }

  return {
    processed: results.length,
    applied,
    unchanged,
    skipped,
    errors,
    totalPositiveDeltaApplied,
    totalNegativeDeltaSkipped,
    results,
  }
}

/**
 * Loads NDJSON shadow artifact records from disk for gated apply.
 */
export async function loadHistoricalReconcileShadowArtifact(
  inputPath: string
): Promise<HistoricalReconcileShadowRecord[]> {
  const { access, readFile } = await import('node:fs/promises')
  try {
    await access(inputPath)
  } catch {
    throw new Error(`Shadow artifact not found: ${inputPath}`)
  }

  const text = await readFile(inputPath, 'utf8')
  const records: HistoricalReconcileShadowRecord[] = []

  for (const line of text.split('\n')) {
    const record = parseHistoricalReconcileShadowRecord(line)
    if (record) {
      records.push(record)
    }
  }

  return records
}

export interface ShadowArtifactWorkspaceScope {
  workspaceIds: string[]
  /** Set when every shadow record shares the same workspace. */
  singleWorkspaceId?: string
}

/**
 * Derives workspace scope from a shadow artifact. When all records belong to one
 * workspace, that id can drive pilot apply gates without a CLI `--workspace-id`.
 */
export function resolveShadowArtifactWorkspaceScope(
  records: HistoricalReconcileShadowRecord[]
): ShadowArtifactWorkspaceScope {
  const workspaceIds = [...new Set(records.map((record) => record.workspaceId))]
  return {
    workspaceIds,
    singleWorkspaceId: workspaceIds.length === 1 ? workspaceIds[0] : undefined,
  }
}

/** Maximum apply batch size treated as a pilot scope without `--confirm-production`. */
export const HISTORICAL_RECONCILE_PILOT_MAX_RECORDS = 100

export type HistoricalReconcileRolloutPhase = 'pilot' | 'production'

export interface HistoricalReconcileRolloutStep {
  step: number
  name: string
  description: string
  command: string
}

/**
 * Ordered ops rollout sequence for historical workflow cost reconciliation.
 * Run each step in order; do not skip straight to production apply.
 */
export const HISTORICAL_RECONCILE_ROLLOUT_STEPS: HistoricalReconcileRolloutStep[] = [
  {
    step: 1,
    name: 'baseline_audit',
    description:
      'Measure current ledger vs cost_total drift and inventory usage_log health across all history.',
    command:
      'bun --env-file=apps/sim/.env run scripts/phase0-arena-cost-audit.ts --days=9999 --limit=100000 --export-drift',
  },
  {
    step: 2,
    name: 'repair_projections',
    description:
      'Set cost_total = workflow ledger sum for NULL/mismatched projections only. Does not touch usage_log. Preview with --dry-run; persist with --write.',
    command:
      'bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --repair-projections --write --batch-size=1000',
  },
  {
    step: 3,
    name: 'evidence_audit',
    description:
      'Classify terminal workflow runs by reconciliation evidence, confidence, and apply eligibility.',
    command:
      'bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --audit --since=2020-01-01 --batch-size=1000 --only-priced-tools',
  },
  {
    step: 4,
    name: 'staging_shadow',
    description:
      'Compute shadow target ledger lines and export an NDJSON artifact for human review on staging.',
    command:
      'bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --dry-run --since=2020-01-01 --batch-size=1000 --only-priced-tools --export=reconcile-shadow.ndjson',
  },
  {
    step: 5,
    name: 'delta_review',
    description:
      'Review positive/negative deltas by workspace, workflow, model, and tool before any writes.',
    command:
      'bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --dry-run --since=2020-01-01 --batch-size=1000 --only-priced-tools --export=reconcile-shadow.ndjson --review-deltas',
  },
  {
    step: 6,
    name: 'pilot_apply',
    description:
      'Apply append-only adjustments for one workspace or narrow date range, then verify projection.',
    command:
      'bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --apply --input=reconcile-shadow.ndjson --batch-size=100 --only-priced-tools',
  },
  {
    step: 7,
    name: 'backfill_breakdowns',
    description:
      'When totals are already correct but model rows lack toolCost/embeddedToolCosts, patch usage_log.metadata only (preview, then --write). Does not change costs.',
    command:
      'bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --backfill-breakdowns --input=reconcile-shadow.ndjson --write --workspace-id=<workspace-id>',
  },
  {
    step: 8,
    name: 'post_pilot_verify',
    description: 'Re-run drift audit and ledger projection verification for the pilot workspace.',
    command:
      'bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --verify --workspace-id=<workspace-id> --batch-size=1000',
  },
  {
    step: 9,
    name: 'production_apply',
    description: 'Apply in small production batches only after pilot verification passes.',
    command:
      'bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --apply --input=reconcile-shadow.ndjson --batch-size=500 --confirm-production --only-priced-tools',
  },
  {
    step: 10,
    name: 'final_verify',
    description: 'Confirm cost_total equals workflow ledger sums after the full rollout.',
    command:
      'bun --env-file=apps/sim/.env run scripts/phase0-arena-cost-audit.ts --days=9999 --limit=100000 --drift-only',
  },
]

export interface LedgerProjectionDriftCase {
  executionId: string
  workflowId: string | null
  workspaceId: string
  startedAt: Date
  status: string
  costTotal: number | null
  ledgerSum: number
  drift: number
}

export interface LedgerProjectionVerification {
  total: number
  drifted: number
  passed: boolean
  driftExamples: LedgerProjectionDriftCase[]
}

export interface LedgerProjectionRepairCase extends LedgerProjectionDriftCase {
  costTotalAfter: number
}

export interface LedgerProjectionRepairSummary {
  /** Terminal executions scanned under the filter. */
  scanned: number
  /** Executions whose `cost_total` differed from the workflow ledger sum. */
  drifted: number
  /** Executions updated (0 when `dryRun` is true). */
  repaired: number
  /** True when no writes were performed. */
  dryRun: boolean
  /** Sample of repaired (or would-repair) cases. */
  examples: LedgerProjectionRepairCase[]
  attempted: number
  succeeded: number
  skipped: number
  failed: number
  failures: HistoricalReconcileFailure[]
  pages: number
}

export interface ShadowDeltaBucket {
  id: string
  executions: number
  positiveDelta: number
  negativeDelta: number
  applyEligible: number
}

export interface ShadowDeltaAttributionBucket {
  description: string
  category: UsageLogCategory
  positiveDelta: number
  executions: number
}

export interface ShadowDeltaReviewBreakdown {
  totals: {
    executions: number
    applyEligible: number
    positiveDelta: number
    negativeDelta: number
    eligiblePositiveDelta: number
    eligibleNegativeDelta: number
    outOfScopePositiveDelta: number
  }
  byWorkspace: ShadowDeltaBucket[]
  byWorkflow: ShadowDeltaBucket[]
  byModel: ShadowDeltaAttributionBucket[]
  byTool: ShadowDeltaAttributionBucket[]
}

export interface ApplyRolloutGateResult {
  allowed: boolean
  phase: HistoricalReconcileRolloutPhase
  blockers: string[]
  warnings: string[]
}

export interface PostApplyVerificationResult {
  executionId: string
  passed: boolean
  costTotal: number | null
  ledgerSum: number
  drift: number
}

export interface PostApplyVerificationSummary {
  total: number
  passed: number
  failed: number
  results: PostApplyVerificationResult[]
}

function ledgerLinesToBilledMap(lines: LedgerLineSummary[]): Map<string, number> {
  return new Map(lines.map((line) => [ledgerLineKey(line.category, line.description), line.cost]))
}

function upsertShadowDeltaBucket(
  buckets: Map<string, ShadowDeltaBucket>,
  id: string,
  record: HistoricalReconcileShadowRecord
): void {
  const existing = buckets.get(id) ?? {
    id,
    executions: 0,
    positiveDelta: 0,
    negativeDelta: 0,
    applyEligible: 0,
  }

  existing.executions += 1
  existing.positiveDelta += record.positiveDelta
  existing.negativeDelta += record.negativeDelta
  if (record.applyEligible) existing.applyEligible += 1
  buckets.set(id, existing)
}

function upsertAttributionBucket(
  buckets: Map<string, ShadowDeltaAttributionBucket>,
  category: UsageLogCategory,
  description: string,
  positiveDelta: number
): void {
  if (positiveDelta <= RECONCILIATION_EPSILON) return

  const key = ledgerLineKey(category, description)
  const existing = buckets.get(key) ?? {
    description,
    category,
    positiveDelta: 0,
    executions: 0,
  }

  existing.executions += 1
  existing.positiveDelta += positiveDelta
  buckets.set(key, existing)
}

function positiveDeltaForTargetLine(params: {
  executionId: string
  targets: ReconciliationTargetLine[]
  alreadyBilled: Map<string, number>
  pricingMode: HistoricalReconcilePricingMode
  category: UsageLogCategory
  description: string
}): number {
  const target = params.targets.find(
    (line) => line.category === params.category && line.description === params.description
  )
  if (!target) return 0

  const adjustment = buildHistoricalAdjustmentEntries({
    executionId: params.executionId,
    targets: [target],
    alreadyBilled: params.alreadyBilled,
    pricingMode: params.pricingMode,
  })

  return adjustment.positiveDeltaTotal
}

/**
 * Aggregates shadow repricing artifacts for pre-apply review by workspace,
 * workflow, model, and hosted tool attribution.
 */
export function aggregateShadowDeltaReview(
  records: HistoricalReconcileShadowRecord[],
  topN = 20
): ShadowDeltaReviewBreakdown {
  const byWorkspace = new Map<string, ShadowDeltaBucket>()
  const byWorkflow = new Map<string, ShadowDeltaBucket>()
  const byModel = new Map<string, ShadowDeltaAttributionBucket>()
  const byTool = new Map<string, ShadowDeltaAttributionBucket>()

  let applyEligible = 0
  let positiveDelta = 0
  let negativeDelta = 0
  let eligiblePositiveDelta = 0
  let eligibleNegativeDelta = 0
  let outOfScopePositiveDelta = 0

  for (const record of records) {
    positiveDelta += record.positiveDelta
    negativeDelta += record.negativeDelta
    if (record.primaryClass === 'out_of_scope') {
      outOfScopePositiveDelta += record.positiveDelta
    }
    if (!record.applyEligible) continue

    applyEligible += 1
    eligiblePositiveDelta += record.positiveDelta
    eligibleNegativeDelta += record.negativeDelta
    upsertShadowDeltaBucket(byWorkspace, record.workspaceId, record)
    upsertShadowDeltaBucket(byWorkflow, record.workflowId ?? '(no-workflow)', record)

    const alreadyBilled = ledgerLinesToBilledMap(record.ledgerLines ?? [])
    for (const line of record.targets) {
      const linePositiveDelta = positiveDeltaForTargetLine({
        executionId: record.executionId,
        targets: record.targets,
        alreadyBilled,
        pricingMode: record.pricingMode,
        category: line.category,
        description: line.description,
      })
      if (line.category === 'model') {
        upsertAttributionBucket(byModel, 'model', line.description, linePositiveDelta)
      } else if (line.category === 'tool') {
        upsertAttributionBucket(byTool, 'tool', line.description, linePositiveDelta)
      }
    }
  }

  const sortBuckets = (items: ShadowDeltaBucket[]) =>
    [...items].sort((a, b) => b.positiveDelta - a.positiveDelta).slice(0, topN)

  const sortAttribution = (items: ShadowDeltaAttributionBucket[]) =>
    [...items].sort((a, b) => b.positiveDelta - a.positiveDelta).slice(0, topN)

  return {
    totals: {
      executions: records.length,
      applyEligible,
      positiveDelta,
      negativeDelta,
      eligiblePositiveDelta,
      eligibleNegativeDelta,
      outOfScopePositiveDelta,
    },
    byWorkspace: sortBuckets([...byWorkspace.values()]),
    byWorkflow: sortBuckets([...byWorkflow.values()]),
    byModel: sortAttribution([...byModel.values()]),
    byTool: sortAttribution([...byTool.values()]),
  }
}

/**
 * Verifies that `workflow_execution_logs.cost_total` matches the workflow ledger
 * projection for the filtered execution sample.
 */
export async function verifyLedgerProjection(
  filter: HistoricalExecutionFilter = {},
  maxDriftExamples = 20
): Promise<LedgerProjectionVerification> {
  const driftExamples: LedgerProjectionDriftCase[] = []
  let total = 0
  let drifted = 0

  for await (const page of iterateHistoricalWorkflowExecutionPages(filter)) {
    for (const row of page) {
      total += 1
      if (Math.abs(row.drift) <= RECONCILIATION_EPSILON) continue

      drifted += 1
      if (driftExamples.length < maxDriftExamples) {
        driftExamples.push({
          executionId: row.executionId,
          workflowId: row.workflowId,
          workspaceId: row.workspaceId,
          startedAt: row.startedAt,
          status: row.status,
          costTotal: row.costTotal,
          ledgerSum: row.ledgerSum,
          drift: row.drift,
        })
      }
    }
  }

  return {
    total,
    drifted,
    passed: drifted === 0,
    driftExamples,
  }
}

function needsLedgerProjectionRepair(row: HistoricalExecutionRow): boolean {
  return Math.abs(row.drift) > RECONCILIATION_EPSILON
}

/**
 * Repairs `workflow_execution_logs.cost_total` to match
 * `SUM(usage_log.cost WHERE source = 'workflow')` for drifted terminal runs.
 *
 * Does not insert, delete, or reprice `usage_log` rows. Defaults to dry-run;
 * pass `{ dryRun: false }` (CLI `--write`) to persist.
 */
export async function repairLedgerProjections(
  filter: HistoricalExecutionFilter = {},
  options: {
    dryRun?: boolean
    onProgress?: HistoricalReconcileProgressCallback
    maxExamples?: number
  } = {}
): Promise<LedgerProjectionRepairSummary> {
  const dryRun = options.dryRun !== false
  const maxExamples = options.maxExamples ?? 50
  const examples: LedgerProjectionRepairCase[] = []

  let scanned = 0
  let drifted = 0
  let repaired = 0
  let pages = 0
  let attempted = 0
  let succeeded = 0
  let skipped = 0
  let failed = 0
  const failures: HistoricalReconcileFailure[] = []
  let previousEmitted = -1

  const reportProgress = (done: boolean) => {
    if (!(done || shouldEmitProgress(attempted, previousEmitted))) {
      return
    }
    previousEmitted = attempted
    emitProgress(options.onProgress, {
      attempted,
      succeeded,
      skipped,
      failed,
      pages,
      done,
    })
  }

  for await (const page of iterateHistoricalWorkflowExecutionPages(filter)) {
    pages += 1
    await ensureDatabaseConnection()

    const driftedRows = page.filter(needsLedgerProjectionRepair)
    scanned += page.length
    skipped += page.length - driftedRows.length

    for (const row of driftedRows) {
      attempted += 1
      drifted += 1

      const costTotalAfter = row.ledgerSum
      const example: LedgerProjectionRepairCase = {
        executionId: row.executionId,
        workflowId: row.workflowId,
        workspaceId: row.workspaceId,
        startedAt: row.startedAt,
        status: row.status,
        costTotal: row.costTotal,
        ledgerSum: row.ledgerSum,
        drift: row.drift,
        costTotalAfter,
      }

      if (examples.length < maxExamples) {
        examples.push(example)
      }

      if (dryRun) {
        succeeded += 1
        reportProgress(false)
        continue
      }

      try {
        await withReconcileDbRetry(
          async () => {
            await db
              .update(workflowExecutionLogs)
              .set({ costTotal: costTotalAfter.toString() })
              .where(eq(workflowExecutionLogs.executionId, row.executionId))
          },
          {
            operation: 'repairLedgerProjection',
            executionId: row.executionId,
          }
        )
        repaired += 1
        succeeded += 1
      } catch (error) {
        failed += 1
        failures.push(toHistoricalExecutionFailure(row.executionId, error))
        logger.error('Failed to repair ledger projection', {
          executionId: row.executionId,
          error: getErrorMessage(error),
        })
      }

      reportProgress(false)
    }

    reportProgress(false)
  }

  reportProgress(true)

  return {
    scanned,
    drifted,
    repaired,
    dryRun,
    examples,
    attempted,
    succeeded,
    skipped,
    failed,
    failures,
    pages,
  }
}

/** Provenance stamp written onto patched model `usage_log.metadata`. */
export const HISTORICAL_BREAKDOWN_BACKFILL_VERSION = 'historical-breakdown-v1'

/**
 * Only multipliers Sim has ever used for `USAGE_LOG_COST_MULTIPLIER` /
 * `COST_MULTIPLIER`. Breakdown backfill snaps billed/catalog ratios to these.
 */
export const HISTORICAL_USAGE_MULTIPLIER_CANDIDATES = [1, 2] as const

export type HistoricalUsageMultiplier = (typeof HISTORICAL_USAGE_MULTIPLIER_CANDIDATES)[number]

/** Relative tolerance when matching billed model cost to catalog × {1, 2}. */
export const HISTORICAL_MULTIPLIER_MATCH_RELATIVE_TOLERANCE = 0.02

export interface ModelBreakdownPatchPlan {
  executionId: string
  workspaceId: string
  workflowId: string | null
  modelDescription: string
  billedModelCost: number
  targetModelCost: number
  /** Inferred historical billable multiplier (`1` or `2`). */
  historicalMultiplier: HistoricalUsageMultiplier
  scale: number
  toolCost: number
  embeddedToolCosts: Record<string, number>
}

export type ModelBreakdownSkipReason =
  | 'out_of_scope'
  | 'no_model_breakdown_target'
  | 'no_model_ledger_line'
  | 'zero_target_model_cost'
  | 'ambiguous_multiplier'
  | 'tool_cost_exceeds_model'
  | 'already_present'

export interface ModelBreakdownSkip {
  executionId: string
  modelDescription?: string
  reason: ModelBreakdownSkipReason
}

export interface ModelBreakdownBackfillResult {
  executionId: string
  modelDescription: string
  status: 'patched' | 'would_patch' | 'skipped' | 'error'
  reason?: string
  usageLogId?: string
  historicalMultiplier?: HistoricalUsageMultiplier
  toolCost?: number
  embeddedToolCosts?: Record<string, number>
}

export interface ModelBreakdownBackfillBatchResult {
  dryRun: boolean
  processed: number
  patched: number
  wouldPatch: number
  skipped: number
  errors: number
  results: ModelBreakdownBackfillResult[]
  skips: ModelBreakdownSkip[]
}

function readTargetToolCost(metadata: UsageLogMetadata | undefined): number {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 0
  const toolCost = (metadata as { toolCost?: unknown }).toolCost
  return typeof toolCost === 'number' && Number.isFinite(toolCost) && toolCost > 0 ? toolCost : 0
}

function readTargetEmbeddedToolCosts(
  metadata: UsageLogMetadata | undefined
): Record<string, number> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const raw = (metadata as { embeddedToolCosts?: unknown }).embeddedToolCosts
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[key] = value
    }
  }
  return out
}

function scaleEmbeddedToolCosts(
  embedded: Record<string, number>,
  scale: number
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(embedded)) {
    const scaled = Number.parseFloat((value * scale).toFixed(8))
    if (scaled > 0) out[key] = scaled
  }
  return out
}

function embeddedBreakdownMatches(
  existing: Record<string, number>,
  next: Record<string, number>
): boolean {
  const existingKeys = Object.keys(existing)
  const nextKeys = Object.keys(next)
  if (existingKeys.length === 0 || nextKeys.length === 0) return false
  if (existingKeys.length !== nextKeys.length) return false
  for (const key of nextKeys) {
    const left = existing[key]
    const right = next[key]
    if (typeof left !== 'number' || Math.abs(left - right) > RECONCILIATION_EPSILON) {
      return false
    }
  }
  return true
}

/**
 * Infers whether a model ledger line was billed under historical multiplier 1×
 * or 2× by comparing billed dollars to the catalog COGS target.
 * Returns null when the ratio is not close to either candidate.
 */
export function inferHistoricalUsageMultiplier(
  billedModelCost: number,
  catalogTargetCost: number
): HistoricalUsageMultiplier | null {
  if (!(billedModelCost > 0) || !(catalogTargetCost > 0)) return null

  let best: HistoricalUsageMultiplier | null = null
  let bestError = Number.POSITIVE_INFINITY

  for (const candidate of HISTORICAL_USAGE_MULTIPLIER_CANDIDATES) {
    const expected = catalogTargetCost * candidate
    const error = Math.abs(billedModelCost - expected)
    const tolerance = Math.max(
      RECONCILIATION_EPSILON,
      expected * HISTORICAL_MULTIPLIER_MATCH_RELATIVE_TOLERANCE
    )
    if (error <= tolerance && error < bestError) {
      best = candidate
      bestError = error
    }
  }

  return best
}

/**
 * True when existing model metadata already carries an equivalent embedded
 * tool breakdown (so a metadata-only backfill would be a no-op).
 */
export function modelBreakdownAlreadyPresent(params: {
  existingMetadata: unknown
  toolCost: number
  embeddedToolCosts: Record<string, number>
}): boolean {
  const existing =
    params.existingMetadata &&
    typeof params.existingMetadata === 'object' &&
    !Array.isArray(params.existingMetadata)
      ? (params.existingMetadata as Record<string, unknown>)
      : null
  if (!existing) return false

  const existingToolCost =
    typeof existing.toolCost === 'number' && Number.isFinite(existing.toolCost)
      ? existing.toolCost
      : 0
  const existingEmbedded = readTargetEmbeddedToolCosts(existing)

  if (Object.keys(params.embeddedToolCosts).length === 0) return false
  if (!embeddedBreakdownMatches(existingEmbedded, params.embeddedToolCosts)) return false
  if (params.toolCost > 0 && existingToolCost > 0) {
    return Math.abs(existingToolCost - params.toolCost) <= RECONCILIATION_EPSILON
  }
  return existingToolCost > 0 || Object.keys(existingEmbedded).length > 0
}

/**
 * Plans metadata-only model breakdown patches from a shadow reprice record.
 * Catalog COGS breakdowns are scaled by an inferred historical multiplier of
 * **1× or 2×** (the only values Sim has used) so virtual splits match
 * `usage_log.cost` without requiring the live env multiplier to match history.
 *
 * Does not change ledger dollars — only proposes `toolCost` / `embeddedToolCosts`.
 */
export function planModelBreakdownPatches(record: HistoricalReconcileShadowRecord): {
  patches: ModelBreakdownPatchPlan[]
  skips: ModelBreakdownSkip[]
} {
  const patches: ModelBreakdownPatchPlan[] = []
  const skips: ModelBreakdownSkip[] = []

  if (record.primaryClass === 'out_of_scope' || !record.pricedToolScope) {
    skips.push({ executionId: record.executionId, reason: 'out_of_scope' })
    return { patches, skips }
  }

  const modelTargets = record.targets.filter(
    (line) =>
      line.category === 'model' &&
      (readTargetToolCost(line.metadata) > 0 ||
        Object.keys(readTargetEmbeddedToolCosts(line.metadata)).length > 0)
  )

  if (modelTargets.length === 0) {
    skips.push({ executionId: record.executionId, reason: 'no_model_breakdown_target' })
    return { patches, skips }
  }

  for (const target of modelTargets) {
    const billedModelCost =
      record.ledgerLines.find(
        (line) => line.category === 'model' && line.description === target.description
      )?.cost ?? 0

    if (!(billedModelCost > RECONCILIATION_EPSILON)) {
      skips.push({
        executionId: record.executionId,
        modelDescription: target.description,
        reason: 'no_model_ledger_line',
      })
      continue
    }

    if (!(target.target > RECONCILIATION_EPSILON)) {
      skips.push({
        executionId: record.executionId,
        modelDescription: target.description,
        reason: 'zero_target_model_cost',
      })
      continue
    }

    const historicalMultiplier = inferHistoricalUsageMultiplier(billedModelCost, target.target)
    if (historicalMultiplier == null) {
      skips.push({
        executionId: record.executionId,
        modelDescription: target.description,
        reason: 'ambiguous_multiplier',
      })
      continue
    }

    const scale = historicalMultiplier
    const rawToolCost = readTargetToolCost(target.metadata)
    const rawEmbedded = readTargetEmbeddedToolCosts(target.metadata)
    const toolCost = Number.parseFloat((rawToolCost * scale).toFixed(8))
    const embeddedToolCosts = scaleEmbeddedToolCosts(rawEmbedded, scale)

    if (toolCost > billedModelCost + RECONCILIATION_EPSILON) {
      skips.push({
        executionId: record.executionId,
        modelDescription: target.description,
        reason: 'tool_cost_exceeds_model',
      })
      continue
    }

    if (Object.keys(embeddedToolCosts).length === 0 && !(toolCost > 0)) {
      skips.push({
        executionId: record.executionId,
        modelDescription: target.description,
        reason: 'no_model_breakdown_target',
      })
      continue
    }

    patches.push({
      executionId: record.executionId,
      workspaceId: record.workspaceId,
      workflowId: record.workflowId,
      modelDescription: target.description,
      billedModelCost,
      targetModelCost: target.target,
      historicalMultiplier,
      scale,
      toolCost,
      embeddedToolCosts,
    })
  }

  return { patches, skips }
}

async function loadWorkflowModelUsageRows(params: {
  executionId: string
  modelDescription: string
}): Promise<Array<{ id: string; cost: string; metadata: unknown }>> {
  return db
    .select({
      id: usageLog.id,
      cost: usageLog.cost,
      metadata: usageLog.metadata,
    })
    .from(usageLog)
    .where(
      and(
        eq(usageLog.executionId, params.executionId),
        eq(usageLog.source, 'workflow'),
        eq(usageLog.category, 'model'),
        eq(usageLog.description, params.modelDescription)
      )
    )
}

/**
 * Applies metadata-only embedded-tool breakdowns from shadow records onto
 * existing workflow model `usage_log` rows. Never changes `cost` / `raw_cost` /
 * `billable_cost` or `workflow_execution_logs.cost_total`.
 *
 * Defaults to dry-run; pass `{ dryRun: false }` (CLI `--write`) to persist.
 */
export async function backfillModelBreakdownMetadata(
  records: HistoricalReconcileShadowRecord[],
  options: { dryRun?: boolean } = {}
): Promise<ModelBreakdownBackfillBatchResult> {
  const dryRun = options.dryRun !== false
  const results: ModelBreakdownBackfillResult[] = []
  const skips: ModelBreakdownSkip[] = []
  let patched = 0
  let wouldPatch = 0
  let skipped = 0
  let errors = 0

  for (const record of records) {
    const planned = planModelBreakdownPatches(record)
    skips.push(...planned.skips)
    skipped += planned.skips.length

    for (const patch of planned.patches) {
      try {
        const rows = await withReconcileDbRetry(
          () =>
            loadWorkflowModelUsageRows({
              executionId: patch.executionId,
              modelDescription: patch.modelDescription,
            }),
          {
            operation: 'loadWorkflowModelUsageRows',
            executionId: patch.executionId,
            modelDescription: patch.modelDescription,
          }
        )

        if (rows.length === 0) {
          skipped += 1
          skips.push({
            executionId: patch.executionId,
            modelDescription: patch.modelDescription,
            reason: 'no_model_ledger_line',
          })
          results.push({
            executionId: patch.executionId,
            modelDescription: patch.modelDescription,
            status: 'skipped',
            reason: 'no_model_ledger_line',
          })
          continue
        }

        const primary = [...rows].sort(
          (left, right) => parseDecimal(right.cost) - parseDecimal(left.cost)
        )[0]!

        if (
          modelBreakdownAlreadyPresent({
            existingMetadata: primary.metadata,
            toolCost: patch.toolCost,
            embeddedToolCosts: patch.embeddedToolCosts,
          })
        ) {
          skipped += 1
          skips.push({
            executionId: patch.executionId,
            modelDescription: patch.modelDescription,
            reason: 'already_present',
          })
          results.push({
            executionId: patch.executionId,
            modelDescription: patch.modelDescription,
            status: 'skipped',
            reason: 'already_present',
            usageLogId: primary.id,
          })
          continue
        }

        const existing =
          primary.metadata &&
          typeof primary.metadata === 'object' &&
          !Array.isArray(primary.metadata)
            ? (primary.metadata as Record<string, unknown>)
            : {}

        const nextMetadata = {
          ...existing,
          ...(typeof existing.inputTokens === 'number'
            ? { inputTokens: existing.inputTokens }
            : {}),
          ...(typeof existing.outputTokens === 'number'
            ? { outputTokens: existing.outputTokens }
            : {}),
          toolCost: patch.toolCost,
          embeddedToolCosts: patch.embeddedToolCosts,
          backfill: HISTORICAL_BREAKDOWN_BACKFILL_VERSION,
          historicalMultiplier: patch.historicalMultiplier,
        }

        if (dryRun) {
          wouldPatch += 1
          results.push({
            executionId: patch.executionId,
            modelDescription: patch.modelDescription,
            status: 'would_patch',
            usageLogId: primary.id,
            historicalMultiplier: patch.historicalMultiplier,
            toolCost: patch.toolCost,
            embeddedToolCosts: patch.embeddedToolCosts,
          })
          continue
        }

        await withReconcileDbRetry(
          async () => {
            await db
              .update(usageLog)
              .set({ metadata: nextMetadata })
              .where(eq(usageLog.id, primary.id))
          },
          {
            operation: 'backfillModelBreakdownMetadata',
            executionId: patch.executionId,
            usageLogId: primary.id,
          }
        )

        patched += 1
        results.push({
          executionId: patch.executionId,
          modelDescription: patch.modelDescription,
          status: 'patched',
          usageLogId: primary.id,
          historicalMultiplier: patch.historicalMultiplier,
          toolCost: patch.toolCost,
          embeddedToolCosts: patch.embeddedToolCosts,
        })
      } catch (error) {
        errors += 1
        results.push({
          executionId: patch.executionId,
          modelDescription: patch.modelDescription,
          status: 'error',
          reason: getErrorMessage(error, 'breakdown_backfill_failed'),
        })
        logger.warn('Failed to backfill model breakdown metadata', {
          executionId: patch.executionId,
          modelDescription: patch.modelDescription,
          error: getErrorMessage(error),
        })
      }
    }
  }

  return {
    dryRun,
    processed: records.length,
    patched,
    wouldPatch,
    skipped,
    errors,
    results,
    skips,
  }
}

/**
 * Evaluates rollout safety gates before applying a shadow artifact.
 * Production-wide apply requires `--confirm-production`; pilot scope is limited
 * to a workspace, execution, or small batch.
 */
export function evaluateApplyRolloutGates(params: {
  recordCount: number
  filter?: ApplyHistoricalReconciliationBatchFilter
  confirmProduction?: boolean
}): ApplyRolloutGateResult {
  const filter = params.filter ?? {}
  const blockers: string[] = []
  const warnings: string[] = []

  if (params.recordCount <= 0) {
    blockers.push('empty_artifact')
  }

  const hasPilotScope =
    Boolean(filter.workspaceId) ||
    Boolean(filter.executionId) ||
    (filter.limit != null &&
      filter.limit > 0 &&
      filter.limit <= HISTORICAL_RECONCILE_PILOT_MAX_RECORDS)

  const effectiveCount =
    filter.limit != null && filter.limit > 0
      ? Math.min(params.recordCount, filter.limit)
      : params.recordCount

  const phase: HistoricalReconcileRolloutPhase = hasPilotScope ? 'pilot' : 'production'

  if (phase === 'production' && !params.confirmProduction) {
    blockers.push('production_apply_requires_confirm_production')
  }

  if (phase === 'production' && effectiveCount > HISTORICAL_RECONCILE_PILOT_MAX_RECORDS) {
    warnings.push(`large_production_batch:${effectiveCount}`)
  }

  return {
    allowed: blockers.length === 0,
    phase,
    blockers,
    warnings,
  }
}

/**
 * Verifies ledger projection for executions after a gated apply batch.
 */
export async function verifyPostApplyReconciliation(
  executionIds: string[]
): Promise<PostApplyVerificationSummary> {
  const results: PostApplyVerificationResult[] = []

  for (const executionId of executionIds) {
    const evidence = await loadExecutionEvidence(executionId)
    if (!evidence) {
      results.push({
        executionId,
        passed: false,
        costTotal: null,
        ledgerSum: 0,
        drift: 0,
      })
      continue
    }

    const drift = (evidence.costTotal ?? 0) - evidence.ledgerSum
    results.push({
      executionId,
      passed: Math.abs(drift) <= RECONCILIATION_EPSILON,
      costTotal: evidence.costTotal,
      ledgerSum: evidence.ledgerSum,
      drift,
    })
  }

  const passed = results.filter((result) => result.passed).length

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  }
}
