# Arena vs Sim manual regression checklist

Use this as a backup pass after a deploy or an upstream merge. Mark each item Pass / Fail / N/A. Priority is **P0** (breaks the product if it fails), **P1** (Arena-specific or a customized integration), **P2** (stock Sim smoke).

Sources: [ARENA-NOTES.md](../../.agents/ARENA-NOTES.md), [version-6.1-main-vs-main.md](./version-6.1-main-vs-main.md), [sync-2026-10-07.md](./sync-2026-10-07.md), [sync-2026-10-14.md](./sync-2026-10-14.md), and the live registry in [registry-maps.ts](../../apps/sim/blocks/registry-maps.ts).

| Field | Value |
| --- | --- |
| Date | |
| Environment URL | |
| Org | |
| Plan | |
| User role | |
| Tester | |

Intentionally off in Arena (confirm they stay hidden): workspace forks, custom blocks, BYOK, chat keys, Sim Mailer, the help menu, voice on deployed chat, home empty-state CreditsChip, and the Presentation block (commented out of `ARENA_CUSTOM_BLOCK_REGISTRY`).

Failures in section 1 or 2 are Arena regressions. Failures in section 3 are base Sim regressions.

---

## 0. Post-sync gates (P0)

Run these before manual product QA when the build is an upstream sync candidate. Record the command output or CI link.

- [ ] Target environment applied migrations cleanly (deploy / migrate job green; no duplicate migration-number errors).
- [ ] Output-contract dump vs pre-sync baseline: no unexplained removed paths or type changes beyond the sync report.
- [ ] `bun run apps/sim/scripts/check-block-registry.ts <previous-product-ref>` passes subblock ID stability (meta coverage failures documented if any).
- [ ] Known type-check debt noted: dual Next.js `NextRequest` identity in `*.integration.ts` (not a new Arena regression unless the file list grows).

### Sync-specific smoke (update per sync report)

From [sync-2026-10-07.md](./sync-2026-10-07.md) and [sync-2026-10-14.md](./sync-2026-10-14.md):

- [ ] Deployed chat: golden queries insert; reply can show thinking / tool-call segments when the workflow enables them; thread rename persists after reload.
- [ ] Inactive or unauthorized deployed chat returns 403 and does not write a new execution log row (count logs before and after).
- [ ] Usage log still carries Arena attribution after the payer-prefix / `createdAt` merge; one chat and one Local Copilot turn both appear on the ledger.
- [ ] Airweave: block visible and one successful run, or N/A with ticket reference if product does not ship it.
- [ ] In-process tools after `directExecution` removal: Chart Generator, P2 Docs, Google Slides create-from-template, Google Drive search each run once.
- [ ] Google Ads search: downstream blocks consume `results` as an array.
- [ ] Shopify list/get workflows still map outputs, including restored `success` where used.
- [ ] Integration detail pages for `arena`, `bing_ads`, `figma`, `image_fusion`, `p2_docs`, `spyfu` either show usable meta or an accepted empty state for this release.

---

## 1. Customized — Sim behavior Arena changed

These exist upstream. Verify the Arena change still works, and that the original Sim path still works beside it.

### Identity and shell (P0)

- [ ] Product shows Arena branding (logos, favicon, “Arena key” instead of “Sim key”, docs title P2 Agents Docs).
- [ ] Sidebar shows Usage. Billing is visible only to org admins.
- [ ] “Back to Arena agents” returns to the Arena hub.
- [ ] Help menu stays hidden.
- [ ] `/workspace/arena-general-settings` opens user preferences without a workspace id. Workspace `/settings/general` is unchanged.
- [ ] Home empty state does not show the CreditsChip (billing remains under Usage / org admin paths).

### Sign-in and OAuth (P0)

- [ ] Unauthenticated agent traffic redirects to Arena SSO and resumes back into Sim.
- [ ] Hub origins can call credentialed APIs. Legal pages redirect to Arena URLs.
- [ ] Session create still supersedes a Starter subscription when a paid plan is active.
- [ ] Zoom user app and Zoom admin app both connect (admin scopes, recordings, transcripts).
- [ ] Facebook Ads and Bing Ads OAuth scopes connect.
- [ ] HubSpot shared-portal alias still resolves the right credential.

### Deployed chat (P0)

The public chat page uses `ArenaDeployedChat`, not upstream `ChatClient`.

- [ ] Open a deployed agent: landing, welcome CTAs, theme, and department label render.
- [ ] Send a message and receive a streamed reply. Charts render (ECharts). Generated images appear and can be reused.
- [ ] Threads: create, switch, rename, and reload history. History does not require a webhook or schedule.
- [ ] Golden queries load and can be inserted.
- [ ] Feedback submit and the feedback view work.
- [ ] Knowledge references stay on the reply after refresh.
- [ ] Inactive or unauthorized chat returns an error and does not write a junk execution log.
- [ ] Voice controls stay absent.
- [ ] Workflow builder right panel: a chat or app deployment shows **Launch** (lightning) beside **Run**. Launch opens that deployment (`/chat/{identifier}?fromControlBar=true`, or the app redirect in a new tab). A workflow with no chat deployment does not show Launch. **Run** still executes the workflow in the builder.

### Workspace chat and Local / Cloud copilot (P0)

- [ ] Workspace home chat streams a reply (theme, charts, and usage attribution still present).
- [ ] Allowlisted users see the Local / Cloud switch on workspace home and on the workflow Copilot tab.
- [ ] Local send uses Arena Copilot (local model reply). Cloud send uses Mothership when `COPILOT_API_KEY` is configured.
- [ ] Local model picker selection persists as the user default; session memory inspector appears on longer Local threads.
- [ ] Local-only users stay on Local without the switch.
- [ ] Copilot can generate images and create files; Local image/file usage lands on the Arena ledger.
- [ ] Floating workflow chat streams a run, including chart and image output.
- [ ] Deploy-modal chat preview matches the deployed agent.

### Billing and workspaces (P0)

- [ ] Arena plans show in upgrade: Starter, Pro, Max (flat org pricing). Checkout ignores the Starter Stripe id.
- [ ] Paying supersedes Starter. Client-org Starter provisioning still runs.
- [ ] Credits-per-dollar and remaining credits: start from a known balance, run one Agent turn, confirm the usage dashboard debit matches the ledger entry.
- [ ] Cost block: an explicit Cost block amount shows once on the run’s usage (no double charge vs the Agent model cost).
- [ ] Usage-log multiplier: a metered tool run writes one scaled ledger row, not a raw plus scaled duplicate.
- [ ] Org admin can open billing. A non-admin cannot.
- [ ] Signup still creates a personal workspace. `/workspace` fallback still lands somewhere valid.
- [ ] Daily credit refresh stays off unless the environment explicitly enables it.

### Workflow engine (P1)

- [ ] A Response block inside a loop continues the loop. A Response outside a loop ends the workflow.
- [ ] An empty `forEach` still runs the block after the loop.
- [ ] Nested loops and nested subflows save and run (upstream rejects these; Arena allows them).
- [ ] Agent model picker: OpenRouter list is free-only; Azure Anthropic and Arena-added image models still appear where expected.
- [ ] Run logs and the console show chart payloads, image payloads, and the acting user.

### Extended integrations (P1)

Upstream blocks with extra Arena operations. Spot-check one extra op and one stock op on each.

- [ ] Slack: search and user-channel lookup, plus a normal post.
- [ ] HubSpot: `hubspot_get_campaign_metrics` (or another campaign op), plus stock `hubspot_list_contacts`.
- [ ] Google Slides: template tables, plus a stock slide action.
- [ ] Zoom: account recordings and transcript download, plus a stock meeting action.
- [ ] Shopify: `shopify_list_customers` (assert `success` still available downstream), plus stock `shopify_list_products`.
- [ ] Gmail: advanced search and read thread, plus send or read.
- [ ] Google Drive: upload and AI query helpers, plus a stock file read.
- [ ] Image Generator: multiple variations from one prompt (“three variations”), reference images, and picking a previously generated image from the conversation.

### Files (P1)

- [ ] Generated images and compiled documents open from the file serve route.
- [ ] Org logo upload and display work.
- [ ] Editor file upload can pick images already in the chat.

---

## 2. Exclusive — Arena-only

These do not exist in upstream Sim. A missing entry here is a dropped Arena feature.

### Local copilot runtime (P0)

Covered in section 1 for the chat switch. Also verify:

- [ ] Tool calls, patches, and audit history persist across reload.
- [ ] User access and user memory apply to the next turn.

### Arena task block (P0)

Block name **Arena**. One happy path per operation:

- [ ] Create task, create task with fields, create sub-task, create sub-task with fields.
- [ ] Add comment, add comment by task number.
- [ ] Fetch searched tasks, search task, simple search.
- [ ] Save summary, get meetings, get token.
- [ ] Get my tasks, get my overdue tasks.
- [ ] Client and project selectors in the block panel load real Arena data.

### Arena Development and generated apps (P1)

- [ ] **Arena Development** block: edit an Arena app.
- [ ] **Development** block: generate an app, edit it, and deploy to Vercel.
- [ ] Skill share: publish a skill into the catalog and use the copy in another workspace or org.

### Exclusive blocks (P1)

Confirm each appears in the block menu and one operation returns data.

- [ ] Bing Ads, Facebook Ads, Google Ads V1 (natural-language or GAQL query).
- [ ] Figma (file read or design action).
- [ ] Image Fusion (two or more images in, one fused image out).
- [ ] P2 Docs (template schema, icons, or team data).
- [ ] Semrush and SpyFu (one SEO query each).
- [ ] LinkedIn via Unipile (company or profile read, plus hosted auth / reconnect).
- [ ] Chart Generator (ECharts JSON that the chat renderer draws).
- [ ] Cost block (explicit cost on a run shows in usage).
- [ ] Skyvern (create or get a run; N/A if this env has no credential).
- [ ] Airweave: one successful run, or N/A with ticket reference (see Section 0).

### Deployed-chat extras that have no upstream equivalent (P0)

- [ ] Departments, assistant assets, banner messages, prompt feedback, and workflow golden queries.
- [ ] Thread list in the left nav and theme sync with the Arena shell.

### Admin, identity, and ops (P1)

- [ ] Arena SSO modules: login, resume, and legacy cookie clear on a user who still has an old session cookie.
- [ ] Custom OAuth apps at org level (allowed workspaces).
- [ ] Help and support issue can be filed and is stored.
- [ ] App banner route and workspace embed page render inside the host frame.
- [ ] Default workflows import and deploy for a new user.
- [ ] User knowledge base populate still attaches to the user.
- [ ] Arena general settings (timezone and events) save and apply to chat and copilot.

### Billing package only Arena has (P0)

Walk [apps/sim/lib/billing/arena](../../apps/sim/lib/billing/arena) through the UI, not the code:

- [ ] Starter provisioned for a new client org.
- [ ] Pro and Max checkout (`team_1950` / `team_6500` catalog).
- [ ] Org-admin upgrade comparison overlay.
- [ ] Seat reconcile does not fight flat org pricing.
- [ ] Usage limit blocks a run when credits are exhausted and allows it when they are not.

---

## 3. Other Sim features — stock regression

Smoke these so an Arena change did not break the base product. One happy path each unless noted. **P2** except the builder core, which is **P0**.

### Builder core (P0)

- [ ] Create, rename, duplicate, and delete a workflow. Undo and redo.
- [ ] Drag blocks, connect edges, and open the editor panel. Variables resolve (`<Block.output>`).
- [ ] Manual run, stop, and read the console. Logs page shows the same run.
- [ ] Save and reload. A second user in the same workflow sees realtime updates.
- [ ] Deploy the workflow. API trigger and chat trigger each start a run.
- [ ] Schedule trigger fires once. Webhook trigger accepts one signed request.
- [ ] Response block returns the configured body. Condition and router take the right branch.
- [ ] Loop and parallel run a small inner graph (in addition to the Arena nested-loop case above).

### Workspace surfaces (P2)

- [ ] Home, workflow list, and sidebar navigation.
- [ ] Knowledge: create a base, upload a document, and retrieve it from an Agent block.
- [ ] Tables: create a table, add a row, filter it.
- [ ] Files: upload, preview (PDF and image), and delete.
- [ ] Skills: create and attach one to an agent.
- [ ] Logs, tests, dashboards, and changelog pages load.
- [ ] Integrations catalog and a connected credential both open.
- [ ] Recently deleted: restore one workflow.

### Settings that stay on (P2)

- [ ] Account, teammates, org members, secrets, credential groups.
- [ ] Arena API keys (create, use on an API trigger, revoke).
- [ ] Custom tools, MCP tools, MCP servers, sandboxes.
- [ ] Permission groups and audit logs, if the org has enterprise.
- [ ] Subscription page matches the Arena plan from section 1.

### Agent and model path (P0)

- [ ] Agent block calls one allowed model and returns text.
- [ ] Tools the agent calls show in the trace.
- [ ] Memory on an agent survives a second run in the same thread.

### Representative stock integrations (P2)

One read or one write each, using a test account. Skip any integration this environment has no credential for.

- [ ] Google: Gmail, Calendar, Drive, Sheets, Docs.
- [ ] Microsoft: Outlook, Teams, OneDrive.
- [ ] Atlassian: Jira, Confluence.
- [ ] Dev: GitHub, Linear or Jira.
- [ ] Comms: Slack (stock post), Discord, Microsoft Teams.
- [ ] CRM: HubSpot or Salesforce (stock read).
- [ ] Data: Airtable or Notion, Postgres or the built-in table.
- [ ] AI utilities already in Sim: Search, Function, API block, Evaluator.

### Auth and tenancy (P0)

- [ ] Email sign-in and sign-out. Invite a member and accept.
- [ ] A member cannot open another org’s workspace.
- [ ] An archived workspace is not selectable.
- [ ] API key from another workspace is rejected.

---

## Suggested pass order

1. Section 0 post-sync gates (when this is a sync candidate).
2. P0 identity, SSO, deployed chat, billing, builder run, agent model.
3. P0 Local / Cloud copilot and Arena task block.
4. P1 exclusive blocks that this environment has credentials for.
5. P1 customized Slack, HubSpot, Zoom, Slides, Shopify, Gmail, Drive, image variations.
6. P2 stock surfaces and a short integration sample.
