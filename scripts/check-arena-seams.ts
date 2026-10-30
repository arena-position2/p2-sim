#!/usr/bin/env bun
/**
 * Verifies that critical Arena fork wrappers, registry spreads, and stubs
 * have not been silently dropped during an upstream merge.
 *
 * A clean Git merge can overwrite a one-line spread or constant when upstream
 * edits adjacent lines. This check inspects the key Arena seam files and exits
 * non-zero if any required wrapper or invariant is missing.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')

export interface SeamCheck {
  id: string
  file: string
  description: string
  test: (content: string) => boolean
}

export const ARENA_SEAM_CHECKS: readonly SeamCheck[] = [
  {
    id: 'block-registry-spread',
    file: 'apps/sim/blocks/registry-maps.ts',
    description:
      'BLOCK_REGISTRY and BLOCK_META_REGISTRY must spread ARENA_CUSTOM_BLOCK_REGISTRY and ARENA_CUSTOM_BLOCK_META_REGISTRY',
    test: (content) =>
      content.includes('...ARENA_CUSTOM_BLOCK_REGISTRY') &&
      content.includes('...ARENA_CUSTOM_BLOCK_META_REGISTRY'),
  },
  {
    id: 'tool-registry-spread',
    file: 'apps/sim/tools/registry.ts',
    description: 'tools registry must spread arenaToolRegistry from @/tools/arena-registry',
    test: (content) =>
      content.includes("from '@/tools/arena-registry'") && content.includes('...arenaToolRegistry'),
  },
  {
    id: 'mothership-server-router-spread',
    file: 'apps/sim/lib/mothership/tools/server/router.ts',
    description:
      'getServerToolRegistry must spread arenaServerToolRegistry from @/lib/mothership/tools/server/arena-registry',
    test: (content) =>
      content.includes("from '@/lib/mothership/tools/server/arena-registry'") &&
      content.includes('...arenaServerToolRegistry'),
  },
  {
    id: 'db-schema-reexport',
    file: 'packages/db/schema.ts',
    description: 'packages/db/schema.ts must re-export ./arena-schema',
    test: (content) => content.includes("export * from './arena-schema'"),
  },
  {
    id: 'deployed-chat-client',
    file: 'apps/sim/app/(interfaces)/chat/[identifier]/page.tsx',
    description: 'Deployed chat page must render ArenaDeployedChat',
    test: (content) => content.includes('ArenaDeployedChat'),
  },
  {
    id: 'builder-panel-launch-button',
    file: 'apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/panel.tsx',
    description: 'Workflow builder panel must render LaunchDeployedChat beside Run',
    test: (content) => content.includes('LaunchDeployedChat'),
  },
  {
    id: 'function-sandbox-timeout-cap',
    file: 'apps/sim/lib/execution/constants.ts',
    description:
      'DEFAULT_EXECUTION_TIMEOUT_MS must stay capped at 3_600_000 (60m) for E2B compatibility',
    test: (content) =>
      /DEFAULT_EXECUTION_TIMEOUT_MS\s*=\s*3_600_000\b/.test(content) &&
      /MAX_EXECUTION_DURATION\s*=\s*3_600\b/.test(content),
  },
  {
    id: 'migration-0411-stub',
    file: 'packages/db/migrations/0411_project_membership_enforcement.sql',
    description:
      '0411_project_membership_enforcement.sql must remain a SELECT 1 stub (script 0032 owns the switch)',
    test: (content) =>
      /^\s*SELECT\s+1\s*;\s*$/m.test(content) && !/\bALTER\s+TABLE\b/i.test(content),
  },
  {
    id: 'local-copilot-executor-seams',
    file: 'apps/sim/local-copilot/lib/tools/executor.ts',
    description:
      'Local Copilot tool executor must preserve Start inputFormat repair, knowledge-tool coercion, and manage_skill',
    test: (content) =>
      content.includes('ensureStartReservedInputFormatInEditOperations') &&
      content.includes('coerceLocalEditAgentTools') &&
      content.includes('executeManageSkill'),
  },
]

export function evaluateArenaSeams(
  readFile: (relPath: string) => string = (relPath) =>
    readFileSync(path.join(ROOT, relPath), 'utf8')
): string[] {
  const failures: string[] = []
  for (const check of ARENA_SEAM_CHECKS) {
    try {
      const content = readFile(check.file)
      if (!check.test(content)) {
        failures.push(`[${check.id}] ${check.file}: ${check.description}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`[${check.id}] ${check.file}: could not read file (${message})`)
    }
  }
  return failures
}

if (import.meta.main) {
  const failures = evaluateArenaSeams()
  if (failures.length > 0) {
    console.error('✗ Arena seam verification failed:\n')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exit(1)
  }
  console.log(`✓ All ${ARENA_SEAM_CHECKS.length} Arena seams verified.`)
}
