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

When upstream changes `BLOCK_REGISTRY` / `BLOCK_META_REGISTRY` layout, re-verify Arena blocks are still merged in correctly.

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
9. **This file** — Update the tables above if anything was added, removed, or renamed during the merge.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-10-16 | Workflow panel Launch button restored (`launch-deployed-chat.tsx`). Re-apply beside Run on upstream panel merges. |
| 2026-09-07 | Workspace creation and personal-workspace README at `apps/sim/lib/workspaces/README.md` |
| 2026-09-07 | Stripe payments and plans README at `apps/sim/lib/billing/README.md` |
| 2026-09-01 | Arena upgrade overlay (Starter/Pro/Max) + checkout ignores Starter Stripe ID and supersedes Starter on payment |
| 2026-09-01 | Arena flat org pricing ($30 Pro / $100 Max) + Stripe plan catalog (`team_1950` / `team_6500`, `STRIPE_PRICE_TEAM_30_*`) |
| 2026-09-01 | Arena billing module: Starter plan provisioning for client organizations, daily refresh disabled by default |
| 2026-07-17 | Document Enterprise settings: `forks` and `custom-blocks` nav items disabled |
| 2026-07-02 | Initial notes: custom blocks registry, image variations, deployed chat refactor |
