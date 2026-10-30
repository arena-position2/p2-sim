# Arena Custom Development Notes

Living reference for **Arena-specific (P2 fork) changes** on top of upstream Sim. Use this when merging version branches, rebasing onto upstream, or onboarding agents so it is clear what exists only on this branch and must be preserved or re-applied.

**Keep this file updated** whenever custom blocks, UI, APIs, or infra are added or removed.

---

## Custom workflow blocks

Arena-only blocks are registered separately from upstream Sim blocks in `ARENA_CUSTOM_BLOCK_REGISTRY` inside `apps/sim/blocks/registry-maps.ts`. They are spread into `BLOCK_REGISTRY` at build time.

| Block type | Name | Summary | Source |
|------------|------|---------|--------|
| `arena` | Arena | Internal Arena task/project operations (create tasks, sub-tasks, comments, meetings, overdue tasks, etc.) | `apps/sim/blocks/blocks/arena.ts`, `apps/sim/tools/arena/` |
| `facebook_ads` | Facebook Ads | Natural-language Facebook Ads data queries | `apps/sim/blocks/blocks/facebook_ads.ts` |
| `figma` | Figma | Figma file interaction, design creation, code conversion | `apps/sim/blocks/blocks/figma.ts` |
| `google_ads_v1` | Google Ads V1 | AI-powered Google Ads queries with simplified GAQL generation | `apps/sim/blocks/blocks/google_ads_v1.ts` |
| `image_fusion` | Image Fusion | Fuse multiple images with Nano Banana Pro (Gemini image model) | `apps/sim/blocks/blocks/image_fusion.ts` |
| `p2_docs` | P2 Docs | Presentation template schemas, icons, and team data | `apps/sim/blocks/blocks/p2_docs.ts` |
| `semrush` | Semrush | SEO data from Semrush | `apps/sim/blocks/blocks/semrush.ts` |
| `spyfu` | SpyFu | SEO, PPC, competitor, keyword, ranking, and usage data | `apps/sim/blocks/blocks/spyfu.ts` |
| `unipile` | LinkedIn (Unipile) | LinkedIn company data and messaging via Unipile | `apps/sim/blocks/blocks/unipile.ts` |
| `presentation` | Presentation | Create presentations with customizable slides, tone, and verbosity | `apps/sim/blocks/blocks/presentation.ts` |

> **Note:** `presentation` may be commented out in `ARENA_CUSTOM_BLOCK_REGISTRY` depending on branch state — check `registry-maps.ts` before assuming it is active.

`unipile` also has a custom catalog meta entry in `ARENA_CUSTOM_BLOCK_META_REGISTRY`.

### Registry touchpoints

- Config registry: `apps/sim/blocks/registry-maps.ts` → `ARENA_CUSTOM_BLOCK_REGISTRY`
- Meta registry: `apps/sim/blocks/registry-maps.ts` → `ARENA_CUSTOM_BLOCK_META_REGISTRY`
- Tool registry: `apps/sim/tools/arena-registry.ts` → `arenaToolRegistry` spread into `apps/sim/tools/registry.ts`
- Mothership server tool registry: `apps/sim/lib/mothership/tools/server/arena-registry.ts` → `arenaServerToolRegistry` spread into `apps/sim/lib/mothership/tools/server/router.ts`
- Database schema: `packages/db/arena-schema.ts` → re-exported at the bottom of `packages/db/schema.ts`

When upstream changes `BLOCK_REGISTRY` / `BLOCK_META_REGISTRY`, `tools/registry.ts`, `mothership/tools/server/router.ts`, or `packages/db/schema.ts`, re-verify the Arena spreads and re-exports are still present (`bun run check:arena-seams`).

---

## Image variations (multi-image generation)

Custom logic to generate **multiple image variations** from a single prompt (e.g. “give me three variations”) instead of always producing one image.

| Area | Location |
|------|----------|
| Count resolution (SLM + heuristics) | `apps/sim/lib/image-generation/resolve-image-count.server.ts` |
| Constants / limits | `apps/sim/lib/image-generation/constants.ts` |
| Conversation image catalog & reuse | `apps/sim/lib/chat/conversation-image-catalog.ts`, `apps/sim/lib/chat/use-generated-image-reuse.ts` |
| File upload: pick images from chat | `apps/sim/app/workspace/.../file-upload/conversation-image-picker.tsx` |
| Message image parsing tests | `apps/sim/app/workspace/.../chat-message/message-images.test.ts` |

---

## Deployed chat refactor

The public/deployed chat experience is a **custom Arena implementation**, not the upstream `ChatClient`.

| Area | Location |
|------|----------|
| Deployed chat page (uses Arena client) | `apps/sim/app/(interfaces)/chat/[identifier]/page.tsx` |
| Arena deployed chat UI | `apps/sim/app/(interfaces)/chat/[identifier]/ArenaDeployedChat.tsx` |
| Arena chat header | `apps/sim/app/(interfaces)/chat/components/header/arenaHeader.tsx` |
| Arena chat message rendering | `apps/sim/app/(interfaces)/chat/components/message/ArenaClientChatMessage.tsx` |
| Left nav / threads | `apps/sim/app/(interfaces)/chat/[identifier]/leftNavThread.tsx` |
| Feedback view | `apps/sim/app/(interfaces)/chat/[identifier]/FeedbackView.tsx` |
| Mixpanel events (deployed chat) | `apps/sim/app/arenaMixpanelEvents/mixpanelEvents.ts` |
| Loading agent (Arena branding) | `apps/sim/components/ui/loading-agent-arena.tsx` |

Upstream `chat.tsx` under the same route may still exist but is commented out in favor of `ArenaDeployedChat`.

---

## Settings nav — Enterprise items disabled

Arena intentionally hides two Enterprise settings entries that upstream still ships. Both are **commented out** in `allNavigationItems` (not deleted), so merges can reintroduce them by uncommenting.

| Nav item | Id | Why / notes |
|----------|-----|-------------|
| Workspace Forks | `forks` | Disabled — workspace forking not offered in Arena settings. |
| Custom blocks | `custom-blocks` | Disabled — publish-as-reusable-block flow not offered in Arena settings. |

**Source of truth:** `apps/sim/app/workspace/[workspaceId]/settings/navigation.ts`

When merging upstream, keep these two items commented out unless product explicitly re-enables them.

---

## Other Arena touchpoints (non-exhaustive)

Add rows here as more custom work lands.

| Feature | Location / notes |
|---------|------------------|
| Arena sub-block UI (client selector) | `apps/sim/app/workspace/.../sub-block/components/arena/` |
| Arena API routes | `apps/sim/app/api/tools/arena/` |
| Arena auth / session cookie domain | `apps/sim/lib/auth/session-cookie-domain.ts` |
| Arena utils (users list, etc.) | `apps/sim/lib/arena-utils/` |
| Figma design generator | `apps/sim/lib/figma-design-generator.ts` |
| Org whitelabeling / branding | `apps/sim/ee/whitelabeling/` |
| Sidebar brand header | `apps/sim/app/workspace/.../sidebar/components/sidebar-brand-header/` |
| Settings Enterprise nav (forks + custom-blocks off) | `apps/sim/app/workspace/.../settings/navigation.ts` |
| Arena billing (Starter plan, flat org pricing, daily refresh policy) | `apps/sim/lib/billing/arena/` — full Stripe/plans README: `apps/sim/lib/billing/README.md` |
| Client org Starter provisioning | `apps/sim/lib/billing/arena/client-org-billing.ts` (called from `lib/organizations/client-organization.ts`) |
| Arena Stripe plans (`team_1950` / `team_6500`) | `apps/sim/lib/billing/arena/plans.ts` via `getPlans()` when Arena billing is on |
| Flat org seat reconcile skip | `apps/sim/lib/billing/arena/org-pricing.ts` → early return in `reconcileOrganizationSeats` |
| Arena upgrade page overlay | `arena/upgrade-presenter.ts`, `arena/upgrade-comparison.ts` → `upgrade.tsx` / `use-upgrade-state.ts` |
| Checkout ignores Starter Stripe ID | `arena/checkout-policy.ts` → `lib/billing/client/upgrade.ts` |
| Supersede Starter on paid checkout | `arena/supersede-starter.ts` → `onSubscriptionComplete` + org ensure |
| Personal / signup workspace creation | `apps/sim/lib/workspaces/README.md` |
| Workflow panel Launch (deployed chat) | `apps/sim/app/workspace/.../panel/components/launch-deployed-chat.tsx`, rendered beside Run in `panel.tsx`. Shows only when the workflow has a chat or app deployment. Upstream's Run button stays the in-builder execution. |

---

## Merge / version-branch checklist

When pulling upstream Sim into an Arena branch:

1. **Blocks** — Confirm every entry in `ARENA_CUSTOM_BLOCK_REGISTRY` (and meta registry) is still present and spread into `BLOCK_REGISTRY`.
2. **Tools & API routes** — Arena tool folders (`tools/arena/`, `tools/p2_docs/`, etc.) and `app/api/tools/arena/` routes survive the merge.
3. **Deployed chat** — `page.tsx` still wires `ArenaDeployedChat`, not upstream `ChatClient`.
4. **Image variations** — `resolve-image-count.server.ts` and related image-generation paths are not overwritten by upstream single-image defaults.
5. **Settings Enterprise nav** — Keep `forks` and `custom-blocks` commented out in `settings/navigation.ts`.
6. **Stripe / plans** — Follow `apps/sim/lib/billing/README.md` (runtime `getCreditsPerDollar()`, Checkout URL + non-blocking transfer, Starter has no Stripe ID, EE entitlement includes Starter/Max).
7. **Workspaces** — Follow `apps/sim/lib/workspaces/README.md` (signup `ensurePersonalWorkspaceOnEmailSignup`, keep `/workspace` fallbacks, keep `isPersonal` + first-personal on free/lapsed orgs).
8. **Workflow panel Launch** — `launch-deployed-chat.tsx` must still render beside upstream's Run chip in `panel.tsx`. Do not rename Run back to Test. Launch stays hidden unless chat status reports a deployment.
9. **Copilot turn recovery** — Re-apply the fresh-poll wait and the missing-run retry on upstream's `run.ts`. A content-less “Run not found” is retried, and a suggested follow-up waits until the long-poll has time left (`receiver.ts` `minRemainingMs`; `stream-retry.ts` treats that 404 as retryable). Do not keep Arena's whole `run.ts`.
10. **Local fork** — `lib/mothership/chat/application/fork.ts` still opens the new chat when Arena Copilot has no worker conversation. Cloud fork still requires the worker copy.
11. **User stop** — `handle-error-event.ts` and `turn-model.ts` treat an explicit stop as stopped. No error toast and no `user_stop:` text.
12. **Knowledge reference modal** — the portaled dialog in `knowledge-results-modal.tsx` keeps the `deployed-chat` class.
13. **Function sandbox cap** — `DEFAULT_EXECUTION_TIMEOUT_MS` stays 60 minutes (`3_600_000`) and `MAX_EXECUTION_DURATION` stays `3_600`. The function handler and `execute-request.ts` cap with that constant. Do not restore 100 minutes; E2B rejects a longer sandbox lifetime.
14. **Migration 0411** — `packages/db/migrations/0411_project_membership_enforcement.sql` stays `SELECT 1`. Script `0032` owns the column-authority switch. If upstream ships a real `0411_*`, treat it as a migration-number collision. Do not restore the earlier SQL body.
15. **Post-sync product seams** — Re-apply Usage vs Insights, `X-Sim-Email` billing, image render and edit, Slack connect copy, the light default theme, dark editor popovers, finished-reply scroll formatting, Copilot HTML file tools, and calendar, Gmail, and Slack as canvas blocks. Files are in the list below. Do not take upstream's copy of those files whole.
16. **Local copilot wiring** — `apps/sim/local-copilot/**` comes back as new files. `local-copilot/lib/tools/executor.ts` still calls Start `inputFormat` repair, knowledge-tool coercion, and `manage_skill`. The Local stop path in `local-copilot/integration/mothership-lifecycle.ts` comes back with that tree.
17. **This file** — Update the tables above if anything was added, removed, or renamed during the merge.

### Re-apply on the next upstream sync

These behaviors landed on `version-6.2-main` after the 2026-10-14 sync. They are required even when the file is mostly upstream. Re-apply the behavior on upstream's structure. Do not keep Arena's whole copy of the file. The manual pass is [docs/upstream/manual-regression-checklist.md](../docs/upstream/manual-regression-checklist.md).

`apps/sim/local-copilot/**` comes back as its own tree. After that, `apps/sim/local-copilot/lib/tools/executor.ts` must still call `ensureStartReservedInputFormatInEditOperations`, `coerceLocalEditAgentTools`, and `executeManageSkill`. The Local stop path in `apps/sim/local-copilot/integration/mothership-lifecycle.ts` comes back with that tree.

- **Suggested follow-up and “Run not found”** — On Cloud, a follow-up clicked as the long-poll dies, and a later turn after idle, must complete. The user does not see “Run not found”. A Local turn that reconnects stays on Local. In `apps/sim/lib/mothership/request/lifecycle/run.ts`, wait for a poll with at least `FRESH_POLL_MIN_REMAINING_MS` (8s) left before a fresh POST, and retry a content-less “Run not found” instead of rendering it. `apps/sim/lib/mothership/transport/receiver.ts` honors `minRemainingMs`. `apps/sim/lib/mothership/request/lifecycle/stream-retry.ts` treats a `Run not found` backend error as retryable. Related recovery edits from the same fix: `apps/sim/lib/mothership/chat/post.ts`, `apps/sim/lib/mothership/request/application/recover-stream.ts`, `apps/sim/lib/mothership/request/lifecycle/recovery-config.ts`.
- **Local fork when the worker has no conversation** — `apps/sim/lib/mothership/chat/application/fork.ts`. Arena Copilot keeps the transcript in Sim, so a worker “not found” continues the fork. Cloud fork still requires the worker copy. Local-only skips the worker copy.
- **User stop is not an error** — Stopping a running turn shows stopped. There is no error toast and no `user_stop:` text. Re-apply the `isExplicitStopReason` early return in `apps/sim/app/workspace/[workspaceId]/home/hooks/stream/handle-error-event.ts` and `apps/sim/app/workspace/[workspaceId]/home/hooks/stream/turn-model.ts`.
- **Knowledge reference modal** — `apps/sim/app/(interfaces)/chat/components/message/components/knowledge-results-modal.tsx`. The portaled content carries `deployed-chat` so the dialog stays opaque and the text stays readable.
- **Function sandbox cap** — `DEFAULT_EXECUTION_TIMEOUT_MS` is `3_600_000` and `MAX_EXECUTION_DURATION` is `3_600` in `apps/sim/lib/execution/constants.ts`. `apps/sim/executor/handlers/function/function-handler.ts` and `apps/sim/lib/function-execution/execute-request.ts` cap the timeout with that constant. Upstream’s 100-minute value is rejected by E2B.
- **Migration 0411** — `packages/db/migrations/0411_project_membership_enforcement.sql` stays `SELECT 1`. Script `0032` owns the real switch. Do not restore the earlier SQL body. If upstream ships a real `0411_*`, treat it as a migration-number collision and follow `docs/upstream/sync-strategy.md`.
- **Usage vs Insights** — Every member can open Usage at `/settings/arena-usage`. Billing redirects a non-admin there. Organization → Insights stays on `/settings/usage` for an org admin. Re-apply that split in `apps/sim/components/settings/navigation.ts`, `apps/sim/hooks/use-settings-navigation.ts`, `apps/sim/lib/settings/application/workspace-section-access.ts`, `apps/sim/app/workspace/[workspaceId]/settings/[section]/settings.tsx`, and `apps/sim/app/workspace/[workspaceId]/settings/section-warmers.ts`.
- **`X-Sim-Email` bills the named org once** — Deploy samples include the header. The named user’s org is debited once and shows a By Agent row. An unknown email is `BILLING_EMAIL_NOT_FOUND`. Re-apply in `apps/sim/app/api/v2/workflows/[workflowId]/execute/route.ts`, `apps/sim/lib/billing/core/billing-attribution.ts`, `apps/sim/lib/execution/preprocessing.ts`, `apps/sim/lib/workflows/application/execute-workflow.ts`, `apps/sim/lib/workflows/executor/execute-workflow.ts`, `apps/sim/lib/workflows/executor/execute-service.ts`, `apps/sim/lib/workflows/executor/enqueue-execution.ts`, `apps/sim/background/workflow-execution.ts`, `apps/sim/lib/workspaces/usage/ledger-helpers.ts`, `apps/sim/lib/workspaces/usage/organization-analytics.ts`, `apps/sim/lib/workspaces/usage/user-analytics.ts`, and the deploy-modal API sample in `apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/deploy/components/deploy-modal/components/api/api.tsx`.
- **Images** — Three distinct variations stay three images (`apps/sim/lib/image-generation/resolve-image-count.server.ts`, `apps/sim/lib/image-generation/run-wrapper.server.ts`). A generated or edited image renders as an image, including after refresh, and a reused chat image opens from a copied file path. Re-apply `apps/sim/lib/chat/assistant-assets.ts`, `apps/sim/lib/chat/generated-image-selection.ts`, `apps/sim/lib/uploads/contexts/chat/chat-file-manager.ts`, `apps/sim/lib/workflows/streaming/streaming.ts`, `apps/sim/stores/chat/store.ts`, `apps/sim/app/workspace/[workspaceId]/w/[workflowId]/utils/workflow-attachment-upload.ts`, and the builder chat message constants.
- **Slack connect copy** — Auth method says Arena Bot, not Sim Bot. Copilot connect is one Continue control, not Submit. Re-apply `apps/sim/blocks/blocks/slack.ts`, the Slack setup wizard, `apps/sim/app/workspace/[workspaceId]/home/components/message-content/components/special-tags/special-tags.tsx`, and `apps/docs/content/docs/integrations/slack.mdx`. The Local prompt and trusted-control copy live under `apps/sim/local-copilot/` and come back with that tree.
- **Dark editor popovers and default light theme** — A user with no saved theme loads light (`apps/sim/lib/users/queries.ts`, and `theme` defaults to `light` on `packages/db/schema.ts`). In dark mode, the env-var dropdown, tag dropdown, and messages-input popover stay readable (`apps/sim/app/_styles/globals.css` and those three sub-block components).
- **Calendar, Gmail, and Slack stay canvas blocks** — A fetch-and-send request builds `google_calendar_v2`, `gmail_v2`, and `slack` as their own blocks, not Agent tools. A daily trigger is `schedule`. Nested subflows stay allowed. Re-apply `apps/sim/lib/workflows/editing/builders.ts`, `operations.ts`, and `validation.ts`.
- **Finished reply scroll and Copilot HTML** — Scrolling a finished reply does not turn `*` into bold (`apps/sim/app/workspace/[workspaceId]/home/components/message-content/message-content.tsx` and `chat-content.tsx`). A Copilot HTML file opens as a page. Re-apply the file-tool guards in `apps/sim/lib/copilot/tools/server/files/create-file.ts`, `workspace-file.ts`, `patch-search-replace.ts`, and `html-edit-size-guards.ts`. The Local prompt for that behavior comes back with `apps/sim/local-copilot/`.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-10-30 | Keep-list for fixes after the 2026-10-14 sync: Copilot follow-up and Run not found, Local fork, user stop, knowledge reference modal, 60-minute Function cap, migration 0411 stub, Usage vs Insights, `X-Sim-Email`, images, Slack connect, dark popovers, reply scroll, and Copilot HTML. Re-apply on upstream's structure. |
| 2026-10-16 | Workflow panel Launch button restored (`launch-deployed-chat.tsx`). Re-apply beside Run on upstream panel merges. |
| 2026-09-07 | Workspace creation and personal-workspace README at `apps/sim/lib/workspaces/README.md` |
| 2026-09-07 | Stripe payments and plans README at `apps/sim/lib/billing/README.md` |
| 2026-09-01 | Arena upgrade overlay (Starter/Pro/Max) + checkout ignores Starter Stripe ID and supersedes Starter on payment |
| 2026-09-01 | Arena flat org pricing ($30 Pro / $100 Max) + Stripe plan catalog (`team_1950` / `team_6500`, `STRIPE_PRICE_TEAM_30_*`) |
| 2026-09-01 | Arena billing module: Starter plan provisioning for client organizations, daily refresh disabled by default |
| 2026-07-17 | Document Enterprise settings: `forks` and `custom-blocks` nav items disabled |
| 2026-07-02 | Initial notes: custom blocks registry, image variations, deployed chat refactor |
