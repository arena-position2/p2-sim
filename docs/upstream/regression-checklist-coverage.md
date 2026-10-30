# Manual regression checklist ↔ automated coverage

Manual QA workbook (regenerate via [generate-regression-qa-xlsx.py](./generate-regression-qa-xlsx.py)):

- [manual-regression-checklist-qa.xlsx](./manual-regression-checklist-qa.xlsx) — single consolidated workbook containing:
  - `Checklist` (145 deduped QA test cases with `Steps to test` and `Expected behaviour`)
  - `Summary` (priority counts and live Pass / Fail / N/A / Remaining formulas)
  - `Run info` (environment metadata, intentionally-off list, and suggested pass order)
  - `Markdown checkboxes (1-1)` (all 154 raw checkbox rows from [manual-regression-checklist.md](./manual-regression-checklist.md))
  - `Dedup log` (13 deduplication mappings)

Snapshot below is the 2026-10-14 automated pass (~135 bullets). The 2026-10-28, 2026-10-29, and 2026-10-30 checklist additions are manual cases for branch fixes. Where a row names an existing test, that test already guarded the fix. This pass does not add new unit tests.

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

## Cases added on 2026-10-30

| Checklist item | Why it is on the sheet |
| --- | --- |
| Suggested follow-up does not show “Run not found” | A follow-up clicked as the Cloud long-poll dies must wait for a live poll and complete. Automated in `apps/sim/lib/mothership/request/lifecycle/stream-retry.test.ts` and `apps/sim/lib/mothership/transport/receiver.test.ts`. |
| Stopping a running turn is not an error | Stop shows stopped. There is no error toast and no `user_stop:` text. Manual. The guard is in the home stream hooks and `apps/sim/local-copilot/integration/mothership-lifecycle.ts`. |
| Start `inputFormat` keeps reserved chat fields | Local Copilot seeds `input`, `conversationId`, and `files`, and keeps custom fields. A file input is `{ "id": "<uuid>" }`. Automated in `apps/sim/local-copilot/lib/tools/ensure-start-reserved-input-format.test.ts`. |
| Knowledge search is an Agent tool of type `knowledge` | The Agent tool is `knowledge`, not `knowledge_base`, and the workflow saves. Automated in `apps/sim/local-copilot/lib/tools/coerce-edit-agent-tools.test.ts`. |
| Knowledge reference modal stays opaque | The deployed-chat reference dialog is opaque and readable. Manual. The portaled dialog in `apps/sim/app/(interfaces)/chat/components/message/components/knowledge-results-modal.tsx` carries `deployed-chat`. |
| Local Copilot creates a workspace skill | Create, list, and delete a workspace skill from Local Copilot. Separate from skill-share publish. Automated in `apps/sim/local-copilot/lib/tools/manage-skill.test.ts`. |
| Function sandbox timeout stays at 60 minutes | A short Function run completes. A longer timeout is capped at 60 minutes so E2B does not reject the sandbox lifetime. Manual. The cap is `DEFAULT_EXECUTION_TIMEOUT_MS` in `apps/sim/lib/execution/constants.ts`. |

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
