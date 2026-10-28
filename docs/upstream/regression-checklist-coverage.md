# Manual regression checklist ↔ automated coverage

Manual QA workbook (deduped, with Steps / Expected behaviour): [manual-regression-checklist-qa.xlsx](./manual-regression-checklist-qa.xlsx) (regenerate via [generate-regression-qa-xlsx.py](./generate-regression-qa-xlsx.py)).

Snapshot of coverage for [manual-regression-checklist.md](./manual-regression-checklist.md) against `*.test.ts(x)`, `*.integration.ts`, and `apps/sim/scripts/test-*-e2e.ts`.

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
2. Output-contract dump in CI against `version-6.1-main` baseline.
3. Thin Arena task tool `transformResponse` tests with mocked HTTP (one op per group).
4. Image Fusion / P2 Docs / SpyFu output-contract smoke (no live calls).
