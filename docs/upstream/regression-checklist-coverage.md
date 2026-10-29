# Manual regression checklist ↔ automated coverage

Manual QA workbooks (regenerate both via [generate-regression-qa-xlsx.py](./generate-regression-qa-xlsx.py)):

- [manual-regression-checklist-qa.xlsx](./manual-regression-checklist-qa.xlsx) — deduped, with Steps / Expected behaviour
- [manual-regression-checklist-updated.xlsx](./manual-regression-checklist-updated.xlsx) — one row per checkbox in [manual-regression-checklist.md](./manual-regression-checklist.md)

Current workbooks: 147 checkbox rows (P0 89, P1 37, P2 21) and 138 deduped QA rows.

Snapshot below is the 2026-10-14 automated pass (~135 bullets). The 2026-10-28 checklist additions are manual cases for branch fixes; they are not new unit tests.

## Cases added or tightened on 2026-10-28

Fixes on `upstream-sync/2026-10-14` after the first checklist. New rows are manual. Tightened rows keep their old automation status.

| Checklist item | Why it is on the sheet |
| --- | --- |
| Default theme light; dark editor popovers | New users load light. Dark-mode env-var, tag, and messages popovers stay readable. |
| Usage for every member; Insights gated | Subscription → Usage is `/settings/arena-usage` for every member. Billing redirects non-admins there. Organization → Insights stays on `/settings/usage`. |
| Visitor without a workspace seat still runs | Deployed chat may use workspace secrets without a seat in that workspace. |
| Base64 / refresh / image edit | Images render as images in deployed chat, the builder chat, and the feedback view, including after refresh. “3 distinct variations” are three images. An edit returns an image preview. |
| Second turn does not show “Run not found” | A later Cloud turn, and a Local turn that reconnects, complete. Local is not reattached to the Cloud worker. |
| Finished reply scroll does not invent bold | Scrolling a finished Copilot reply does not turn `*` into bold. |
| Fetch-and-send sequence is canvas blocks | Calendar, Gmail, and Slack are their own blocks (`google_calendar_v2`, `gmail_v2`, `slack`). A daily trigger is `schedule`. |
| Copilot HTML file | The saved HTML page opens as a page. |
| `X-Sim-Email` bills the named org once | Deploy samples include the header. The named user’s org is debited once and shows a By Agent row. Unknown email is `BILLING_EMAIL_NOT_FOUND`. |
| Slack Arena Bot and one Connect control | Auth method says Arena Bot. Copilot connect is one Continue control, not Submit. |
| HubSpot Accounts picker | Admin workspaces load portals and a selected account can read. |
| Google Ads v26 | Search still returns `results` as an array on v26. |
| Reused chat image file path | A later run copies the image and the file opens. |
| Arena tasks on a schedule or webhook | Get my tasks and get my overdue tasks succeed from the builder and from a schedule or webhook. A failure is an error, not an empty list. |
| Agents list allow-list and undeploy | Allowed emails see the agent. Undeploy and inactive chats leave the list. |
| Video builder `emailId` and Fal usage | Only the video builder opens without `emailId`, and the logged-in email is written onto its URL. Fal calls land on that user’s ledger. |
| Custom OAuth Apps section and agent access requests | The settings section renders. A platform admin can approve a request. |

## Cases added on 2026-10-29

| Checklist item | Why it is on the sheet |
| --- | --- |
| Local fork still opens a new chat when the worker has no conversation | The 2026-10-14 sync made the worker conversation copy mandatory. Arena Copilot keeps the transcript in Sim, so a worker “chat not found” must not fail the fork. Cloud fork still requires the worker copy. Automated in `apps/sim/app/api/mothership/chats/[chatId]/fork/route.test.ts`. |

## Automated snapshot (2026-10-14)

| Status | Count (≈135 bullets) |
| --- | ---: |
| COVERED | 24 |
| PARTIAL | 50 |
| MISSING | 17 |
| MANUAL_ONLY | 44 |

## Per section

| Section | Covered | Partial | Missing | Manual-only |
| --- | ---: | ---: | ---: | ---: |
| 0 Post-sync gates | 1 | 5 | 2 | 4 |
| 1 Customized Arena | 11 | 22 | 5 | 14 |
| 2 Exclusive Arena | 6 | 11 | 5 | 13 |
| 3 Stock Sim | 6 | 12 | 5 | 13 |

## Strongest automated areas

- Arena billing policy (`lib/billing/arena/*`)
- Deployed chat inactive/unauthorized 403 (`app/api/chat/[identifier]/route.test.ts`)
- Arena SSO resume (`lib/auth/arena-sim-resume.test.ts`, `arena-sso.test.ts`)
- Response-in-loop (`executor/execution/engine.test.ts`)
- Cost / usage-limit gates

## Gaps closed in this pass

| Checklist item | New / extended test |
| --- | --- |
| Google Ads `results` as array | `apps/sim/tools/google_ads/search.test.ts` |
| Shopify `success` still available | `apps/sim/tools/shopify/list_customers.test.ts` |
| Local / Cloud allowlist + local-only | `apps/sim/local-copilot/lib/routing.test.ts` |
| OpenRouter free-only agent picker | `apps/sim/blocks/utils.test.ts` (`getAgentModelOptions`) |
| Empty `forEach` still runs next block | `apps/sim/executor/execution/engine.test.ts` |
| Upgrade comparison overlay | `apps/sim/lib/billing/arena/upgrade-comparison.test.ts`, `upgrade-presenter.test.ts` |
| Legacy session cookie clear | `apps/sim/lib/auth/legacy-session-cookie-clears.test.ts` |
| Workspace forks stay hidden | `apps/sim/components/settings/navigation.test.ts` |

## Still manual / credential-bound (high value, not unit-testable here)

- Deployed chat UI (theme, threads rename/reload, golden query insert, voice absent)
- Builder panel Launch button (present only for a chat or app deployment; Run stays in-builder execution)
- Live OAuth connects (Zoom, Facebook Ads, Bing Ads, HubSpot portal)
- Arena task block happy paths (need Arena API)
- Exclusive block live runs (Figma, Image Fusion, P2 Docs, SpyFu, Airweave, …)
- Builder drag/connect, realtime second user, schedule/webhook live fire
- CreditsChip / help-menu absence in empty-state chrome (CreditsChip is unused; help moved under Settings)

## Suggested next automations

1. Config route assert for `canSwitchBackend` (full-access vs local-only).
2. Output-contract dump in CI against `version-6.2-main` baseline.
3. Thin Arena task tool `transformResponse` tests with mocked HTTP (one op per group).
4. Image Fusion / P2 Docs / SpyFu output-contract smoke (no live calls).
