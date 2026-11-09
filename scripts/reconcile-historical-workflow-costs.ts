#!/usr/bin/env bun
/**
 * Historical workflow cost reconciliation CLI.
 *
 * Modes:
 *   --audit                Classify executions by reconciliation evidence and risk (no writes)
 *   --repair-projections   Sync cost_total to workflow ledger sum (preview by default; --write to persist)
 *   --dry-run              Compute target ledger lines and export NDJSON shadow artifact
 *   --apply                Apply adjustments from a dry-run NDJSON artifact (gated rollout)
 *   --backfill-breakdowns  Patch model usage_log metadata with toolCost/embeddedToolCosts from a shadow artifact (preview by default; --write to persist). Does not change costs.
 *   --verify               Verify cost_total equals workflow ledger projection (post-apply gate)
 *   --rollout-guide        Print the recommended ops rollout sequence
 *
 * Usage:
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --rollout-guide
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --repair-projections --batch-size=1000
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --repair-projections --write --batch-size=1000
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --audit --since=2020-01-01 --batch-size=1000 --only-priced-tools
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --dry-run --since=2020-01-01 --batch-size=1000 --only-priced-tools --export=reconcile-shadow.ndjson --review-deltas
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --dry-run --since=2020-01-01 --export=reconcile-shadow.ndjson --resume
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --apply --input=reconcile-shadow.ndjson --batch-size=100 --only-priced-tools
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --apply --input=reconcile-shadow.ndjson --batch-size=500 --confirm-production --only-priced-tools
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --backfill-breakdowns --input=reconcile-shadow.ndjson
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --backfill-breakdowns --input=reconcile-shadow.ndjson --write --workspace-id=<id>
 *   bun --env-file=apps/sim/.env run scripts/reconcile-historical-workflow-costs.ts --verify --workspace-id=<id> --batch-size=1000
 *
 * Flags:
 *   --only-priced-tools  Gate to allowlisted hosted/LLM-on-tool tools (default on)
 *   --all-tools          Disable the priced-tool allowlist gate
 *   --write              Persist projection repairs or breakdown backfills (required to mutate)
 *   --resume             With --dry-run --export: keep the existing NDJSON artifact, skip executions
 *                        already in it, and append new records (crash-safe restart)
 *   --execution-timeout-ms=<n>
 *                        Fail one stalled audit/dry-run execution after this deadline (default 120000)
 *
 * Dry-run exports stream: each record is appended to the NDJSON artifact as soon as it is
 * computed, so an interrupted run keeps everything processed so far and can be continued
 * with --resume.
 *
 * Long-running modes (--audit / --dry-run / --verify / --repair-projections) keep the shared DB pool
 * healthy with per-page keepalives and up to 5 retries on CONNECTION_CLOSED /
 * other transient infrastructure errors.
 */
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs'
import {
  aggregateShadowDeltaReview,
  applyHistoricalReconciliationBatch,
  auditHistoricalWorkflowExecutions,
  backfillModelBreakdownMetadata,
  dryRunHistoricalWorkflowReprices,
  evaluateApplyRolloutGates,
  HISTORICAL_RECONCILE_DEFAULT_BATCH_SIZE,
  HISTORICAL_RECONCILE_DEFAULT_CONCURRENCY,
  HISTORICAL_RECONCILE_DEFAULT_EXECUTION_TIMEOUT_MS,
  HISTORICAL_RECONCILE_ROLLOUT_STEPS,
  type HistoricalReconcileProgress,
  type HistoricalReconcileShadowRecord,
  loadHistoricalReconcileShadowArtifact,
  type ReconciliationClass,
  type ReconciliationConfidence,
  repairLedgerProjections,
  resolveShadowArtifactWorkspaceScope,
  verifyLedgerProjection,
  verifyPostApplyReconciliation,
} from '../apps/sim/lib/billing/core/historical-workflow-reconciliation'

interface Options {
  audit: boolean
  dryRun: boolean
  apply: boolean
  verify: boolean
  repairProjections: boolean
  backfillBreakdowns: boolean
  write: boolean
  rolloutGuide: boolean
  reviewDeltas: boolean
  /** With --dry-run --export: keep the existing artifact, skip its executions, append new records. */
  resume: boolean
  confirmProduction: boolean
  verifyAfterApply: boolean
  /** When true (default), gate to priced-tool allowlist. Disable with `--all-tools`. */
  onlyPricedTools: boolean
  inputPath?: string
  workflowId?: string
  executionId?: string
  workspaceId?: string
  since?: Date
  until?: Date
  /** Optional total cap across all pages. */
  limit?: number
  /** Keyset page size. */
  batchSize: number
  /** Concurrent evidence loads within a page. */
  concurrency: number
  /** Maximum wall-clock time for one execution's evidence load and reprice. */
  executionTimeoutMs: number
  exportPath?: string
}

function parseDateArg(raw: string | undefined): Date | undefined {
  if (!raw) return undefined
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseArgs(argv: string[]): Options {
  const audit = argv.includes('--audit')
  const dryRun = argv.includes('--dry-run')
  const apply = argv.includes('--apply')
  const verify = argv.includes('--verify')
  const repairProjections = argv.includes('--repair-projections')
  const backfillBreakdowns = argv.includes('--backfill-breakdowns')
  const write = argv.includes('--write')
  const rolloutGuide = argv.includes('--rollout-guide')
  const reviewDeltas = argv.includes('--review-deltas')
  const resume = argv.includes('--resume')
  const confirmProduction = argv.includes('--confirm-production')
  const verifyAfterApply = argv.includes('--verify-after-apply')
  const allTools = argv.includes('--all-tools')
  // Default on for audit / dry-run / apply; `--all-tools` disables.
  const onlyPricedTools = !allTools
  const workflowId = argv.find((arg) => arg.startsWith('--workflow-id='))?.split('=')[1]
  const executionId = argv.find((arg) => arg.startsWith('--execution-id='))?.split('=')[1]
  const workspaceId = argv.find((arg) => arg.startsWith('--workspace-id='))?.split('=')[1]
  const since = parseDateArg(argv.find((arg) => arg.startsWith('--since='))?.split('=')[1])
  const until = parseDateArg(argv.find((arg) => arg.startsWith('--until='))?.split('=')[1])
  const limit = parsePositiveInt(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1])
  const batchSize =
    parsePositiveInt(argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1]) ??
    HISTORICAL_RECONCILE_DEFAULT_BATCH_SIZE
  const concurrency =
    parsePositiveInt(argv.find((arg) => arg.startsWith('--concurrency='))?.split('=')[1]) ??
    HISTORICAL_RECONCILE_DEFAULT_CONCURRENCY
  const executionTimeoutMs =
    parsePositiveInt(
      argv.find((arg) => arg.startsWith('--execution-timeout-ms='))?.split('=')[1]
    ) ?? HISTORICAL_RECONCILE_DEFAULT_EXECUTION_TIMEOUT_MS
  const exportPath = argv.find((arg) => arg.startsWith('--export='))?.split('=')[1]
  const inputPath = argv.find((arg) => arg.startsWith('--input='))?.split('=')[1]

  return {
    audit,
    dryRun,
    apply,
    verify,
    repairProjections,
    backfillBreakdowns,
    write,
    rolloutGuide,
    reviewDeltas,
    resume,
    confirmProduction,
    verifyAfterApply,
    onlyPricedTools,
    inputPath,
    workflowId,
    executionId,
    workspaceId,
    since,
    until,
    limit,
    batchSize,
    concurrency,
    executionTimeoutMs,
    exportPath,
  }
}

function formatClassCounts(byClass: Record<ReconciliationClass, number>): string {
  return Object.entries(byClass)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `  ${name.padEnd(28)} ${count}`)
    .join('\n')
}

function formatConfidenceCounts(byConfidence: Record<ReconciliationConfidence, number>): string {
  return Object.entries(byConfidence)
    .map(([name, count]) => `  ${name.padEnd(8)} ${count}`)
    .join('\n')
}

function printFilterSummary(options: Options, title: string): void {
  const window =
    options.since || options.until
      ? `${options.since?.toISOString() ?? '…'} → ${options.until?.toISOString() ?? '…'}`
      : 'all time'

  console.log(`\n=== ${title} (${window}) ===\n`)
  if (options.workflowId) console.log(`Workflow filter: ${options.workflowId}`)
  if (options.executionId) console.log(`Execution filter: ${options.executionId}`)
  if (options.workspaceId) console.log(`Workspace filter: ${options.workspaceId}`)
  console.log(`Batch size: ${options.batchSize}`)
  console.log(`Concurrency: ${options.concurrency}`)
  console.log(`Per-execution timeout: ${options.executionTimeoutMs}ms`)
  console.log(`Only priced tools: ${options.onlyPricedTools ? 'yes' : 'no (--all-tools)'}`)
  if (options.limit) console.log(`Limit: ${options.limit}`)
}

function printProgress(progress: HistoricalReconcileProgress): void {
  const suffix = progress.done ? ' (done)' : ''
  const resumed =
    progress.resumedSkipped && progress.resumedSkipped > 0
      ? ` resumed_skip=${progress.resumedSkipped}`
      : ''
  const active =
    progress.activeExecutions && progress.activeExecutions.length > 0
      ? ` active=${progress.activeExecutions
          .map(({ executionId, elapsedMs }) => `${executionId}(${Math.round(elapsedMs / 1000)}s)`)
          .join(',')}`
      : ''
  console.log(
    `[progress] ${new Date().toISOString()} attempted=${progress.attempted} succeeded=${progress.succeeded} skipped=${progress.skipped} failed=${progress.failed}${resumed} pages=${progress.pages}${active}${suffix}`
  )
}

function printRolloutGuide(): void {
  console.log('\n=== Historical Workflow Cost Reconciliation Rollout ===\n')
  for (const step of HISTORICAL_RECONCILE_ROLLOUT_STEPS) {
    console.log(`${step.step}. ${step.name}`)
    console.log(`   ${step.description}`)
    console.log(`   ${step.command}`)
    console.log('')
  }
}

function printDeltaReview(
  records: Awaited<ReturnType<typeof dryRunHistoricalWorkflowReprices>>['records']
): void {
  const review = aggregateShadowDeltaReview(records)

  console.log('\n--- Delta review totals ---')
  console.log(`Executions:            ${review.totals.executions}`)
  console.log(`Apply-eligible:        ${review.totals.applyEligible}`)
  console.log(`Candidate positive:    $${review.totals.positiveDelta.toFixed(6)}`)
  console.log(`Candidate negative:    $${review.totals.negativeDelta.toFixed(6)}`)
  console.log(`Eligible positive:     $${review.totals.eligiblePositiveDelta.toFixed(6)}`)
  console.log(`Eligible negative:     $${review.totals.eligibleNegativeDelta.toFixed(6)}`)
  console.log(`Out-of-scope positive: $${review.totals.outOfScopePositiveDelta.toFixed(6)}`)

  if (review.byWorkspace.length > 0) {
    console.log('\n--- Top apply-eligible workspaces by positive delta ---')
    for (const bucket of review.byWorkspace) {
      console.log(
        `  ${bucket.id} executions=${bucket.executions} positive=$${bucket.positiveDelta.toFixed(6)} negative=$${bucket.negativeDelta.toFixed(6)} apply=${bucket.applyEligible}`
      )
    }
  }

  if (review.byWorkflow.length > 0) {
    console.log('\n--- Top apply-eligible workflows by positive delta ---')
    for (const bucket of review.byWorkflow) {
      console.log(
        `  ${bucket.id} executions=${bucket.executions} positive=$${bucket.positiveDelta.toFixed(6)} negative=$${bucket.negativeDelta.toFixed(6)} apply=${bucket.applyEligible}`
      )
    }
  }

  if (review.byModel.length > 0) {
    console.log('\n--- Top apply-eligible models by positive delta ---')
    for (const bucket of review.byModel) {
      console.log(
        `  ${bucket.description} executions=${bucket.executions} positive=$${bucket.positiveDelta.toFixed(6)}`
      )
    }
  }

  if (review.byTool.length > 0) {
    console.log('\n--- Top apply-eligible tools by positive delta ---')
    for (const bucket of review.byTool) {
      console.log(
        `  ${bucket.description} executions=${bucket.executions} positive=$${bucket.positiveDelta.toFixed(6)}`
      )
    }
  }
}

function toFilter(options: Options) {
  return {
    workflowId: options.workflowId,
    executionId: options.executionId,
    workspaceId: options.workspaceId,
    since: options.since,
    until: options.until,
    limit: options.limit,
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    executionTimeoutMs: options.executionTimeoutMs,
    onlyPricedTools: options.onlyPricedTools,
  }
}

async function runDryRun(options: Options): Promise<number> {
  printFilterSummary(options, 'Historical Workflow Cost Shadow Reprice')
  if (options.exportPath) console.log(`Export: ${options.exportPath} (streaming append)`)

  const excludeExecutionIds = new Set<string>()
  let priorRecords: HistoricalReconcileShadowRecord[] = []
  let exportFd: number | undefined

  if (options.exportPath) {
    if (options.resume && existsSync(options.exportPath)) {
      priorRecords = await loadHistoricalReconcileShadowArtifact(options.exportPath)
      for (const record of priorRecords) {
        excludeExecutionIds.add(record.executionId)
      }
      console.log(
        `Resume: found ${priorRecords.length} record(s) in ${options.exportPath}; their executions will be skipped and new records appended.`
      )
      const existingText = readFileSync(options.exportPath, 'utf8')
      exportFd = openSync(options.exportPath, 'a')
      // Guard against a partial trailing line from a previously interrupted run.
      if (existingText.length > 0 && !existingText.endsWith('\n')) {
        writeSync(exportFd, '\n')
      }
    } else {
      exportFd = openSync(options.exportPath, 'w')
    }
  }

  let summary: Awaited<ReturnType<typeof dryRunHistoricalWorkflowReprices>>
  try {
    summary = await dryRunHistoricalWorkflowReprices(toFilter(options), {
      onProgress: printProgress,
      onlyPricedTools: options.onlyPricedTools,
      excludeExecutionIds: excludeExecutionIds.size > 0 ? excludeExecutionIds : undefined,
      onRecord:
        exportFd === undefined
          ? undefined
          : (record) => {
              writeSync(exportFd as number, `${JSON.stringify(record)}\n`)
            },
    })
  } finally {
    if (exportFd !== undefined) closeSync(exportFd)
  }

  console.log('--- Shadow reprice summary ---')
  console.log(`Attempted:             ${summary.attempted}`)
  console.log(`Succeeded:             ${summary.total}`)
  console.log(`Skipped:               ${summary.skipped}`)
  if (summary.resumedSkipped > 0) {
    console.log(`Resumed (in artifact): ${summary.resumedSkipped}`)
  }
  console.log(`Failed:                ${summary.failed}`)
  console.log(`With target lines:     ${summary.withTargets}`)
  console.log(`With positive delta:   ${summary.withPositiveDelta}`)
  console.log(`With negative delta:   ${summary.withNegativeDelta}`)
  console.log(`Total positive delta:  $${summary.totalPositiveDelta.toFixed(6)}`)
  console.log(`Total negative delta:  $${summary.totalNegativeDelta.toFixed(6)}`)

  if (summary.failures.length > 0) {
    console.log('\n--- Failures ---')
    for (const failure of summary.failures.slice(0, 20)) {
      console.log(
        `  ${failure.executionId} error=${failure.error}${failure.postgresCode ? ` pg=${failure.postgresCode}` : ''} cause=${failure.cause.message}`
      )
    }
    if (summary.failures.length > 20) {
      console.log(`  … and ${summary.failures.length - 20} more`)
    }
  }

  const allRecords =
    priorRecords.length > 0 ? [...priorRecords, ...summary.records] : summary.records

  if (options.reviewDeltas) {
    printDeltaReview(allRecords)
  }

  const topPositive = [...allRecords]
    .filter((record) => record.applyEligible && record.positiveDelta > 0)
    .sort((a, b) => b.positiveDelta - a.positiveDelta)
    .slice(0, 20)

  if (topPositive.length > 0) {
    console.log('\n--- Top apply-eligible positive delta examples ---')
    for (const record of topPositive) {
      const warningText = record.warnings.length > 0 ? ` warnings=${record.warnings.join(';')}` : ''
      console.log(
        `  ${record.executionId.slice(0, 8)}… class=${record.primaryClass} confidence=${record.confidence} positive=$${record.positiveDelta.toFixed(6)} negative=$${record.negativeDelta.toFixed(6)} ledger=$${record.ledgerSum.toFixed(6)} target=$${record.targetSum.toFixed(6)} apply=${record.applyEligible}${warningText}`
      )
    }
  }

  if (options.exportPath) {
    if (summary.failed > 0) {
      console.log(
        `\nWarning: run had ${summary.failed} failure(s); those executions are not in the artifact. Re-run with --resume to retry just the missing ones.`
      )
    }
    console.log(
      `\nExported shadow artifact: ${options.exportPath} (${summary.records.length} new, ${allRecords.length} total records)`
    )
  }

  return summary.failed > 0 ? 1 : 0
}

async function runAudit(options: Options): Promise<number> {
  printFilterSummary(options, 'Historical Workflow Cost Reconciliation Audit')

  const summary = await auditHistoricalWorkflowExecutions(toFilter(options), {
    onProgress: printProgress,
    onlyPricedTools: options.onlyPricedTools,
  })

  console.log('--- Reconciliation class counts ---')
  console.log(formatClassCounts(summary.byClass) || '  (none)')

  console.log('\n--- Confidence ---')
  console.log(formatConfidenceCounts(summary.byConfidence))

  console.log('\n--- Summary ---')
  console.log(`Attempted executions:  ${summary.attempted}`)
  console.log(`Classified executions: ${summary.total}`)
  console.log(`Skipped (no evidence): ${summary.skipped}`)
  console.log(`Failed:                ${summary.failed}`)
  console.log(`With projection drift: ${summary.withDrift}`)
  console.log(`Apply-eligible (v1):   ${summary.applyEligible}`)

  if (summary.failures.length > 0) {
    console.log('\n--- Failures ---')
    for (const failure of summary.failures.slice(0, 20)) {
      console.log(
        `  ${failure.executionId} error=${failure.error}${failure.postgresCode ? ` pg=${failure.postgresCode}` : ''} cause=${failure.cause.message}`
      )
    }
    if (summary.failures.length > 20) {
      console.log(`  … and ${summary.failures.length - 20} more`)
    }
  }

  if (summary.topRiskExamples.length > 0) {
    console.log('\n--- Top risk examples ---')
    for (const item of summary.topRiskExamples) {
      const secondary =
        item.secondaryClasses.length > 0 ? ` secondary=${item.secondaryClasses.join(',')}` : ''
      const warningText = item.warnings.length > 0 ? ` warnings=${item.warnings.join(';')}` : ''
      const blockerText = item.blockers.length > 0 ? ` blockers=${item.blockers.join(';')}` : ''
      console.log(
        `  ${item.executionId.slice(0, 8)}… class=${item.primaryClass} confidence=${item.confidence} drift=${item.drift.toFixed(6)} ledger=${item.ledgerSum.toFixed(6)} cost_total=${item.costTotal?.toFixed(6) ?? 'null'} apply=${item.applyEligible}${secondary}${warningText}${blockerText}`
      )
    }
  }

  if (options.exportPath) {
    if (summary.failed > 0) {
      console.log(
        `\nWarning: export includes ${summary.failed} failure(s); treat the artifact as incomplete until failures are resolved or excluded.`
      )
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      filters: {
        workflowId: options.workflowId ?? null,
        executionId: options.executionId ?? null,
        workspaceId: options.workspaceId ?? null,
        since: options.since?.toISOString() ?? null,
        until: options.until?.toISOString() ?? null,
        limit: options.limit ?? null,
        batchSize: options.batchSize,
        concurrency: options.concurrency,
        executionTimeoutMs: options.executionTimeoutMs,
        onlyPricedTools: options.onlyPricedTools,
      },
      summary: {
        total: summary.total,
        attempted: summary.attempted,
        skipped: summary.skipped,
        failed: summary.failed,
        byClass: summary.byClass,
        byConfidence: summary.byConfidence,
        applyEligible: summary.applyEligible,
        withDrift: summary.withDrift,
      },
      failures: summary.failures,
      classifications: summary.classifications,
    }

    await Bun.write(options.exportPath, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(`\nExported classification artifact: ${options.exportPath}`)
  }

  return summary.failed > 0 ? 1 : 0
}

async function runRepairProjections(options: Options): Promise<number> {
  const dryRun = !options.write
  printFilterSummary(
    options,
    dryRun
      ? 'Historical Ledger Projection Repair (dry-run)'
      : 'Historical Ledger Projection Repair (write)'
  )
  console.log(
    `Mode: ${dryRun ? 'dry-run (pass --write to persist)' : 'WRITE — updating cost_total only'}`
  )
  console.log('Note: does not insert/delete/reprice usage_log rows.\n')

  const result = await repairLedgerProjections(toFilter(options), {
    dryRun,
    onProgress: printProgress,
  })

  console.log('\n--- Projection repair summary ---')
  console.log(`Scanned:   ${result.scanned}`)
  console.log(`Drifted:   ${result.drifted}`)
  console.log(`Repaired:  ${result.repaired}${dryRun ? ' (dry-run — 0 writes)' : ''}`)
  console.log(`Failed:    ${result.failed}`)
  console.log(`Pages:     ${result.pages}`)

  if (result.examples.length > 0) {
    console.log('\n--- Examples (cost_total → ledger) ---')
    for (const item of result.examples) {
      console.log(
        `  ${item.executionId.slice(0, 8)}… ${item.costTotal?.toFixed(6) ?? 'null'} → ${item.costTotalAfter.toFixed(6)} (ledger=${item.ledgerSum.toFixed(6)} drift=${item.drift.toFixed(6)}) workspace=${item.workspaceId}`
      )
    }
    if (result.drifted > result.examples.length) {
      console.log(`  … and ${result.drifted - result.examples.length} more`)
    }
  }

  if (result.failures.length > 0) {
    console.log('\n--- Failures ---')
    for (const failure of result.failures.slice(0, 20)) {
      console.log(`  ${failure.executionId} ${failure.error}`)
    }
  }

  if (dryRun && result.drifted > 0) {
    console.log(
      `\nPreview only. Re-run with --write to set cost_total for ${result.drifted} execution(s).`
    )
  }

  return result.failed > 0 ? 1 : 0
}

async function runVerify(options: Options): Promise<number> {
  printFilterSummary(options, 'Historical Workflow Ledger Projection Verification')

  const verification = await verifyLedgerProjection(toFilter(options))

  console.log('--- Verification summary ---')
  console.log(`Sampled executions: ${verification.total}`)
  console.log(`Drifted:            ${verification.drifted}`)
  console.log(`Passed:             ${verification.passed ? 'yes' : 'no'}`)

  if (verification.driftExamples.length > 0) {
    console.log('\n--- Drift examples ---')
    for (const item of verification.driftExamples) {
      console.log(
        `  ${item.executionId.slice(0, 8)}… drift=${item.drift.toFixed(6)} cost_total=${item.costTotal?.toFixed(6) ?? 'null'} ledger=${item.ledgerSum.toFixed(6)} workspace=${item.workspaceId}`
      )
    }
  }

  return verification.passed ? 0 : 1
}

async function runApply(options: Options): Promise<number> {
  if (!options.inputPath) {
    throw new Error('--apply requires --input=<shadow-artifact.ndjson>')
  }

  console.log('\n=== Historical Workflow Cost Reconciliation Apply ===\n')
  console.log(`Input artifact: ${options.inputPath}`)
  if (options.workflowId) console.log(`Workflow filter: ${options.workflowId}`)
  if (options.executionId) console.log(`Execution filter: ${options.executionId}`)
  if (options.limit) console.log(`Limit: ${options.limit}`)
  console.log(`Batch size: ${options.batchSize}`)
  console.log(`Only priced tools: ${options.onlyPricedTools ? 'yes' : 'no (--all-tools)'}`)

  const records = await loadHistoricalReconcileShadowArtifact(options.inputPath)
  console.log(`Loaded ${records.length} shadow record(s) from artifact`)

  const artifactScope = resolveShadowArtifactWorkspaceScope(records)
  const workspaceId = options.workspaceId ?? artifactScope.singleWorkspaceId

  if (options.workspaceId) {
    console.log(`Workspace filter: ${options.workspaceId} (CLI)`)
  } else if (artifactScope.singleWorkspaceId) {
    console.log(`Workspace scope: ${artifactScope.singleWorkspaceId} (from artifact)`)
  } else if (artifactScope.workspaceIds.length > 1) {
    console.log(
      `Workspace scope: ${artifactScope.workspaceIds.length} workspaces in artifact (unfiltered; use --workspace-id to narrow)`
    )
  }

  const gate = evaluateApplyRolloutGates({
    recordCount: records.length,
    filter: {
      workflowId: options.workflowId,
      executionId: options.executionId,
      workspaceId,
      limit: options.limit ?? options.batchSize,
    },
    confirmProduction: options.confirmProduction,
  })

  console.log(`\n--- Rollout gate (${gate.phase}) ---`)
  console.log(`Allowed: ${gate.allowed ? 'yes' : 'no'}`)
  if (gate.warnings.length > 0) {
    console.log(`Warnings: ${gate.warnings.join(', ')}`)
  }
  if (gate.blockers.length > 0) {
    console.log(`Blockers: ${gate.blockers.join(', ')}`)
    console.log('\nRun with --rollout-guide for the recommended pilot → production sequence.')
    return 1
  }

  const batch = await applyHistoricalReconciliationBatch({
    records,
    filter: {
      workflowId: options.workflowId,
      executionId: options.executionId,
      workspaceId,
      limit: options.limit ?? options.batchSize,
      onlyPricedTools: options.onlyPricedTools,
    },
  })

  console.log('\n--- Apply summary ---')
  console.log(`Processed:              ${batch.processed}`)
  console.log(`Applied (new rows):     ${batch.applied}`)
  console.log(`Unchanged (idempotent): ${batch.unchanged}`)
  console.log(`Skipped:                ${batch.skipped}`)
  console.log(`Errors:                 ${batch.errors}`)
  console.log(`Positive delta applied: $${batch.totalPositiveDeltaApplied.toFixed(6)}`)
  console.log(`Negative delta skipped: $${batch.totalNegativeDeltaSkipped.toFixed(6)}`)

  const skippedReasons = new Map<string, number>()
  for (const result of batch.results) {
    if (result.status !== 'skipped') continue
    const reason = result.reason ?? 'unspecified'
    skippedReasons.set(reason, (skippedReasons.get(reason) ?? 0) + 1)
  }
  if (skippedReasons.size > 0) {
    console.log('\n--- Skipped reasons ---')
    for (const [reason, count] of skippedReasons) {
      console.log(`  ${reason}: ${count}`)
    }
  }

  const notable = batch.results.filter(
    (result) => result.status === 'applied' || result.status === 'error'
  )
  if (notable.length > 0) {
    console.log('\n--- Applied / error details ---')
    for (const result of notable.slice(0, 50)) {
      console.log(
        `  ${result.executionId.slice(0, 8)}… status=${result.status} entries=${result.entriesInserted} delta=$${result.positiveDeltaApplied.toFixed(6)} ledger=${result.ledgerSumBefore.toFixed(6)}→${result.ledgerSumAfter.toFixed(6)} cost_total=${result.costTotalBefore?.toFixed(6) ?? 'null'}→${result.costTotalAfter.toFixed(6)}${result.reason ? ` reason=${result.reason}` : ''}`
      )
    }
    if (notable.length > 50) {
      console.log(`  … and ${notable.length - 50} more`)
    }
  }

  if (options.verifyAfterApply || batch.applied > 0) {
    const executionIds = batch.results
      .filter((result) => result.status === 'applied' || result.status === 'unchanged')
      .map((result) => result.executionId)

    if (executionIds.length > 0) {
      const postApply = await verifyPostApplyReconciliation(executionIds)
      console.log('\n--- Post-apply verification ---')
      console.log(`Checked: ${postApply.total}`)
      console.log(`Passed:  ${postApply.passed}`)
      console.log(`Failed:  ${postApply.failed}`)

      if (postApply.failed > 0) {
        for (const result of postApply.results.filter((item) => !item.passed).slice(0, 20)) {
          console.log(
            `  ${result.executionId.slice(0, 8)}… drift=${result.drift.toFixed(6)} cost_total=${result.costTotal?.toFixed(6) ?? 'null'} ledger=${result.ledgerSum.toFixed(6)}`
          )
        }
        return 1
      }
    }
  }

  return batch.errors > 0 ? 1 : 0
}

async function runBackfillBreakdowns(options: Options): Promise<number> {
  if (!options.inputPath) {
    throw new Error('--backfill-breakdowns requires --input=<shadow-artifact.ndjson>')
  }

  const dryRun = !options.write
  printFilterSummary(
    options,
    dryRun
      ? 'Historical Model Breakdown Backfill (dry-run)'
      : 'Historical Model Breakdown Backfill (write)'
  )
  console.log(`Input artifact: ${options.inputPath}`)
  console.log(
    `Mode: ${
      dryRun
        ? 'dry-run (pass --write to persist metadata only)'
        : 'WRITE — patching usage_log.metadata only (costs unchanged)'
    }\n`
  )

  const loaded = await loadHistoricalReconcileShadowArtifact(options.inputPath)
  let records = loaded

  if (options.workspaceId) {
    records = records.filter((record) => record.workspaceId === options.workspaceId)
  }
  if (options.executionId) {
    records = records.filter((record) => record.executionId === options.executionId)
  }
  if (options.workflowId) {
    records = records.filter((record) => record.workflowId === options.workflowId)
  }
  if (options.limit != null && options.limit > 0) {
    records = records.slice(0, options.limit)
  }

  console.log(`Loaded ${loaded.length} shadow record(s); scoped to ${records.length}`)

  const result = await backfillModelBreakdownMetadata(records, { dryRun })

  console.log('\n--- Breakdown backfill summary ---')
  console.log(`Processed executions: ${result.processed}`)
  console.log(`Would patch:          ${result.wouldPatch}`)
  console.log(`Patched:              ${result.patched}${dryRun ? ' (dry-run — 0 writes)' : ''}`)
  console.log(`Skipped:              ${result.skipped}`)
  console.log(`Errors:               ${result.errors}`)

  const actionable = result.results.filter(
    (item) => item.status === 'would_patch' || item.status === 'patched'
  )
  if (actionable.length > 0) {
    console.log('\n--- Patches ---')
    for (const item of actionable.slice(0, 30)) {
      const tools = item.embeddedToolCosts
        ? Object.entries(item.embeddedToolCosts)
            .map(([name, cost]) => `${name}=$${cost.toFixed(6)}`)
            .join(', ')
        : ''
      console.log(
        `  ${item.executionId.slice(0, 8)}… model=${item.modelDescription} toolCost=$${
          item.toolCost?.toFixed(6) ?? '0'
        } [${tools}] status=${item.status}`
      )
    }
    if (actionable.length > 30) {
      console.log(`  … and ${actionable.length - 30} more`)
    }
  }

  const skipCounts = new Map<string, number>()
  for (const skip of result.skips) {
    skipCounts.set(skip.reason, (skipCounts.get(skip.reason) ?? 0) + 1)
  }
  if (skipCounts.size > 0) {
    console.log('\n--- Skip reasons ---')
    for (const [reason, count] of [...skipCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count}`)
    }
  }

  if (dryRun && result.wouldPatch > 0) {
    console.log(
      `\nPreview only. Re-run with --write to patch metadata on ${result.wouldPatch} model row(s).`
    )
  }

  return result.errors > 0 ? 1 : 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.rolloutGuide) {
    printRolloutGuide()
    process.exit(0)
  }

  const modeCount = [
    options.audit,
    options.dryRun,
    options.apply,
    options.verify,
    options.repairProjections,
    options.backfillBreakdowns,
  ].filter(Boolean).length
  if (modeCount > 1) {
    console.error(
      'Use only one mode: --audit, --repair-projections, --dry-run, --apply, --backfill-breakdowns, or --verify'
    )
    process.exit(1)
  }

  if (
    !options.audit &&
    !options.dryRun &&
    !options.apply &&
    !options.verify &&
    !options.repairProjections &&
    !options.backfillBreakdowns
  ) {
    console.error(
      'No mode selected. Supported: --audit, --repair-projections, --dry-run, --apply, --backfill-breakdowns, --verify, --rollout-guide'
    )
    process.exit(1)
  }

  if (options.write && !options.repairProjections && !options.backfillBreakdowns) {
    console.error('--write is only valid with --repair-projections or --backfill-breakdowns')
    process.exit(1)
  }

  if (options.resume && !(options.dryRun && options.exportPath)) {
    console.error('--resume is only valid with --dry-run --export=<path>')
    process.exit(1)
  }

  let exitCode = 0

  if (options.audit) {
    exitCode = await runAudit(options)
  } else if (options.repairProjections) {
    exitCode = await runRepairProjections(options)
  } else if (options.backfillBreakdowns) {
    exitCode = await runBackfillBreakdowns(options)
  } else if (options.dryRun) {
    exitCode = await runDryRun(options)
  } else if (options.verify) {
    exitCode = await runVerify(options)
  } else {
    exitCode = await runApply(options)
  }

  process.exit(exitCode)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
