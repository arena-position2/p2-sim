#!/usr/bin/env bun
/**
 * Compare `apps/sim/config/vendor-pricing.json` against canonical Sim pricing
 * in `apps/sim/providers/models.ts` and billing constants.
 *
 * Usage:
 *   bun run vendor-pricing:check          # report drift, exit 1 if any
 *   bun run vendor-pricing:sync           # update syncable rows from models.ts
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_EXECUTION_CHARGE } from '../apps/sim/lib/billing/constants.ts'
import {
  EMBEDDING_MODEL_PRICING,
  PROVIDER_DEFINITIONS,
  RERANK_MODEL_PRICING,
} from '../apps/sim/providers/models.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const PRICING_PATH = resolve(ROOT, 'apps/sim/config/vendor-pricing.json')

const RATE_EPSILON = 1e-9

interface VendorPricingRow {
  vendor: string
  tool: string
  cost: number | string
}

interface VendorPricingFile {
  pricing: VendorPricingRow[]
}

interface ModelRates {
  input: number
  output: number
}

function findProviderModelPricing(modelId: string): ModelRates | null {
  for (const provider of Object.values(PROVIDER_DEFINITIONS)) {
    for (const model of provider.models) {
      if (model.id === modelId) {
        return {
          input: model.pricing.input,
          output: model.pricing.output,
        }
      }
    }
  }

  const embedding = EMBEDDING_MODEL_PRICING[modelId]
  if (embedding) {
    return { input: embedding.input, output: embedding.output }
  }

  return null
}

function findRerankUsdPerUnit(modelId: string): number | null {
  return RERANK_MODEL_PRICING[modelId]?.perSearchUnit ?? null
}

function parseTokenCost(cost: number | string): ModelRates | null {
  if (typeof cost !== 'string' || !cost.includes('/')) return null
  const [inputRaw, outputRaw] = cost.split('/')
  const input = Number(inputRaw)
  const output = Number(outputRaw)
  if (Number.isNaN(input) || Number.isNaN(output)) return null
  return { input, output }
}

function formatTokenCost(rates: ModelRates): string {
  return `${rates.input}/${rates.output}`
}

function ratesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= RATE_EPSILON
}

function tokenCostsEqual(left: number | string, right: string): boolean {
  const parsed = parseTokenCost(left)
  const canonical = parseTokenCost(right)
  if (!parsed || !canonical) return false
  return ratesEqual(parsed.input, canonical.input) && ratesEqual(parsed.output, canonical.output)
}

function resolveCanonicalCost(row: VendorPricingRow): number | string | null {
  if (row.vendor === 'Sim' && row.tool === 'every-workflow-run') {
    return BASE_EXECUTION_CHARGE
  }

  const rerank = findRerankUsdPerUnit(row.tool)
  if (rerank != null) return rerank

  const modelRates = findProviderModelPricing(row.tool)
  if (modelRates) return formatTokenCost(modelRates)

  return null
}

function formatDrift(
  row: VendorPricingRow,
  jsonValue: number | string,
  canonical: number | string
): string {
  return `  - ${row.vendor}/${row.tool}: json=${jsonValue} canonical=${canonical}`
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check')
  const write = process.argv.includes('--write')

  if (checkOnly && write) {
    console.error('Use either --check or --write, not both.')
    process.exit(1)
  }

  const raw = await readFile(PRICING_PATH, 'utf8')
  const pricing = JSON.parse(raw) as VendorPricingFile

  const drifts: string[] = []
  let updated = 0

  for (const row of pricing.pricing) {
    const canonical = resolveCanonicalCost(row)
    if (canonical == null) continue

    if (typeof canonical === 'number') {
      if (typeof row.cost !== 'number' || !ratesEqual(row.cost, canonical)) {
        drifts.push(formatDrift(row, row.cost, canonical))
        if (write) {
          row.cost = canonical
          updated++
        }
      }
      continue
    }

    if (!tokenCostsEqual(row.cost, canonical)) {
      drifts.push(formatDrift(row, row.cost, canonical))
      if (write) {
        row.cost = canonical
        updated++
      }
    }
  }

  if (write && updated > 0) {
    await writeFile(PRICING_PATH, `${JSON.stringify(pricing, null, 2)}\n`, 'utf8')
    console.log(`Updated ${updated} row(s) in ${PRICING_PATH}`)
  }

  if (drifts.length === 0) {
    console.log('vendor-pricing.json is in sync with models.ts for tracked rows.')
    return
  }

  console.log(`Pricing drift detected (${drifts.length}):`)
  for (const line of drifts) console.log(line)

  if (!write) {
    console.log('\nRun `bun run vendor-pricing:sync` to update syncable rows from models.ts.')
  }

  if (checkOnly || (!write && drifts.length > 0)) {
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
