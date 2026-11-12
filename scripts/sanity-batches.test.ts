import { describe, expect, it } from 'vitest'
import { classify } from './sanity-batches'

const EXCLUSIVE_SENTINEL = 'apps/sim/local-copilot/lib/routing.test.ts'
const EXCLUSIVE_FOLDER_UNIT = 'apps/sim/local-copilot/integration/file-turn-persist.test.ts'
const CUSTOMIZED_SENTINEL = 'apps/sim/executor/execution/engine.test.ts'
const BILLING_INTEGRATION = [
  'apps/sim/lib/billing/arena/checkout-supersede.integration.test.ts',
  'apps/sim/lib/billing/arena/expired-starter.integration.test.ts',
]
const SYNC_GATES = [
  'bun run apps/sim/scripts/diff-block-output-contracts.ts diff /tmp/output-contracts-before.json',
  'bun run apps/sim/scripts/check-block-registry.ts origin/version-6.2-main',
]

function docsFiles(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `apps/docs/content/page-${index}.mdx`)
}

function quickFiles(files: string[]): string[] {
  return files.filter(
    (file) =>
      !file.endsWith('.integration.ts') &&
      !file.endsWith('.integration.test.ts') &&
      !file.endsWith('.integration.test.tsx') &&
      !file.endsWith('.live.test.ts') &&
      !file.endsWith('.live.test.tsx')
  )
}

describe('classify', () => {
  it('keeps an exclusive path off the customized allowlist', () => {
    const plan = classify(['apps/sim/local-copilot/lib/routing.ts'])

    expect(plan.batches).toEqual(['arena-exclusive'])
    expect(plan.vitestFiles).toContain(EXCLUSIVE_SENTINEL)
    expect(plan.vitestFiles).not.toContain(CUSTOMIZED_SENTINEL)
    expect(plan.syncGateCommands).toEqual([])
    expect(plan.syncDetail).toBeNull()
  })

  it('keeps a customized seam off Local Copilot', () => {
    const plan = classify(['apps/sim/tools/shopify/list_customers.ts'])

    expect(plan.batches).toEqual(['arena-customized'])
    expect(plan.vitestFiles).toContain('apps/sim/tools/shopify/list_customers.test.ts')
    expect(plan.vitestFiles).toContain(CUSTOMIZED_SENTINEL)
    expect(plan.vitestFiles.some((file) => file.startsWith('apps/sim/local-copilot/'))).toBe(false)
    expect(plan.syncGateCommands).toEqual([])
  })

  it.each([
    'apps/sim/blocks/registry-maps.ts',
    'apps/sim/tools/registry.ts',
    'apps/sim/lib/mothership/tools/server/router.ts',
  ])('pulls both Arena batches and the sync gates for %s', (file) => {
    const plan = classify([file])

    expect(plan.batches).toEqual(['arena-exclusive', 'arena-customized'])
    expect(plan.vitestFiles).toContain(EXCLUSIVE_SENTINEL)
    expect(plan.vitestFiles).toContain(CUSTOMIZED_SENTINEL)
    expect(plan.syncGateCommands).toEqual(SYNC_GATES)
    expect(plan.reasons.map((reason) => reason.paths)).toEqual([[file], [file]])
  })

  it('selects nothing for a docs-only path', () => {
    const plan = classify(['apps/docs/content/docs/integrations/arena.mdx'])

    expect(plan.batches).toEqual([])
    expect(plan.vitestFiles).toEqual([])
    expect(plan.optionalIntegrationFiles).toEqual([])
    expect(plan.syncGateCommands).toEqual([])
    expect(plan.syncDetail).toBeNull()
  })

  it('treats forty docs files as stock and forty-one as both Arena batches', () => {
    const below = classify(docsFiles(40))
    expect(below.batches).toEqual([])
    expect(below.syncDetail).toBeNull()

    const above = classify(docsFiles(41))
    expect(above.batches).toEqual(['arena-exclusive', 'arena-customized'])
    expect(above.vitestFiles).toContain(EXCLUSIVE_SENTINEL)
    expect(above.vitestFiles).toContain(CUSTOMIZED_SENTINEL)
    expect(above.syncDetail).toBe('41 files')
    expect(above.seamPaths).toEqual([])
    expect(above.syncGateCommands).toEqual([])
  })

  it('selects both Arena batches on an upstream-sync branch', () => {
    const plan = classify(['apps/docs/content/docs/index.mdx'], {
      branch: 'upstream-sync/2026-11-12',
    })

    expect(plan.batches).toEqual(['arena-exclusive', 'arena-customized'])
    expect(plan.syncDetail).toBe('branch upstream-sync/2026-11-12')
    expect(plan.seamPaths).toEqual([])
  })

  it('names a seam that sits inside a sync-sized diff', () => {
    const plan = classify([...docsFiles(40), 'apps/sim/tools/shopify/list_customers.ts'])

    expect(plan.batches).toEqual(['arena-exclusive', 'arena-customized'])
    expect(plan.seamPaths).toEqual(['apps/sim/tools/shopify/list_customers.ts'])
    expect(plan.reasons.find((reason) => reason.batch === 'arena-customized')?.paths).toEqual([
      'apps/sim/tools/shopify/list_customers.ts',
    ])
    expect(plan.reasons.find((reason) => reason.batch === 'arena-exclusive')?.paths).toEqual([])
  })

  it('leaves Arena billing integration files out of the Vitest argv', () => {
    const plan = classify(['apps/sim/lib/billing/arena/access.ts'])

    expect(plan.batches).toEqual(['arena-exclusive'])
    expect(plan.vitestFiles).toEqual(quickFiles(plan.vitestFiles))
    expect(plan.vitestFiles).toContain(EXCLUSIVE_FOLDER_UNIT)
    for (const file of BILLING_INTEGRATION) expect(plan.vitestFiles).not.toContain(file)
    expect(plan.optionalIntegrationFiles).toEqual(expect.arrayContaining(BILLING_INTEGRATION))
  })

  it('prints sync gates for a serializer change without an Arena batch', () => {
    const plan = classify(['apps/sim/serializer/index.ts'])

    expect(plan.batches).toEqual([])
    expect(plan.vitestFiles).toEqual([])
    expect(plan.syncGateCommands).toEqual(SYNC_GATES)
  })

  it('prints sync gates for a block file that is not a registry', () => {
    const plan = classify(['apps/sim/blocks/blocks/agent.ts'])

    expect(plan.batches).toEqual([])
    expect(plan.syncGateCommands).toEqual(SYNC_GATES)
  })
})
