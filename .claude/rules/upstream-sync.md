---
description: Upstream sync procedure for the Arena fork of Sim
---

# Upstream sync

This repository is an Arena fork of Sim (`simstudioai/sim`).

## Branches

- `upstream/main` is read-only Sim. Never commit to it.
- `origin/main` is Sim `main` plus branding. It is the intake branch. After `git fetch`, use `origin/main`. The local `main` checkout is stale.
- `version-6.2-main` is the product branch.
- `version-6.1-main` is the previous product line. Do not sync onto it.
- Cut `upstream-sync/YYYY-MM-DD` from `version-6.2-main`. Do not sync on `main` or on `version-6.2-main`.

## When the task is an upstream sync

Read [docs/upstream/sync-strategy.md](docs/upstream/sync-strategy.md) and follow it before editing. The seam inventory for the sync already merged into `version-6.2-main` is [docs/upstream/version-6.1-main-vs-main.md](docs/upstream/version-6.1-main-vs-main.md). The next sync starts from `version-6.2-main`.

Merge `origin/main` into the integration branch only after `origin/main` has taken `upstream/main` and kept branding. If `origin/main` is behind `upstream/main`, update the intake branch first.

Prefer upstream. Re-apply only required Arena behavior, on upstream's structure. Do not take a whole conflicted file from one side unless the strategy says to stop and ask.

Before the sync is done, dump output contracts on `version-6.2-main` and diff them on the sync branch:

```bash
bun run apps/sim/scripts/diff-block-output-contracts.ts dump --out /tmp/output-contracts-before.json
bun run apps/sim/scripts/diff-block-output-contracts.ts diff /tmp/output-contracts-before.json
```

A removed path or a type change blocks the sync until an alias still writes the old key, or the sync report records that no saved workflow references it. Run `bun run apps/sim/scripts/check-block-registry.ts version-6.2-main` for subblock id removals.

Also diff deleted files (`git diff --diff-filter=D --name-only origin/version-6.2-main...HEAD`) against Local Copilot callers: `MOTHERSHIP_DELEGATED_TOOL_NAMES`, the copilot prompt, and `@/lib/mothership` / `@/lib/copilot` imports from `apps/sim/local-copilot` and `apps/sim/ee`. A name Arena still calls whose implementation disappeared blocks the sync until the report records `port`, `wrapper`, or `drop`. That check is step 7 of the strategy.

A clean auto-merge can drop an export Arena still imports. `HelpFormBody` was that case on the 2026-11-09 sync. Run `bun install`, then `bun run type-check`. Restore the export on upstream's file when the pre-sync tip had it and an Arena-only caller remains. Regenerate tool and integration catalogs after taking upstream's generated files. An unclassified missing export blocks the sync.

After those checks, run `bun run test:sanity:suggest` and give the user that command. It names the Arena unit-test batch the diff affects. `bun run test:sanity:affected` runs it. The full `bun run test` suite stays the gate. See [docs/upstream/sanity-batches.md](docs/upstream/sanity-batches.md).

## Any other task

Do not treat `main` as the product branch. Do not overwrite Arena behavior while editing an upstream file.
