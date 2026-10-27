#!/usr/bin/env bun

/**
 * Dumps and diffs the output paths workflows can reference.
 *
 * Saved workflows store `<BlockName.field>` against the object a block, tool,
 * or trigger returns. A clean merge can rename or drop that field in a file
 * this fork never edited. This command compares the contract on two trees so
 * those breaks show up before a workflow runs.
 *
 * Usage:
 *   bun run apps/sim/scripts/diff-block-output-contracts.ts dump [--out file]
 *   bun run apps/sim/scripts/diff-block-output-contracts.ts diff <before.json> [after.json] [--json] [--verbose]
 *
 * `dump` writes the current tree. `diff` compares a dump from the pre-sync
 * product branch with a second dump, or with the current tree when the second
 * path is omitted. Exit code 1 means a path was removed or its type changed.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { USER_FILE_ACCESSIBLE_PROPERTIES, USER_FILE_PROPERTY_TYPES } from '@/lib/workflows/types'

export const OUTPUT_CONTRACT_DUMP_VERSION = 1 as const

export type OutputContractSource = 'block' | 'tool' | 'trigger'

export interface OutputContractRow {
  blockType: string
  operation: string
  path: string
  type: string
  source: OutputContractSource
  hidden: boolean
}

export interface OutputContractDump {
  version: typeof OUTPUT_CONTRACT_DUMP_VERSION
  rows: OutputContractRow[]
}

export interface OutputContractTypeChange {
  before: OutputContractRow
  after: OutputContractRow
}

export interface OutputContractRenameCandidate {
  removed: OutputContractRow
  added: OutputContractRow[]
}

export interface OutputContractDiff {
  removed: OutputContractRow[]
  typeChanged: OutputContractTypeChange[]
  added: OutputContractRow[]
  renameCandidates: OutputContractRenameCandidate[]
}

interface ContractSubBlock {
  id: string
  options?:
    | Array<{ id: string }>
    | ((params?: { values: Record<string, unknown> }) => Array<{ id: string }>)
}

export interface ContractBlock {
  type: string
  subBlocks: ContractSubBlock[]
  canvasPresentation?: { operationSubBlockId?: string }
  triggers?: { enabled: boolean; available: string[] }
}

interface SubBlockValue {
  value?: unknown
}

type SubBlockValues = Record<string, SubBlockValue>

interface OutputReaders {
  blockOutputs: (
    blockType: string,
    subBlocks: SubBlockValues,
    triggerMode: boolean
  ) => Record<string, unknown>
  toolOutputs: (block: ContractBlock, subBlocks: SubBlockValues) => Record<string, unknown>
}

const SOURCES: readonly OutputContractSource[] = ['block', 'tool', 'trigger']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rowKey(
  row: Pick<OutputContractRow, 'blockType' | 'operation' | 'source' | 'path'>
): string {
  return [row.blockType, row.operation, row.source, row.path].join('\t')
}

function compareRows(a: OutputContractRow, b: OutputContractRow): number {
  return (
    a.blockType.localeCompare(b.blockType) ||
    a.operation.localeCompare(b.operation) ||
    a.source.localeCompare(b.source) ||
    a.path.localeCompare(b.path)
  )
}

function fieldType(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.type === 'string') return value.type
  if (isRecord(value)) return 'object'
  return null
}

function isHidden(value: unknown): boolean {
  return isRecord(value) && value.hiddenFromDisplay === true
}

function nestedFields(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if ((value.type === 'object' || value.type === 'json') && isRecord(value.properties)) {
    return value.properties
  }
  if (value.type === 'array' && isRecord(value.items)) {
    if (isRecord(value.items.properties)) return value.items.properties
    if (typeof value.items.type !== 'string') return value.items
  }
  return null
}

/**
 * Flattens an output schema into path and type rows.
 *
 * File outputs also list the properties the editor lets a workflow reference
 * (`url`, `name`, and the rest of `USER_FILE_ACCESSIBLE_PROPERTIES`).
 */
export function flattenOutputSchema(
  schema: Record<string, unknown>,
  into: Map<string, { type: string; hidden: boolean }> = new Map(),
  prefix = '',
  hidden = false
): Map<string, { type: string; hidden: boolean }> {
  for (const [key, value] of Object.entries(schema)) {
    const type = fieldType(value)
    if (type === null) continue
    const path = prefix ? `${prefix}.${key}` : key
    const fieldHidden = hidden || isHidden(value)
    if (!into.has(path)) into.set(path, { type, hidden: fieldHidden })

    if (type === 'file' || type === 'file[]') {
      for (const property of USER_FILE_ACCESSIBLE_PROPERTIES) {
        const propertyPath = `${path}.${property}`
        if (!into.has(propertyPath)) {
          into.set(propertyPath, {
            type: USER_FILE_PROPERTY_TYPES[property],
            hidden: fieldHidden,
          })
        }
      }
    }

    const nested = nestedFields(value)
    if (nested) {
      flattenOutputSchema(nested, into, path, fieldHidden)
      continue
    }

    if (isRecord(value) && typeof value.type !== 'string') {
      flattenOutputSchema(value, into, path, fieldHidden)
    }
  }

  return into
}

function operationSubBlockId(block: ContractBlock): string | null {
  const declared = block.canvasPresentation?.operationSubBlockId
  if (declared) return declared
  return block.subBlocks.some((subBlock) => subBlock.id === 'operation') ? 'operation' : null
}

function operationIds(block: ContractBlock): string[] {
  const subBlockId = operationSubBlockId(block)
  if (!subBlockId) return ['']
  const subBlock = block.subBlocks.find((candidate) => candidate.id === subBlockId)
  if (!subBlock?.options) return ['']

  let options: Array<{ id: string }>
  try {
    options =
      typeof subBlock.options === 'function' ? subBlock.options({ values: {} }) : subBlock.options
  } catch {
    return ['']
  }

  const ids = options.map((option) => option.id).filter((id) => id.length > 0)
  return ids.length > 0 ? ids : ['']
}

function addSchemaRows(
  rows: Map<string, OutputContractRow>,
  blockType: string,
  operation: string,
  source: OutputContractSource,
  schema: Record<string, unknown>
): void {
  for (const [path, field] of flattenOutputSchema(schema)) {
    const row: OutputContractRow = {
      blockType,
      operation,
      path,
      type: field.type,
      source,
      hidden: field.hidden,
    }
    const key = rowKey(row)
    if (!rows.has(key)) rows.set(key, row)
  }
}

/**
 * Collects referenceable output paths for one block.
 *
 * Action operations are recorded from the block schema and from the tool the
 * operation selects. Each enabled trigger is recorded separately.
 */
export function collectBlockOutputContracts(
  block: ContractBlock,
  readers: OutputReaders
): OutputContractRow[] {
  const rows = new Map<string, OutputContractRow>()

  for (const operation of operationIds(block)) {
    const operationField = operationSubBlockId(block) ?? 'operation'
    const subBlocks: SubBlockValues = operation ? { [operationField]: { value: operation } } : {}
    addSchemaRows(
      rows,
      block.type,
      operation,
      'block',
      readers.blockOutputs(block.type, subBlocks, false)
    )
    addSchemaRows(rows, block.type, operation, 'tool', readers.toolOutputs(block, subBlocks))
  }

  if (block.triggers?.enabled) {
    for (const triggerId of block.triggers.available) {
      const subBlocks: SubBlockValues = {
        selectedTriggerId: { value: triggerId },
        triggerId: { value: triggerId },
      }
      addSchemaRows(
        rows,
        block.type,
        `trigger:${triggerId}`,
        'trigger',
        readers.blockOutputs(block.type, subBlocks, true)
      )
    }
  }

  return [...rows.values()].sort(compareRows)
}

function leaf(path: string): string {
  const parts = path.split('.')
  return parts[parts.length - 1] ?? path
}

/**
 * Diffs two dumps. Added paths are safe. Removed paths and type changes break
 * saved references. A removed path and an added path that share a leaf name on
 * the same block, operation, and source are a rename candidate.
 */
export function diffOutputContracts(
  before: OutputContractDump,
  after: OutputContractDump
): OutputContractDiff {
  const beforeRows = new Map(before.rows.map((row) => [rowKey(row), row]))
  const afterRows = new Map(after.rows.map((row) => [rowKey(row), row]))

  const removed: OutputContractRow[] = []
  const typeChanged: OutputContractTypeChange[] = []
  const added: OutputContractRow[] = []

  for (const [key, row] of beforeRows) {
    const next = afterRows.get(key)
    if (!next) {
      removed.push(row)
      continue
    }
    if (next.type !== row.type) typeChanged.push({ before: row, after: next })
  }

  for (const [key, row] of afterRows) {
    if (!beforeRows.has(key)) added.push(row)
  }

  removed.sort(compareRows)
  added.sort(compareRows)
  typeChanged.sort((a, b) => compareRows(a.before, b.before))

  const addedByScope = new Map<string, OutputContractRow[]>()
  for (const row of added) {
    const scope = `${row.blockType}\t${row.operation}\t${row.source}\t${leaf(row.path)}`
    const group = addedByScope.get(scope)
    if (group) group.push(row)
    else addedByScope.set(scope, [row])
  }

  const renameCandidates: OutputContractRenameCandidate[] = []
  for (const row of removed) {
    const scope = `${row.blockType}\t${row.operation}\t${row.source}\t${leaf(row.path)}`
    const matches = (addedByScope.get(scope) ?? []).filter(
      (candidate) => candidate.path !== row.path
    )
    if (matches.length > 0) renameCandidates.push({ removed: row, added: matches })
  }

  return { removed, typeChanged, added, renameCandidates }
}

export function parseOutputContractDump(value: unknown): OutputContractDump {
  if (
    !isRecord(value) ||
    value.version !== OUTPUT_CONTRACT_DUMP_VERSION ||
    !Array.isArray(value.rows)
  ) {
    throw new Error(`Output contract dump must be version ${OUTPUT_CONTRACT_DUMP_VERSION}`)
  }

  const rows: OutputContractRow[] = []
  for (const row of value.rows) {
    if (!isRecord(row)) throw new Error('Output contract row must be an object')
    const { blockType, operation, path, type, source, hidden } = row
    if (
      typeof blockType !== 'string' ||
      typeof operation !== 'string' ||
      typeof path !== 'string' ||
      typeof type !== 'string' ||
      typeof hidden !== 'boolean' ||
      typeof source !== 'string' ||
      !SOURCES.includes(source as OutputContractSource)
    ) {
      throw new Error(
        'Output contract row is missing blockType, operation, path, type, source, or hidden'
      )
    }
    rows.push({
      blockType,
      operation,
      path,
      type,
      source: source as OutputContractSource,
      hidden,
    })
  }

  return { version: OUTPUT_CONTRACT_DUMP_VERSION, rows }
}

function readDump(path: string): OutputContractDump {
  return parseOutputContractDump(JSON.parse(readFileSync(path, 'utf8')))
}

function formatRow(row: OutputContractRow): string {
  return `${row.blockType} ${row.operation || '(default)'} ${row.source} ${row.path} (${row.type})`
}

function formatDiff(diff: OutputContractDiff, verbose: boolean): string {
  const lines = [
    'Output contract diff',
    `Removed: ${diff.removed.length}`,
    `Type changed: ${diff.typeChanged.length}`,
    `Added: ${diff.added.length}`,
    `Rename candidates: ${diff.renameCandidates.length}`,
  ]

  if (diff.removed.length > 0) {
    lines.push('', 'Removed')
    for (const row of diff.removed) lines.push(`  ${formatRow(row)}`)
  }

  if (diff.typeChanged.length > 0) {
    lines.push('', 'Type changed')
    for (const change of diff.typeChanged) {
      lines.push(`  ${formatRow(change.before)} -> ${change.after.type}`)
    }
  }

  if (diff.renameCandidates.length > 0) {
    lines.push('', 'Rename candidates')
    for (const candidate of diff.renameCandidates) {
      const targets = candidate.added.map((row) => row.path).join(', ')
      lines.push(`  ${formatRow(candidate.removed)} -> ${targets}`)
    }
  }

  if (verbose && diff.added.length > 0) {
    lines.push('', 'Added')
    for (const row of diff.added) lines.push(`  ${formatRow(row)}`)
  }

  return lines.join('\n')
}

async function collectCurrentDump(): Promise<OutputContractDump> {
  const { getBlockRegistry } = await import('@/blocks/registry')
  const { getBlockOutputs, getToolOutputs } = await import('@/lib/workflows/blocks/block-outputs')
  const rows: OutputContractRow[] = []

  for (const block of Object.values(getBlockRegistry())) {
    try {
      rows.push(
        ...collectBlockOutputContracts(block, {
          blockOutputs: (blockType, subBlocks, triggerMode) =>
            getBlockOutputs(blockType, subBlocks, triggerMode, { includeHidden: true }),
          toolOutputs: (_block, subBlocks) =>
            getToolOutputs(block, subBlocks, { includeHidden: true }),
        })
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`Skipped ${block.type}: ${message}\n`)
    }
  }

  rows.sort(compareRows)
  return { version: OUTPUT_CONTRACT_DUMP_VERSION, rows }
}

function printUsage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  bun run apps/sim/scripts/diff-block-output-contracts.ts dump [--out file]',
      '  bun run apps/sim/scripts/diff-block-output-contracts.ts diff <before.json> [after.json] [--json] [--verbose]',
      '',
    ].join('\n')
  )
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const flags = new Set(args.filter((arg) => arg.startsWith('--')))
  const positionals = args.slice(1).filter((arg) => !arg.startsWith('--'))
  const outFlag = args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length)
  const outIndex = args.indexOf('--out')
  const outPath = outFlag ?? (outIndex >= 0 ? args[outIndex + 1] : undefined)

  if (command === 'dump') {
    const dump = await collectCurrentDump()
    const json = JSON.stringify(dump)
    if (outPath) {
      writeFileSync(outPath, json)
      process.stderr.write(`Wrote ${dump.rows.length} rows to ${outPath}\n`)
      return
    }
    process.stdout.write(`${json}\n`)
    return
  }

  if (command === 'diff') {
    const beforePath = positionals[0]
    if (!beforePath) {
      printUsage()
      process.exitCode = 2
      return
    }
    const before = readDump(beforePath)
    const after = positionals[1] ? readDump(positionals[1]) : await collectCurrentDump()
    const diff = diffOutputContracts(before, after)
    if (flags.has('--json')) {
      process.stdout.write(`${JSON.stringify(diff)}\n`)
    } else {
      process.stdout.write(`${formatDiff(diff, flags.has('--verbose'))}\n`)
    }
    if (diff.removed.length > 0 || diff.typeChanged.length > 0) process.exitCode = 1
    return
  }

  printUsage()
  process.exitCode = 2
}

if (import.meta.main) {
  void main()
}
