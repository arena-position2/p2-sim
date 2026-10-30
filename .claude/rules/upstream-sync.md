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

Read [docs/upstream/sync-strategy.md](docs/upstream/sync-strategy.md) and follow it before editing. The seam inventory for the sync already merged into `version-6.2-main` is [docs/upstream/version-6.1-main-vs-main.md](docs/upstream/version-6.1-main-vs-main.md). The next sync starts from `version-6.2-main`. Behavior added on `version-6.2-main` after the 2026-10-14 sync is listed in the merge checklist in `.agents/ARENA-NOTES.md`. Re-apply it on upstream's structure.

Merge `origin/main` into the integration branch only after `origin/main` has taken `upstream/main` and kept branding. If `origin/main` is behind `upstream/main`, update the intake branch first.

Follow these core rules during every sync:

1. **Split or wrap on touch**: Avoid future merge conflicts by extracting touched in-place Arena overrides into separate files or thin wrappers/spreads (`apps/sim/blocks/registry-maps.ts`, `apps/sim/tools/arena-registry.ts`, `apps/sim/lib/mothership/tools/server/arena-registry.ts`, `packages/db/arena-schema.ts`). Do not take a whole conflicted file from one side unless the strategy says to stop and ask.
2. **Adopt upstream improvements and alert on impact**: Take upstream fixes, refactors, and improvements. Assess how each change affects current product behavior (positively or negatively) and alert the user whenever observable behavior changes.
3. **Capture and diff same-feature overlaps**: When both Arena and upstream implement the same or overlapping functionality, capture the case and diff both implementations (UX, API, data model, edge cases) before choosing to keep separate, wrap upstream, or adopt upstream.
4. **Regenerate artifacts before contract diffing**: Run `bun run generate:tool-metadata`, `bun run scripts/generate-schema-mock.ts`, `bun run generate:deployment-config`, `bun run generate:block-successors`, `bun run scripts/generate-docs.ts`, `bun run generate:docs-manifest`, and `bun run skills:sync` after resolving code conflicts and before diffing contracts.
5. **Diff block/subblock input and output contracts**: Dump output contracts on `version-6.2-main` before merging and diff them on the sync branch after regenerating tool metadata:

```bash
bun run apps/sim/scripts/diff-block-output-contracts.ts dump --out /tmp/output-contracts-before.json
bun run apps/sim/scripts/diff-block-output-contracts.ts diff /tmp/output-contracts-before.json
bun run apps/sim/scripts/check-block-registry.ts version-6.2-main
```

A removed output path or type change blocks the sync until an alias still writes the old key, or the sync report records that no saved workflow references it. Subblock ID removals must be mapped in `SUBBLOCK_ID_MIGRATIONS`.
6. **Run the verification gate and write the full sync report**: Run `bun run check:arena-seams`, `bun run type-check`, `bun run check:audits`, `bun run check:migrations version-6.2-main`, and the Arena seam tests. Produce the complete sync report (`docs/upstream/sync-YYYY-MM-DD.md`) using the template in `docs/upstream/sync-strategy.md` (Merge Highlights, Positive/Negative Behavioral Impacts, Same-Feature Overlap Diffs, Block/Subblock Input & Output Schema Changes, and the 3 Master Feature Tables for Arena-Only, Arena Customizations, and Sim-Only features with per-sync change tracking).

## Any other task

Do not treat `main` as the product branch. Do not overwrite Arena behavior while editing an upstream file. Prefer adding new Arena functionality as a separate module or thin wrapper rather than editing upstream functions in place.
