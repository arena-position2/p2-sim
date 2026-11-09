#!/usr/bin/env bun
/**
 * Exact-only mothership/copilot usage_log.chat_id attribution repair CLI.
 *
 * Logic lives in apps/sim/lib/billing/core/mothership-chat-attribution-reconciliation.ts.
 *
 * Modes:
 *   --audit     Report populations (exact / fuzzy-unique / ambiguous / orphan / sha256)
 *   --dry-run   Paginate all exact matches; write NDJSON shadow artifact; apply nothing
 *   --apply     Apply exact event-key + existing-run-id + run-window-unique matches
 *   --verify    Snapshot cost invariants after an apply
 *   --rollback  Clear chat_id for ids recorded in a prior --apply NDJSON (--rollback-from=)
 *
 * Fuzzy time-window matches with >1 candidate are reported only — never applied.
 * Single-candidate run-window matches are treated as exact (`run-window-unique`).
 *
 * Usage:
 *   bun --env-file=apps/sim/.env run scripts/backfill-mothership-chat-attribution.ts --audit --workspace-id=ws_xxx
 *   bun --env-file=apps/sim/.env run scripts/backfill-mothership-chat-attribution.ts --dry-run --artifact=shadow.ndjson
 *   bun --env-file=apps/sim/.env run scripts/backfill-mothership-chat-attribution.ts --apply --artifact=apply.ndjson --workspace-id=ws_xxx
 *   bun --env-file=apps/sim/.env run scripts/backfill-mothership-chat-attribution.ts --verify --workspace-id=ws_xxx
 *   bun --env-file=apps/sim/.env run scripts/backfill-mothership-chat-attribution.ts --rollback --rollback-from=apply.ndjson
 */

import { getErrorMessage } from '@sim/utils/errors'
import {
  type MothershipChatAttributionScope,
  type ReconciliationMode,
  runMothershipChatAttributionReconciliation,
} from '../apps/sim/lib/billing/core/mothership-chat-attribution-reconciliation.ts'

const DEFAULT_BATCH_SIZE = 2000

interface CliOptions {
  mode: ReconciliationMode
  batchSize: number
  maxBatches: number
  workspaceId?: string
  sources?: string[]
  startAt?: Date
  endAt?: Date
  artifactPath?: string
  rollbackFrom?: string
}

function parseMode(argv: string[]): ReconciliationMode {
  if (argv.includes('--rollback')) return 'rollback'
  if (argv.includes('--apply')) return 'apply'
  if (argv.includes('--verify')) return 'verify'
  if (argv.includes('--audit')) return 'audit'
  if (argv.includes('--dry-run')) return 'dry-run'
  // Safe default: never mutate without an explicit mode.
  return 'dry-run'
}

function parseArgs(argv: string[]): CliOptions {
  const mode = parseMode(argv)
  const batchArg = argv.find((a) => a.startsWith('--batch-size='))
  const maxBatchesArg = argv.find((a) => a.startsWith('--max-batches='))
  const workspaceArg = argv.find((a) => a.startsWith('--workspace-id='))
  const sourcesArg = argv.find((a) => a.startsWith('--sources='))
  const startArg = argv.find((a) => a.startsWith('--start='))
  const endArg = argv.find((a) => a.startsWith('--end='))
  const artifactArg = argv.find((a) => a.startsWith('--artifact='))
  const rollbackFromArg = argv.find((a) => a.startsWith('--rollback-from='))

  if (argv.includes('--fuzzy')) {
    throw new Error(
      '--fuzzy apply is no longer supported. Fuzzy populations are reported in --audit/--dry-run only.'
    )
  }

  const batchSize = batchArg
    ? Number.parseInt(batchArg.split('=')[1] ?? '', 10)
    : DEFAULT_BATCH_SIZE
  const maxBatches = maxBatchesArg
    ? Number.parseInt(maxBatchesArg.split('=')[1] ?? '', 10)
    : Number.POSITIVE_INFINITY

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error('--batch-size must be a positive integer')
  }
  if (maxBatchesArg && (!Number.isFinite(maxBatches) || maxBatches <= 0)) {
    throw new Error('--max-batches must be a positive integer')
  }

  const startRaw = startArg?.split('=')[1]
  const endRaw = endArg?.split('=')[1]
  const startAt = startRaw ? new Date(startRaw) : undefined
  const endAt = endRaw ? new Date(endRaw) : undefined
  if (startAt && Number.isNaN(startAt.getTime())) {
    throw new Error('--start must be an ISO date')
  }
  if (endAt && Number.isNaN(endAt.getTime())) {
    throw new Error('--end must be an ISO date')
  }

  if (mode === 'rollback' && !rollbackFromArg) {
    throw new Error('--rollback requires --rollback-from=<apply-artifact.ndjson>')
  }

  return {
    mode,
    batchSize,
    maxBatches,
    workspaceId: workspaceArg?.split('=')[1]?.trim() || undefined,
    sources: sourcesArg
      ?.split('=')[1]
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    startAt,
    endAt,
    artifactPath: artifactArg?.split('=')[1]?.trim() || undefined,
    rollbackFrom: rollbackFromArg?.split('=')[1]?.trim() || undefined,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const scope: MothershipChatAttributionScope = {
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.sources?.length ? { sources: options.sources } : {}),
    ...(options.startAt ? { startAt: options.startAt } : {}),
    ...(options.endAt ? { endAt: options.endAt } : {}),
  }

  const result = await runMothershipChatAttributionReconciliation({
    mode: options.mode,
    scope: Object.keys(scope).length > 0 ? scope : undefined,
    batchSize: options.batchSize,
    maxBatches: options.maxBatches,
    artifactPath: options.artifactPath,
    rollbackFrom: options.rollbackFrom,
  })

  console.log(
    JSON.stringify(
      {
        mode: result.mode,
        applied: result.applied,
        wouldApply: result.wouldApply,
        populations: result.populations,
        costInvariantOk: result.costInvariantOk,
        beforeSumCost: result.beforeCosts.sumCost,
        afterSumCost: result.afterCosts?.sumCost,
        artifactPath: result.artifactPath,
      },
      null,
      2
    )
  )
}

try {
  await main()
} catch (error) {
  console.error('Backfill failed:', getErrorMessage(error))
  process.exit(1)
}
