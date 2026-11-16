# Arena sanity batches

Quick check after a merge or a wide change. It runs the unit tests that guard Arena behavior. It does not replace `bun run test` or CI.

The manual split is [manual-regression-checklist.md](./manual-regression-checklist.md): section 1 is customized, section 2 is exclusive, section 3 is stock. These commands are the automated half of sections 1 and 2. Rows that are still manual (deployed-chat UI, live OAuth, exclusive block live runs) stay on that checklist.

## Commands

```bash
bun run test:sanity:suggest
bun run test:sanity:affected
bun run test:sanity:arena
```

`suggest` prints the batches and the command. It does not run tests. `affected` runs the Vitest files for the batches the diff selected. `arena` runs both Arena batches with no diff.

The default range is `origin/version-6.2-main...HEAD`. Pass another base with `--base`:

```bash
bun run test:sanity:suggest -- --base origin/version-6.2-main
```

An empty range falls back to uncommitted files. If that is empty too, the command says there is nothing to classify.

## What a diff selects

| Diff | Batch |
| --- | --- |
| A path under an Arena-only tree (`local-copilot`, `lib/billing/arena`, `tools/arena`, the Arena-only integrations, Arena auth, Arena migrations) | `arena-exclusive` |
| A customized seam (deployed chat, `executor/execution`, settings navigation, Shopify, Google Ads, Google Slides, Slack, Gmail, image generation, the mothership fork route) | `arena-customized` |
| `blocks/registry-maps.ts`, `tools/registry.ts`, or the mothership server router | both batches, plus the sync gates |
| Branch `upstream-sync/*`, or more than 40 files against the base | both batches, even when no seam path changed. The output lists the seam paths that did change |
| `apps/sim/blocks/`, `apps/sim/serializer/`, `packages/db/migrations/`, or the tool registry | sync-gate commands, which are printed and not executed |
| Anything else, including docs | no Arena batch |

`arena-exclusive` runs every `*.test.ts(x)` under those trees. `arena-customized` runs a fixed allowlist, including shared files such as `executor/execution/engine.test.ts` and `blocks/utils.test.ts` in full. There is no test-name filter.

Sync gates, when the diff touches them:

```bash
bun run apps/sim/scripts/diff-block-output-contracts.ts diff /tmp/output-contracts-before.json
bun run apps/sim/scripts/check-block-registry.ts origin/version-6.2-main
```

The output-contract diff needs the dump from [sync-strategy.md](./sync-strategy.md) first.

## Left out of the quick run

- `*.integration.ts`, `*.integration.test.ts`, and `*.live.test.ts`. Arena billing integration files are named in the suggestion. They need Postgres.
- The stock suite. When nothing Arena matches, the command says so and points at `bun run test`.
- The manual checklist.
