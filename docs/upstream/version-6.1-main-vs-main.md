# version-6.1-main vs p2-sim main

Report for the next upstream merge. Fork `main` is `simstudioai/sim` `main` plus branding. Everything below is the gap between that tree and `version-6.1-main`.

This report names behavior and seams. It does not perform the merge, the split, or the wrap.

## How to read this

Each category answers six questions:

1. **Overrides** — files that already exist upstream and that we changed.
2. **Both sides** — files both histories touched since the last sync, with each side’s intent. The 18 Sep 2026 merge-base is only the conflict marker.
3. **Exclusive** — code that exists only on `version-6.1-main`.
4. **Better base** — where the current fork `main` implementation should win, including design that predates 18 Sep.
5. **Can it be split?** — whether our behavior can leave their file so later pulls stop colliding.
   - **Already separate.** New module. Their file only registers or imports it.
   - **Can be split.** Move the behavior behind a named seam. Their file keeps a thin call.
   - **Stuck in their file.** We changed their control flow in place. The conflict returns until that branch is extracted.
6. **Can it wrap theirs?** — whether Arena can call or render their current code and add our behavior before or after it, so their next fix still arrives.
   - **Wraps today.** Our code already sits outside their file and calls it. Taking their next copy keeps our behavior and brings their fix.
   - **Can wrap.** Feasible, but today we edit their file, so their fix does not arrive until that edit moves into the wrapper.
   - **Cannot wrap yet.** There is no extension point. One stable hook has to be added first. Until then, taking their file drops our customization.

## Baseline

| | Fork `main` | `version-6.1-main` |
|---|---|---|
| Tip | [`7d0e9e6`](https://github.com/arenadeveloper02/p2-sim/commit/7d0e9e6eb5e6eb1d2bafdad871ecda48527f4139) (2026-10-05) | [`e992189`](https://github.com/arenadeveloper02/p2-sim/commit/e992189ffd17b8cf619362937b6f20848ecc1896) (2026-10-06) |
| Meaning | Upstream `sim` `main` plus logos and the docs title `P2 Agents Docs` | Product branch |

Last common commit: `f0a4405619` (2026-09-18, merge of `simstudioai:main` into fork `main`).

Since that commit:

- `version-6.1-main` has **1,808 non-merge commits** that fork `main` does not.
- Fork `main` has **492 commits** that `version-6.1-main` has not taken.
- Our tree vs that base: **2,012 files** (+255k / −15k), **1,091 of them new**.
- **588 files** were touched by both sides. That is the next-merge conflict set.
- **9,289 files** changed only on fork `main` (schema snapshots, `apps/sim/lib`, `apps/sim/app`, docs, desktop). Take those as upstream. Do not treat them as our work.

A raw diff of the two tips is about 11,000 files because it mixes our features with upstream we have not merged yet. Use the three-dot split above.

## Next merge

Do this in order:

1. Merge fork `main` into `version-6.1-main` and take upstream for the 9,289 files we did not touch.
2. On the 588 overlapping files, keep upstream’s control flow and re-apply only the seams in this report.
3. Re-add exclusive trees (local copilot, Arena billing package, skill share, exclusive blocks and tools) as new files.
4. Rebuild our database tables on top of upstream’s current schema. Do not replay our migration numbers. They already name different changes than upstream’s files with the same numbers.
5. Prefer a wrapper that calls their current file over editing their function body. A new module plus a one-line registration is that wrapper when the feature is exclusive.

## 1. Identity and shell

### Overrides

We rebranded surfaces that upstream still calls Sim.

- [apps/docs/app/layout.tsx](apps/docs/app/layout.tsx) — Apple web-app title `P2 Agents Docs` (this change is also on fork `main`).
- [apps/sim/components/icons.tsx](apps/sim/components/icons.tsx) and [apps/docs/components/icons.tsx](apps/docs/components/icons.tsx) — `AgentIcon` gradient, block tile borders, Sim strings replaced with Arena AI (`64a1c38244`, `aa6197c751`).
- Sidebar and settings: [sidebar.tsx](apps/sim/app/workspace/[workspaceId]/w/components/sidebar/sidebar.tsx), [sidebar-footer.tsx](apps/sim/app/workspace/[workspaceId]/w/components/sidebar/components/sidebar-footer/sidebar-footer.tsx), [settings-sidebar.tsx](apps/sim/app/workspace/[workspaceId]/w/components/sidebar/components/settings-sidebar/settings-sidebar.tsx), [apps/sim/components/settings/navigation.ts](apps/sim/components/settings/navigation.ts). Usage is back in the sidebar, billing is gated to org admins, “Sim key” is labeled “Arena key”, help menu is commented out, and a “Back to Arena agents” path was added.
- Favicons and logo SVGs under [apps/sim/public](apps/sim/public).

### Both sides

Upstream’s intent on the same files, including work older than 18 Sep and the cleanup since then: one settings navigation model, EMCN-owned chrome, shared document icons, named icon-only buttons, and organization rollout. Commits since the base include `refactor(emcn): centralize document file-type icons`, `refactor(ui): remove styles already supplied by EMCN controls`, and `fix(a11y): name icon-only buttons`.

Our intent: Arena labels, usage/billing visibility, and shell links back to the Arena hub.

### Exclusive

- [apps/sim/public/arena-ai-docs/index.html](apps/sim/public/arena-ai-docs/index.html)
- [apps/sim/public/favicon/site.webmanifest](apps/sim/public/favicon/site.webmanifest)
- Design tokens in deployed chat ([arena-tokens.css](apps/sim/app/(interfaces)/chat/arena-tokens.css)), which belong with chat, not the shell.

### Better base

Keep upstream’s settings navigation, sidebar structure, and icon system. They own layout, access checks, and EMCN defaults. Our copies of `navigation.ts`, `settings-sidebar.tsx`, and `icons.tsx` will fight every EMCN pass. Re-apply Arena as labels, a hub return link, and an org-admin gate, on top of their components.

Whitelabeling already exists upstream in [apps/sim/ee/whitelabeling](apps/sim/ee/whitelabeling). Product name and logo should go through that, not through edited icon components.

### Split

| File | Class | Seam |
|---|---|---|
| `apps/sim/public/**` logos and favicons | Already separate | Asset swap. Fork `main` already carries the branding assets. |
| `apps/docs/app/layout.tsx` title | Can be split | One metadata field, or the whitelabel title. |
| `components/settings/navigation.ts`, org and workspace `navigation.ts` | Can be split | Arena entries as a list merged into upstream’s nav constant. Stop editing item order in place. |
| `sidebar.tsx`, `sidebar-footer.tsx`, `settings-sidebar.tsx` | Stuck until extracted | Layout, help menu, and “Back to Arena” are inside their render tree. Move the Arena link and billing gate into a footer slot component. |
| `components/icons.tsx` | Stuck until extracted | `AgentIcon` and tile chrome are inside the shared icon module. Put `AgentIcon` in an Arena icon file and leave their icon map alone. |

### Wrap

**Can wrap** the product name, logo, and nav labels. Upstream whitelabeling in [apps/sim/ee/whitelabeling](apps/sim/ee/whitelabeling) plus a list merged into their navigation constant is the wrapper. Their layout, EMCN, and accessibility fixes then land in the sidebar and settings shell.

**Cannot wrap yet** for the edits inside `sidebar.tsx`, `sidebar-footer.tsx`, and `icons.tsx`: the Arena return link, the removed help menu, and `AgentIcon`. Those drop out if we take their file, until a footer slot and a separate icon component exist. Logos under `apps/sim/public` already wrap by being an asset swap.

## 2. Deployed chat and workspace chat

This is the largest behavioral override.

### Overrides

Upstream’s deployed chat page renders `ChatClient`. Ours comments that out and renders `ArenaChatClient`:

- [apps/sim/app/(interfaces)/chat/[identifier]/page.tsx](apps/sim/app/(interfaces)/chat/[identifier]/page.tsx)

The HTTP handler is the real tangle. Upstream [route.ts](apps/sim/app/api/chat/[identifier]/route.ts) is 468 lines (`GET` and `POST` via `withRouteHandler`). Ours is 1,433 lines and adds `PATCH`. Inside the stream we now:

- format chart output (`formatChartDeployOutputForChat`)
- strip image-only text and append generated image URLs
- persist knowledge refs and generated images onto execution history
- attach workspace ids
- load and replace golden queries
- label agent departments

Other overridden chat files:

- [chat.tsx](apps/sim/app/(interfaces)/chat/[identifier]/chat.tsx) — left in the tree but unused by the page
- [input.tsx](apps/sim/app/(interfaces)/chat/components/input/input.tsx), [use-chat-streaming.ts](apps/sim/app/(interfaces)/chat/hooks/use-chat-streaming.ts), [message.tsx](apps/sim/app/(interfaces)/chat/components/message/message.tsx), [message-container.tsx](apps/sim/app/(interfaces)/chat/components/message-container/message-container.tsx)
- Workflow floating chat: [chat.tsx](apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/chat/chat.tsx), [chat-message.tsx](apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components/chat-message/chat-message.tsx)
- Deploy modal chat: [chat.tsx](apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/deploy/components/deploy-modal/components/chat/chat.tsx)
- [apps/sim/lib/workflows/streaming/streaming.ts](apps/sim/lib/workflows/streaming/streaming.ts) — block-completion events for the client

Our intent: a branded deployed agent with threads, feedback, golden queries, departments, charts, image reuse, theme sync, and history that does not depend on a webhook or schedule (`e31f867bbd`). Voice is removed from deployed chat.

### Both sides

Upstream’s intent on these same files is a shared product chat: inactive chats return 403 without writing an execution log (`96ab25ec37`), composer actions are shared (`dbc58504d6`), overflow fades and activity spacing are unified (`eac44ebff8`), and public status pages are reused. The route stays a thin `withRouteHandler` around execution.

Our intent is presentation and Arena session behavior inside that same request path. Both are valid. They collide because presentation was added inside their handler and their components.

Workspace Chat (Mothership) files in the overlap — [mothership-chat.tsx](apps/sim/app/workspace/[workspaceId]/home/components/mothership-chat/mothership-chat.tsx), copilot chat payload/lifecycle — are upstream’s Chat product. Our edits there are mostly theme, charts, and usage attribution, not a second chat product.

### Exclusive

The Arena deployed client is already its own tree:

- [ArenaDeployedChat.tsx](apps/sim/app/(interfaces)/chat/[identifier]/ArenaDeployedChat.tsx)
- [DeployedChatLanding.tsx](apps/sim/app/(interfaces)/chat/[identifier]/DeployedChatLanding.tsx), [leftNavThread.tsx](apps/sim/app/(interfaces)/chat/[identifier]/leftNavThread.tsx), [FeedbackView.tsx](apps/sim/app/(interfaces)/chat/[identifier]/FeedbackView.tsx), [deployed-chat-theme-sync.tsx](apps/sim/app/(interfaces)/chat/[identifier]/deployed-chat-theme-sync.tsx)
- [ArenaClientChatMessage.tsx](apps/sim/app/(interfaces)/chat/components/message/ArenaClientChatMessage.tsx), echarts renderer, feedback box, golden-queries modal, welcome CTAs, loaders
- [apps/sim/lib/chat](apps/sim/lib/chat): departments, assistant assets, thread auth, history persistence, generated-image selection, image fetch URLs

### Better base

Keep upstream’s `ChatClient`, input, message container, and streaming hook as the generic deployed chat. Their composer, accessibility, and inactive-chat handling are the better base for any chat that is not an Arena agent.

Keep our Arena client for Arena deployments. The page should choose a client. It should not delete theirs with a comment.

Keep upstream’s route as the execution handler. Chart formatting, image URL splicing, golden queries, department labels, and history writes are presentation and persistence. They are a worse place to live than [apps/sim/lib/chat](apps/sim/lib/chat), which already has modules for most of this. The 1,400-line route will conflict on every chat fix upstream ships, including the 403-without-a-log fix we do not have yet.

Workflow floating chat should take upstream’s component and call the same chart/image presenters. Do not fork a second renderer inside `chat-message.tsx`.

### Split

| File | Class | Seam |
|---|---|---|
| `ArenaDeployedChat.tsx` and sibling components, `lib/chat/*` | Already separate | New modules. |
| `page.tsx` | Can be split | One branch: Arena deployment renders `ArenaChatClient`, otherwise `ChatClient`. Delete the commented import. |
| `app/api/chat/[identifier]/route.ts` | Stuck until extracted | Stream formatting, golden queries, department label, and `updateExecutionHistoryData` sit inside `POST`. Extract `presentDeployedChatOutput()` and call it once before the response is written. `PATCH` for thread rename can be its own route module. |
| `input.tsx`, `message.tsx`, `use-chat-streaming.ts`, `message-container.tsx` | Stuck until extracted | Arena styling and image/chart behavior are inside upstream components. Arena client should own those. Leave upstream components for non-Arena chat. |
| Workflow `chat.tsx` / `chat-message.tsx` | Can be split | Render chart and image blocks through `lib/chart-generation` and `lib/chat/assistant-assets`. |
| Deploy-modal `chat.tsx` | Can be split | Same presenters. Upstream owns the modal shell. |
| `lib/workflows/streaming/streaming.ts` | Stuck until extracted | Block-completion events are inside the shared stream writer. Add an optional listener instead of editing the writer body. |

### Wrap

**Can wrap.** [ArenaDeployedChat.tsx](apps/sim/app/(interfaces)/chat/[identifier]/ArenaDeployedChat.tsx) already renders their `ChatInput` and `ChatMessageContainer` and calls `useChatStreaming`. Threads, landing, feedback, golden queries, and theme stay in Arena files and survive an upstream composer or streaming fix.

The wrap is incomplete today. [use-chat-streaming.ts](apps/sim/app/(interfaces)/chat/hooks/use-chat-streaming.ts) contains `resolveForkContentWithImages` and `formatForkStreamOutputValue`. `ChatInput` has Arena-only props (`selectedGeneratedImages`, `insertText`). The chat route formats charts and images inside `POST`. Move that work to a step that runs after their stream, in [apps/sim/lib/chat](apps/sim/lib/chat) and [apps/sim/lib/chart-generation](apps/sim/lib/chart-generation). Until then, taking their copy of those files drops the customization, and keeping our copy misses their fix.

The workflow floating chat in [chat.tsx](apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/chat/chat.tsx) can wrap the same way. Keep their shell (`processStreamingResponse`, the composer, drag and resize) and call one presenter from `processStreamingResponse` after the `final` event and from `handleWorkflowResponse` for a finished run. Their `ChatClient` in [chat.tsx](apps/sim/app/(interfaces)/chat/[identifier]/chat.tsx) is not mounted, so fixes inside that file do not reach Arena. Arena receives those fixes only by calling the shared input, message list, and streaming hook.

The builder panel header is the same kind of seam. Upstream's [panel.tsx](apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/panel.tsx) owns Deploy and Run (in-builder execution). Arena's [launch-deployed-chat.tsx](apps/sim/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/launch-deployed-chat.tsx) is a separate file that renders **Launch** only when chat status reports a chat or app deployment. Take upstream's panel, then put `<LaunchDeployedChat>` back after the Run chip. Do not fold Launch into Run, and do not rename Run to Test.

## 3. Local copilot

### Overrides

Local copilot is not upstream Chat. The overlap is shared copilot code that both products call:

- [apps/sim/lib/copilot/request/lifecycle](apps/sim/lib/copilot/request/lifecycle) (`start.ts`, `run.ts`, `finalize.ts`)
- [apps/sim/lib/copilot/chat/payload.ts](apps/sim/lib/copilot/chat/payload.ts), [post.ts](apps/sim/lib/copilot/chat/post.ts), [lifecycle.ts](apps/sim/lib/copilot/chat/lifecycle.ts), [process-contents.ts](apps/sim/lib/copilot/chat/process-contents.ts)
- [apps/sim/lib/copilot/tools/server/image/generate-image.ts](apps/sim/lib/copilot/tools/server/image/generate-image.ts), [files/create-file.ts](apps/sim/lib/copilot/tools/server/files/create-file.ts), [workflow/edit-workflow/index.ts](apps/sim/lib/copilot/tools/server/workflow/edit-workflow/index.ts)
- [apps/sim/lib/copilot/request/tools/billing.ts](apps/sim/lib/copilot/request/tools/billing.ts)
- Copilot panel user-input utils and [apps/sim/app/api/copilot/chats/route.ts](apps/sim/app/api/copilot/chats/route.ts)

Our commits here set a hosted flag, default model, timezone, thinking, and image/file behavior (`33b1bca637`, `74a43fc6f7`, `d035b2c090`).

### Both sides

Upstream’s intent is Mothership / Chat as a managed product (`feat(mothership): v1.0.0`) with a request lifecycle, tool confirmations, and billing on the admitted payer. Since 18 Sep they also explain turns the worker ends without a reason, and they keep billing correct when a period moves mid-run.

Our intent on those files is to bend that lifecycle toward local models, image generation, and Arena tool aliases.

### Exclusive

The whole local copilot app is new: [apps/sim/local-copilot](apps/sim/local-copilot) (172 files: `lib/`, `integration/`, `components/`, `hooks/`, `contracts/`). Specs live under [docs/superpowers](docs/superpowers). Tables: `localCopilotConversations`, messages, tool calls, patches, audit logs, user access, user memory.

### Better base

Upstream’s copilot lifecycle is the better base for anything that still runs through `lib/copilot/request`. It knows about period settlement, tool confirmation, and Chat v1. Re-applying our edits inside `lifecycle/run.ts` will drop those fixes.

Local copilot should stay a separate runtime. It should call upstream tools through the server-tool adapter, not by forking `generate-image.ts` and `edit-workflow`.

### Split

| File | Class | Seam |
|---|---|---|
| `apps/sim/local-copilot/**` | Already separate | Own tree and own tables. |
| `lib/copilot/request/lifecycle/*`, `chat/payload.ts`, `chat/post.ts` | Stuck until extracted | Hosted flag, default model, and thinking are inside their turn loop. Pass them as session options from local copilot. |
| `tools/server/image/generate-image.ts`, `files/create-file.ts` | Can be split | Arena image and file behavior as tool handlers registered from local copilot or `lib/image-generation`. |
| `tools/server/workflow/edit-workflow/index.ts` | Stuck until extracted | Nested-loop allowance is an in-place removal of their “nested subflows are not supported” checks. See workflow engine. |
| `request/tools/billing.ts` | Can be split | Call Arena usage attribution. Leave their billing tool as the upstream implementation. |

### Wrap

**Cannot wrap** their Chat lifecycle as a whole. Local copilot is a different runtime, so Mothership fixes in `lib/copilot/request/lifecycle` do not apply to [apps/sim/local-copilot](apps/sim/local-copilot) unless that tree calls those functions.

**Can wrap** the shared path it does call. Pass the hosted flag, default model, and thinking as session options into their `run.ts`, and register image and file tools beside theirs. Taking their lifecycle file then keeps bringing Chat fixes, and local copilot keeps its own UI and tables.

## 4. Billing, org, SSO, and workspaces

### Overrides

Arena plans and checkout are partly beside upstream billing, and partly inside it.

Overridden upstream files:

- [apps/sim/lib/billing/core/usage-log.ts](apps/sim/lib/billing/core/usage-log.ts) — `USAGE_LOG_COST_MULTIPLIER`, scaled ledger amounts, actor metadata on entries
- [apps/sim/lib/billing/calculations/usage-monitor.ts](apps/sim/lib/billing/calculations/usage-monitor.ts)
- [apps/sim/lib/billing/core/plan.ts](apps/sim/lib/billing/core/plan.ts), [constants.ts](apps/sim/lib/billing/constants.ts), [organization.ts](apps/sim/lib/billing/organization.ts), org membership and member limits
- [apps/sim/lib/billing/webhooks/subscription.ts](apps/sim/lib/billing/webhooks/subscription.ts) and credits refresh
- Settings billing UI and navigation (usage groups, org-admin gate, “separate arena billing” in `196f61393a`)
- [apps/sim/lib/workspaces/policy.ts](apps/sim/lib/workspaces/policy.ts)

Our intent: Stripe plans for Arena orgs, credits per dollar, a remaining-credits dashboard, client-org checkout, starter-plan supersede, cost-block repricing, and attribution of Chat and local-copilot usage onto a ledger (`1080f55f4c`, `462ded2489`).

### Both sides

Upstream billing, as it exists on fork `main` today, is a ledger with period bounds, mid-run plan limits, terminal settlement that refuses a late charge, advisory locks, and enterprise reporting windows. Representative commits: `fix(billing): enforce the plan usage limit mid-run`, `fix(billing): refuse charges into a period the terminal settlement already invoiced`, `improvement(billing): share the enterprise reporting usage read`.

Our intent is a second commercial model (Arena tiers, daily refresh, client orgs) written through the same `usage-log` functions. That is why every upstream billing fix conflicts.

### Exclusive

[apps/sim/lib/billing/arena](apps/sim/lib/billing/arena) is already a package: access, checkout policy, client-org billing, daily refresh, plan limits, starter supersede, upgrade presenter, usage limit.

Also new under `lib/billing/core`: cost-block reprice, historical reconciliation, mothership chat attribution, `record-model-usage`, usage-entry normalize. Workspace usage analytics and the embedded-tool virtual split live in [apps/sim/lib/workspaces/usage](apps/sim/lib/workspaces/usage).

### Better base

Upstream’s ledger, period settlement, and usage monitor are the better base. They already solve double-charges, slow ledger reads, and mid-run caps. Our multiplier and actor fields should be inputs to that ledger, not a fork of `usage-log.ts`.

Arena commercial policy (which plan, who can check out, starter supersede, org-admin UI) is ours and is better left in `lib/billing/arena`. Upstream has no Arena tier model. Do not replace that package with their plan constants.

Org membership and invitation checks: take upstream (`fix(organizations): respect inherited access when inviting members`, archived workspace handling). Re-apply only the Arena admin gate.

### Split

| File | Class | Seam |
|---|---|---|
| `lib/billing/arena/**` | Already separate | Policy package. `auth.ts` already calls `supersedeStarterSubscriptions` from there. |
| `usage-log.ts`, `usage-monitor.ts` | Stuck until extracted | Multiplier, actor, and reconciliation math are inside their write path. Pass `ExecutionActor` and a pricing snapshot into their existing entry type. Move `getUsageLogCostMultiplier` and scale helpers fully into `usage-log-cost-multiplier.ts` (that file is already started). |
| `plan.ts`, `constants.ts`, `subscription.ts` | Can be split | Arena plan ids live in `arena/plans.ts` and `arena/tier-config.ts`. Stop copying them into upstream `constants.ts`. |
| Settings billing components | Can be split | Render `arena/billing-presenter` inside their settings page. |
| `lib/workspaces/policy.ts` | Can be split | Personal-workspace and admin-workspace checks already have `is-admin-workspace.ts` and `is-client-user.ts`. Call those. |

### Wrap

**Can wrap.** Call their ledger and usage monitor, then apply Arena plans, checkout, and starter supersede from [apps/sim/lib/billing/arena](apps/sim/lib/billing/arena). Their period-settlement and mid-run limit fixes then arrive with `usage-log.ts`. Today they do not, because the cost multiplier and actor fields are edited inside that file. Settings UI can wrap by rendering `arena/billing-presenter` inside their billing page.

## 5. Auth and OAuth

### Overrides

- [apps/sim/lib/auth/auth.ts](apps/sim/lib/auth/auth.ts) — Arena hub and v3 callback origins on the Better Auth trusted-origin list; session-create hook runs starter supersede; cookie domain work was added and then removed (`774df7e7a3`, `063daac0ca`).
- [apps/sim/lib/oauth/oauth.ts](apps/sim/lib/oauth/oauth.ts) — Zoom user app and Zoom admin app with a long admin scope list, Facebook/Bing-style ad scopes, Microsoft endpoint import.
- [apps/sim/lib/oauth/credential-service.ts](apps/sim/lib/oauth/credential-service.ts) and connection hooks — HubSpot shared portal alias.
- [apps/sim/proxy.ts](apps/sim/proxy.ts) — unauthenticated agent traffic redirects to Arena SSO resume; hub origins are allowed for credentialed API calls; legal pages redirect to Arena URLs.

Our intent: Arena is the identity provider for the agent app. Zoom needs two Marketplace apps. Microsoft and HubSpot need Arena-specific credential rules.

### Both sides

Upstream’s intent is a single OAuth catalog with terminal refresh errors, refresh-chain rotation from the token that started the chain, connector unscheduling when a credential is revoked, and OAuth on workflow MCP servers. That machinery lives in `oauth.ts` and the credential service. Our provider entries are data. Their refresh and revocation logic is control flow. Both landed in the same files.

### Exclusive

- [arena-sso.ts](apps/sim/lib/auth/arena-sso.ts), [arena-sso-path.ts](apps/sim/lib/auth/arena-sso-path.ts), [arena-sim-resume.ts](apps/sim/lib/auth/arena-sim-resume.ts)
- [legacy-session-cookie-clears.ts](apps/sim/lib/auth/legacy-session-cookie-clears.ts), [session-cookie-domain.ts](apps/sim/lib/auth/session-cookie-domain.ts)
- [apps/sim/lib/oauth/custom-app-config.ts](apps/sim/lib/oauth/custom-app-config.ts), [custom-apps.ts](apps/sim/lib/oauth/custom-apps.ts)
- Organization OAuth app tables (`organizationOauthApps`, `oauthCustomAppState`)

### Better base

Take upstream’s refresh, revocation, and credential-service behavior as the base. The Zoom admin scope list and HubSpot portal alias are small data additions on top. Rewriting `oauth.ts` to hold the admin scope array in the middle of their refresh logic is how Zoom reconnects get lost on the next OAuth fix.

Arena SSO resume is ours. Upstream has no hub SSO. Keep those modules. The proxy should call them and otherwise stay upstream’s proxy (security headers, session gate, deployment shape).

### Split

| File | Class | Seam |
|---|---|---|
| `arena-sso.ts`, `arena-sim-resume.ts`, cookie helpers, `custom-apps.ts` | Already separate | |
| `auth.ts` trusted origins and session hook | Can be split | Better Auth `trustedOrigins` accepts a list. Build it in `arena-sso-path.ts`. The session hook should call `lib/billing/arena` and return. |
| `oauth.ts` Zoom / ads provider objects | Can be split | `lib/oauth/arena-providers.ts` merged into their provider map. |
| `credential-service.ts` HubSpot alias | Can be split | A provider-specific resolver registered next to custom apps. |
| `proxy.ts` | Can be split | The SSO redirect is already factored into `buildArenaSimResumeUrl`. Keep that call. Take upstream’s other proxy branches verbatim, including security headers. The commented `X-Frame-Options` line should not stay as a fork of their header policy. |

### Wrap

**Can wrap.** Build trusted origins in [arena-sso-path.ts](apps/sim/lib/auth/arena-sso-path.ts) and pass that list into their Better Auth config. Merge Zoom and ads providers from a new `lib/oauth/arena-providers.ts` into their provider map. [proxy.ts](apps/sim/proxy.ts) already calls `buildArenaSimResumeUrl`. Keep that call and take the rest of their proxy. Their refresh-chain and revocation fixes then land in `oauth.ts`. They do not land while the admin scope list and hub origins are edited into the bodies of `oauth.ts` and `auth.ts`.

## 6. Schema

### Overrides

[packages/db/schema.ts](packages/db/schema.ts) is one Drizzle barrel. Upstream’s file on fork `main` is 7,986 lines. Ours is 8,413. The extra tables are ours. The snapshot JSON under `packages/db/migrations/meta` was also edited on our side (`0135_snapshot.json`), while upstream has since rewritten the migration history (about 932k lines of snapshot and journal difference versus our tree, because we never took those files).

### Both sides

Upstream’s intent: generated, ordered migrations and snapshots that match `schema.ts`. Numbers `0116`, `0148`, `0239`, `0248`–`0252`, `0294`, and `0295` already belong to unrelated upstream changes.

Our intent: append product tables and hand-written SQL.

These are the collisions. Same number, different change:

| Our file | Upstream file with the same number |
|---|---|
| `0116_populate_user_knowledge_base.sql` | `0116_flimsy_shape.sql` |
| `0148_prompt_config.sql` | `0148_aberrant_venom.sql` |
| `0239_help_support_issue.sql` | `0239_wel_logs_desc_index_and_redundant_drops.sql` |
| `0248_local_copilot.sql` and `0248_workspace_is_personal.sql` | `0248_limit_notifications.sql` |
| `0249_local_copilot_user_access.sql` | `0249_drop_permission_group_applies_to_all_workspaces.sql` |
| `0250_local_copilot_user_access_trigger.sql` | `0250_workspace_forking.sql` |
| `0251_local_copilot_user_access_local_only.sql` | `0251_wakeful_smiling_tiger.sql` |
| `0252_chat_deployment_type.sql` | `0252_remove_a2a.sql` |
| `0294_local_copilot_gemini_3_8_flash.sql` | `0294_workable_jigsaw.sql` |
| `0295_local_copilot_vertex_models.sql` | `0295_chilly_franklin_storm.sql` |

`Arena_0258_*` through `Arena_0293_*` use a prefix, so the filename does not collide. Drizzle’s journal still has to order them after upstream’s latest, or migrate will apply the wrong chain.

### Exclusive tables

Added on our schema and absent from upstream’s product model:

- Local copilot: conversations, messages, tool calls, patches, audit logs, user access, user memory
- Skill share: `skillService`, `skillShareCatalog`, copies
- Deployed chat: `deployedChat`, `chatPromptFeedback`, `workflowQueries`, `agentDepartments`, `bannerMessages`
- Arena identity and CRM-ish summaries: `userArenaDetails`, `clientOrganization`, `clientDetails`, `clientChannelMapping`, `arenaTaskSummary`, slack/gmail/meeting/overall summaries
- Ops: `promptConfig`, `masterConfig`, `helpSupportIssue`, `defaultUserWorkflows`, `userKnowledgeBase`, `accountTokens`, `channelAccounts`, `outreachUserConnectionsV1`
- Workspace: `isPersonal` on the workspace table
- Deployment bookkeeping we added in-tree: `workflowDeploymentVersion`, `workflowDeploymentOperation`, `idempotencyKey`, `outboxEvent`, `organizationOauthApps`

Confirm each of `workflowDeploymentVersion`, `idempotencyKey`, and `outboxEvent` against upstream schema before re-adding. Upstream’s application layer may already have equivalents under different names. If it does, use theirs.

### Better base

Upstream’s `schema.ts` plus their migration journal is the better base. Our snapshot edits and reused numbers will not apply cleanly on a database that has already run upstream `0248_limit_notifications`. After the merge, generate new migrations from a schema that is upstream’s file plus our table definitions.

### Split

| File | Class | Seam |
|---|---|---|
| Hand-written `Arena_*.sql` | Already separate by name | Still re-number them so the journal sorts after upstream’s head. |
| Numbered `01xx` / `02xx` SQL above | Stuck | They occupy upstream’s migration ids. Replace them. Do not merge the file. |
| `schema.ts` | Can be split | Move Arena tables into `packages/db/schema/arena.ts` and re-export from `schema.ts`. The barrel import is the only line that conflicts. Drizzle still needs one schema entrypoint. |
| `migrations/meta/*_snapshot.json` | Stuck | Generated. Regenerate from the merged schema. Do not hand-merge snapshots. |

### Wrap

**Cannot wrap** their migration journal. SQL files that reuse numbers `0116`, `0148`, `0239`, `0248`–`0252`, `0294`, and `0295` block their migrations of the same numbers.

The closest equivalent is additive. Take their `schema.ts` and snapshots, then re-export Arena tables from `packages/db/schema/arena.ts`. Their schema fixes arrive. Our tables stay.

## 7. Workflow engine

### Overrides

- [apps/sim/executor/execution/engine.ts](apps/sim/executor/execution/engine.ts) — a Response block inside a loop continues the loop; a Response outside a loop still ends the workflow. Empty `forEach` still routes the sentinel end so the block after the loop runs. Terminal blocks inside a loop trigger the sentinel end.
- [apps/sim/providers/models.ts](apps/sim/providers/models.ts) — about +2,466 / −2,482 versus the last sync. We commented out a large set of Claude, Azure, and GPT ids and added an Azure Anthropic provider (`azure-anthropic/claude-sonnet-4-5` and others) plus search-preview and mini ids. Pricing for Bedrock Claude Opus was edited.
- [apps/sim/blocks/registry-maps.ts](apps/sim/blocks/registry-maps.ts) and [apps/sim/tools/registry.ts](apps/sim/tools/registry.ts) — registration of our blocks and tools, also touched by upstream’s own registry growth.
- Existing blocks we expanded in place: [slack.ts](apps/sim/blocks/blocks/slack.ts), [hubspot.ts](apps/sim/blocks/blocks/hubspot.ts), [image_generator.ts](apps/sim/blocks/blocks/image_generator.ts), [google_slides.ts](apps/sim/blocks/blocks/google_slides.ts), [zoom.ts](apps/sim/blocks/blocks/zoom.ts), [shopify.ts](apps/sim/blocks/blocks/shopify.ts).
- [apps/sim/lib/workflows/editing/validation.ts](apps/sim/lib/workflows/editing/validation.ts) and copilot `edit-workflow` — nested subflow checks described in [NESTED_LOOPS_CHANGES.md](NESTED_LOOPS_CHANGES.md).
- [apps/sim/lib/logs/execution/logger.ts](apps/sim/lib/logs/execution/logger.ts) and [apps/sim/stores/terminal/console/store.ts](apps/sim/stores/terminal/console/store.ts) — richer run output for charts, images, and actor attribution.
- [packages/deployment-config/src/integrations.json](packages/deployment-config/src/integrations.json) — catalog entries for Arena, Bing Ads, Facebook Ads, and the other exclusive integrations.

### Both sides

Upstream’s intent on the engine and registries is variable-resolution performance, files provenance, and a model catalog that matches what providers actually ship (`v0.9.14` is the current fork `main` tip). They also keep adding blocks through `registry-maps.ts`. Our intent on `models.ts` is an allowlist: hide models we do not sell, add Azure Anthropic and image models. Our intent on the engine is loop semantics (Response-in-loop, early `forEach` exit, nested loops) that upstream still rejects in the editor.

### Exclusive

Blocks that do not exist upstream: `arena.ts`, `arena-development.ts`, `bing_ads.ts`, `facebook_ads.ts`, `google_ads_v1.ts`, `figma.ts`, `chart_generator.ts`, `image_fusion.ts`, `development.ts`, `cost.ts`.

Handlers: [chart-generator-handler.ts](apps/sim/executor/handlers/chart-generator/chart-generator-handler.ts), [cost-handler.ts](apps/sim/executor/handlers/cost/cost-handler.ts), [get-my-credential.ts](apps/sim/executor/handlers/credential/get-my-credential.ts), [memory-utils.ts](apps/sim/executor/handlers/agent/memory-utils.ts).

[apps/sim/lib/image-generation](apps/sim/lib/image-generation) and [apps/sim/lib/chart-generation](apps/sim/lib/chart-generation) are new libraries behind those blocks.

### Better base

Upstream’s `models.ts` and `providers/registry.ts` are the better catalog. Commenting out their model ids inside the file guarantees a conflict on every model they add, and it hides models their blocks already reference. Keep their list. Apply an Arena allowlist in one function that filters what the UI shows.

Upstream’s executor is the better base for scheduling, cancellation, and provenance. Our Response-in-loop and empty-`forEach` sentinel behavior is a real product rule. It should be a named branch we can re-apply, not a silent rewrite of “terminal block” handling. Read `engine.ts` against their current loop orchestrator before porting. Their orchestrator moved after 18 Sep (`apps/sim/executor` is in the overlap, 22 files).

Slack, HubSpot, image generator, Google Slides, Zoom, and Shopify blocks exist on both trees. Take their block definition as the base and re-apply only our extra operations (Slack search/auth user, HubSpot types, Slides template tables, Zoom transcript tools, image reference files). New tool files under `tools/hubspot`, `tools/shopify`, `tools/google_slides`, and `tools/zoom` are already the right shape.

Nested loops: upstream still forbids nesting in validation and in the copilot edit tool. If we still need nesting, that is an intentional override of their validation, documented in `NESTED_LOOPS_CHANGES.md`. It is not something to resolve by keeping our older copy of `edit-workflow`.

### Split

| File | Class | Seam |
|---|---|---|
| Exclusive block files, `lib/image-generation`, `lib/chart-generation`, chart/cost/credential handlers | Already separate | Register them. |
| `blocks/registry-maps.ts`, `tools/registry.ts` | Can be split | Our ids appended in one Arena registry fragment imported at the bottom. |
| `providers/models.ts` | Stuck until extracted | Commented-out ids and the Azure Anthropic provider are in their catalog. Add `arena-models.ts` for ids we add, and an allowlist filter for ids we hide. |
| `executor/execution/engine.ts` | Stuck | Response-in-loop and sentinel-end routing are inside the walk. There is no hook. Extract `continueLoopAfterTerminal(node)` and keep the rest of their engine. |
| `edit-workflow/index.ts`, `editing/validation.ts` | Stuck | Nested-subflow rejection is an in-place `if`. A single `allowsNestedSubflow(parent, child)` predicate is the seam. |
| `slack.ts`, `hubspot.ts`, `image_generator.ts`, `google_slides.ts`, `zoom.ts`, `shopify.ts` | Can be split | Extra operations as new files under `tools/<service>/`, same as Unipile. Shrink the block file back toward upstream and point `subBlocks` at our tools. |
| `integrations.json` | Can be split | Arena integration entries in a JSON fragment merged at build. The file is a generated catalog and will conflict in full. |
| `logger.ts`, console store | Can be split | Log chart and image payloads through the existing output normalizer instead of special cases in the logger. |

### Wrap

**Can wrap** the model catalog and the registries. Filter their [models.ts](apps/sim/providers/models.ts) with an Arena allowlist, and import an Arena registry fragment from `blocks/registry-maps.ts` and `tools/registry.ts`. New Slack, HubSpot, Slides, Zoom, and Shopify operations wrap by living in new tool files registered beside theirs, so their block fixes still apply.

**Cannot wrap yet** for Response-inside-a-loop in [engine.ts](apps/sim/executor/execution/engine.ts) and the nested-subflow checks in `edit-workflow` and `editing/validation.ts`. Those sit inside their walk. Add `continueLoopAfterTerminal` and `allowsNestedSubflow` once. After that, the rest of their engine updates flow through.

## 8. Exclusive integrations and tools

These trees are new. They are not overrides, except for the registry lines that publish them.

| Area | Where it lives | What it is |
|---|---|---|
| Unipile / LinkedIn | `apps/sim/tools/unipile` (30 files), `apps/sim/lib/unipile` | Posts, chats, reactions, relations, hosted auth, reconnect |
| Arena tasks | `apps/sim/tools/arena` | Tasks, comments, meetings, summaries, token |
| Ads | `blocks/bing_ads.ts`, `facebook_ads.ts`, `google_ads_v1.ts` plus `lib/internal/*-ads` | Query tools and OAuth |
| Skyvern | `apps/sim/tools/skyvern` | Create and run workflows |
| SpyFu, Semrush | `tools/spyfu`, `tools/semrush` | SEO query tools |
| Zoom extras | `tools/zoom/download_transcript.ts`, `list_account_recordings.ts`, `get_account_recordings_with_transcript.ts` | Admin recordings. The Zoom block itself is an override. |
| Image | `tools/image_generation`, `tools/google/imagen.ts`, `nano-banana.ts`, `blocks/image_fusion.ts` | Multi-model image generation and fusion |
| Charts | `lib/chart-generation`, `blocks/chart_generator.ts` | ECharts output in chat |
| Slides and docs | `tools/google_slides/templates`, `tools/presentation`, `tools/p2_docs` | Template decks and P2 icon/user lookups |
| Generated apps | `lib/development`, `tools/development`, `tools/arena-development`, `blocks/development.ts` | Generate and edit an app, deploy to Vercel |
| Figma | `blocks/figma.ts`, `tools/figma` | Figma operations |
| Cost | `blocks/cost.ts`, `executor/handlers/cost` | Explicit cost block |
| Gmail, Drive, Slack extras | `tools/gmail/advanced_search.ts`, `read_thread.ts`; `tools/google_drive/upload_file.ts`, AI query helpers; `tools/slack/search_all.ts`, `get_user_channels.ts` | Extra operations on integrations upstream already has |

### Both sides

Upstream keeps growing the same registries and `integrations.json`. Their intent is one catalog. Our intent is to add products they do not ship. The conflict is the insertion point, not the tool implementation.

### Better base

For integrations that exist upstream (Slack, HubSpot, Shopify, Gmail, Drive, Zoom, image generate, Google Slides), their tool params, auth mode, and block schema are the better base. Our extra actions should be new tool files registered beside theirs. Replacing `slack.ts` (+820 / −505) or `hubspot.ts` (+702) with our copy drops their later operations.

Unipile, ads, Skyvern, SpyFu, Arena tasks, chart generator, image fusion, and generated-app development have no upstream equivalent. Keep ours.

### Split

Exclusive tool directories are **already separate**. The stuck part is only:

- `tools/registry.ts`
- `blocks/registry-maps.ts`
- `packages/deployment-config/src/integrations.json`
- the existing block files listed in section 7

Register exclusive tools from an `arena-tools` index so a future registry rewrite is a single import.

### Wrap

**Wraps today** for tools that exist only on our side. They are new files. There is no upstream body to miss a fix from. Register them from one Arena index so their registry rewrite stays a single import.

**Can wrap** where we extended an integration they already ship (extra Gmail, Drive, Slack, and Zoom actions): new files under `tools/<service>/`, with their existing tool files left intact. Replacing `slack.ts` or `hubspot.ts` does not wrap, and their later operations never arrive.

## 9. Skill share, files, and admin

### Overrides

Shared file and copilot file paths we touched:

- [apps/sim/app/api/files/serve/[...path]/route.ts](apps/sim/app/api/files/serve/[...path]/route.ts) — serving generated images and compiled documents
- [apps/sim/lib/copilot/tools/server/files/create-file.ts](apps/sim/lib/copilot/tools/server/files/create-file.ts)
- File upload sub-block in the editor (`file-upload.tsx`, +476 / −89) — conversation refs in file upload (`e730f2bcc2`)

Upstream’s intent on file serve and create-file is a single storage path with provenance. Our intent is chat image preview, org logos, and document compile.

### Exclusive

- Skill share: [apps/sim/lib/skill-share](apps/sim/lib/skill-share) and `app/api/admin/skill-share/**`. Share a skill catalog across workspaces and orgs (`c84243c598`). This follows the application-operation shape (operations, use cases, repository) and should stay that way.
- Uploads: [org-logos/utils.ts](apps/sim/lib/uploads/contexts/org-logos/utils.ts), [compile-document.ts](apps/sim/lib/uploads/utils/compile-document.ts), [image-storage.server.ts](apps/sim/lib/uploads/utils/image-storage.server.ts)
- File viewer previews added under the workspace files UI (PDF, SVG, generating-preview)
- Help and support issue table and API
- App banner route and workspace embed page

### Better base

Upstream’s file-serve route and storage layout are the better base. Provenance and auth on `files/serve` have moved with the rest of `apps/sim/lib`. Put image compilation and org logos behind the existing upload context interface (`lib/uploads/contexts/`). Do not special-case paths inside the serve route.

Skill share is ours. There is no upstream feature to prefer.

### Split

| File | Class | Seam |
|---|---|---|
| `lib/skill-share/**`, admin skill-share routes, org-logos, compile-document, image-storage | Already separate | |
| `api/files/serve/[...path]/route.ts` | Can be split | Resolve Arena image and compiled-doc paths in `image-storage.server.ts`. The route calls the resolver. |
| Editor `file-upload.tsx` | Stuck until extracted | Conversation-ref picking is inside their upload component. A `references` slot or a wrapper used only by chat-backed blocks is the seam. |
| `create-file.ts` | Can be split | Same as local copilot file tools. |

### Wrap

**Wraps today** for skill share, org logos, and document compile. They are new modules with no upstream counterpart, so there is nothing of theirs to lose.

**Can wrap** file serving. Keep their `files/serve` route and resolve Arena image and compiled-doc paths in [image-storage.server.ts](apps/sim/lib/uploads/utils/image-storage.server.ts). Their provenance and auth fixes on that route then apply to Arena files. The editor `file-upload.tsx` conversation-ref behavior cannot wrap until a slot exists.

## 10. Deploy and CI

### Overrides

- [.github/workflows/ci.yml](.github/workflows/ci.yml) — jobs `resolve-ghcr-tag` and `build-ghcr-branch` publish `ghcr.io/<owner>/p2-sim-simstudio`, `p2-sim-migrations`, and `p2-sim-realtime`.
- [apps/sim/package.json](apps/sim/package.json), root [package.json](package.json), [apps/sim/next.config.ts](apps/sim/next.config.ts) — Arena docs rewrite to `/arena-ai-docs`, dependency pins.
- [apps/sim/.env.example](apps/sim/.env.example) — Arena, Zoom admin, Unipile, and billing env keys.
- [docker-compose.prod.yml](docker-compose.prod.yml) and local compose files — small deltas on upstream compose.

### Exclusive

- [docker-compose.p2prod.yml](docker-compose.p2prod.yml)
- [docker-compose.test-env.yml](docker-compose.test-env.yml), [docker-compose.sandbox.yml](docker-compose.sandbox.yml), [docker-compose.dev-env.yml](docker-compose.dev-env.yml), [docker-compose.local-build.yml](docker-compose.local-build.yml)
- [apps/sim/scripts/upsert-env-var.ts](apps/sim/scripts/upsert-env-var.ts) and the GHCR tag script referenced by CI

### Both sides

Upstream CI is their test and release pipeline. Our intent is a second pipeline that tags images for this fork’s registry. Both are written into `ci.yml`, so their workflow edits and our GHCR jobs conflict as one file.

### Better base

Take upstream `ci.yml`, `package.json`, and `next.config.ts` as the base. Our GHCR build does not need to live in their workflow. Env examples should gain Arena keys in a clearly marked block, not a rewrite of their example.

`next.config.ts` rewrites for `/arena-ai-docs` and the legal-page redirects are ours and are fine as a small addition on their config. The proxy SSO behavior is covered in section 5.

### Split

| File | Class | Seam |
|---|---|---|
| `docker-compose.p2prod.yml` and the other `docker-compose.*.yml` we added | Already separate | |
| `.github/workflows/ci.yml` GHCR jobs | Can be split | Move `resolve-ghcr-tag` and `build-ghcr-branch` to `.github/workflows/ghcr.yml`. |
| `next.config.ts` docs rewrite | Can be split | One `rewrites()` entry. |
| `package.json` files | Stuck if we pin by editing | Take their dependency set. Add only packages our exclusive tools import, in a reviewable diff. |
| `.env.example` | Can be split | Append an Arena section. Do not reorder their keys. |

### Wrap

**Can wrap.** Move the GHCR jobs out of their [ci.yml](.github/workflows/ci.yml) into `.github/workflows/ghcr.yml`. Their test and release fixes then land in `ci.yml`, and our image publish stays. The compose files we added already wrap by being separate files. `next.config.ts` wraps if the Arena docs rewrite is one entry on their config. `proxy.ts` wraps if the only Arena line is the existing `buildArenaSimResumeUrl` call. Editing `package.json` dependency pins in place does not wrap.

## Conflict index

588 files changed on both sides since 18 Sep. Default class by area, then the exceptions that need a human during the merge.

| Area | Overlap count | Default class | Do this |
|---|---|---|---|
| `apps/sim/lib` | 228 | Take upstream, re-apply seams from sections 3–7 | Highest count. Mostly copilot, billing, oauth, workflows, uploads. |
| `apps/sim/app` | 176 | Take upstream UI shell | Exception: deployed chat page and chat route (section 2). After taking upstream `panel.tsx`, put `LaunchDeployedChat` back beside Run. |
| `apps/sim/tools` | 33 | Take upstream tool, keep our new files | Registry import is the seam. |
| `apps/sim/blocks` | 26 | Take upstream block files | Re-register exclusive blocks. |
| `apps/sim/executor` | 22 | Take upstream engine | Re-apply Response-in-loop only. |
| `apps/sim/hooks` | 15 | Take upstream | OAuth connection hooks: re-apply HubSpot alias via custom apps. |
| `apps/sim/providers` | 13 | Take upstream `models.ts` | Add Azure Anthropic and the allowlist beside it. |
| `apps/docs` | 10 | Take upstream | Keep the docs title. |
| `apps/sim/components` | 9 | Take upstream | `icons.tsx` and settings nav are the exceptions. |
| `apps/sim/stores` | 9 | Take upstream | Console store chart/image cases move to presenters. |
| `apps/sim/ee` | 8 | Take upstream whitelabel and retention | Use whitelabel for the product name. |
| `packages/db` | 5 | Take upstream schema and snapshots | Re-add tables. Drop colliding migration numbers. |
| `packages/emcn` | 5 | Take upstream | Do not fork the design system. |
| CI, `package.json`, `proxy.ts`, `next.config.ts`, compose | a handful | Take upstream | GHCR workflow file, proxy SSO call, docs rewrite. |

Files that stay **stuck** until someone extracts the branch. These are the ones that will conflict again on the merge after this one if we re-patch them in place:

- `apps/sim/app/api/chat/[identifier]/route.ts`
- `apps/sim/executor/execution/engine.ts`
- `apps/sim/providers/models.ts`
- `apps/sim/lib/billing/core/usage-log.ts`
- `apps/sim/lib/copilot/request/lifecycle/run.ts` (and `start.ts` / `finalize.ts` if the hosted-flag edits stay in the body)
- `apps/sim/lib/copilot/tools/server/workflow/edit-workflow/index.ts`
- `apps/sim/lib/workflows/editing/validation.ts`
- `apps/sim/lib/workflows/streaming/streaming.ts`
- Sidebar render files in section 1
- Editor `file-upload.tsx`
- Generated `packages/db/migrations/meta/*_snapshot.json`

Everything exclusive in sections 3, 4, 8, and 9 can come back as new files after upstream is applied. The merge pain is the stuck list plus the three registries (`blocks/registry-maps.ts`, `tools/registry.ts`, `integrations.json`).
