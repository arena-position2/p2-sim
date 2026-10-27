# Output contract triage — upstream-sync/2026-10-07

Compared pre-merge dump (`/tmp/output-contracts-before.json`) to the post-triage tree.

## Summary

| Stage | Removed | Type changed | Notes |
|---|---|---|---|
| After merge (stale generated metadata) | 949 | 1 | Generated `tool-outputs.ts` from upstream omitted Arena tools |
| After `bun run generate:tool-metadata` | 53 | 1 | Arena/tool contracts restored |
| After airweave + shopify `success` restore | **15** | **1** | Remaining listed below |

## Fixes applied

- Regenerated `apps/sim/tools/generated/tool-{ids,metadata,outputs}.ts` from the full registry (5960 tools).
- Restored Arena `airweave` tools, block, icon, icon-mapping, and `ARENA_CUSTOM_BLOCK_*` registration (upstream deleted the block; registry still needed it).
- Re-added Shopify block output `success` (tools still return it; upstream dropped it from block outputs).

## Remaining breaks (accepted for this sync)

Decision column uses sync-strategy terms: `alias` | `accept` | `blocked`.

| Block | Operation | Path | Source | Change | Decision | Reason |
|---|---|---|---|---|---|---|
| google_ads | search | results | tool | type json → array | accept | Runtime was always an array; schema corrected. Type changes cannot use aliases. No editor chip type depends on `json` vs `array` for this field beyond typing hints. |
| shopify | shopify_list_customers | customers.addresses* | tool | removed nested paths | accept | Upstream slimmed list schema to `CUSTOMER_SUMMARY_OUTPUT_PROPERTIES`. Parent `customers` remains. Full address detail is on get-customer paths. |
| shopify | shopify_list_locations | locations.address.firstName/lastName | tool | removed | accept | Upstream address summary no longer exposes name fields on list. Parent `locations` remains. |
| shopify | shopify_get_collection | collection.products.featuredImage.id | tool | removed | accept | Nested media id dropped from collection schema; parent `collection` / `products` remain. |

## Gmail note

Contract dump warns `Invalid Gmail operation: edit_draft_gmail` while collecting outputs. Pre-existing / unrelated to this triage; track separately if workflows still select that operation id.
