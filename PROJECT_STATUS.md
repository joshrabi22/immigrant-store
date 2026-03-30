# PROJECT STATUS — IMMIGRANT Store
_Last updated: 2026-03-29_

## System Status

| Component | Status |
|-----------|--------|
| Railway Web (server.js + React) | LIVE |
| Railway Worker (alistream.js) | LIVE — 24/7 headless Playwright |
| Ghost Logic Worker (ghostLogicWorker.js) | LIVE — BullMQ consumer on `ghost-logic-tasks` |
| Turso Database | LIVE — 670+ candidates |
| Redis / BullMQ | LIVE — processing job queue |
| Cloudinary | LIVE — processed image hosting |
| Shopify Store | 22immigrant.myshopify.com |
| DSers Fulfillment | Installed + linked |
| curate.22immigrant.com | DNS configured |
| Local SQLite (data.db) | Single-connection architecture (fixed 2026-03-29) |

## API Keys

| Key | Status | Notes |
|-----|--------|-------|
| TURSO_DATABASE_URL / TURSO_AUTH_TOKEN | OK | Cloud DB |
| SHOPIFY_API_KEY / ACCESS_TOKEN | OK | Publishing |
| CLOUDINARY_URL | OK | Image hosting |
| ANTHROPIC_API_KEY | OK | Stage 3 naming |
| GEMINI_API_KEY | OK — Tier 1 billing | Stage 2 compositing — verified live |
| PHOTOROOM_API_KEY | OK + working | Stage 1 primary |
| REMOVEBG_API_KEY | set — 402 quota | Stage 1 fallback — exhausted |
| REDIS_URL | OK | BullMQ queue |

## What's Built and Verified

### Phase 1: Taste Profiling
122 AliExpress orders → 76 clothing items → taste_profile.json

### Phase 2: Full Pipeline

**Database layer:**
- `db.js` uses single raw `libsql` `Database` connection for local mode — reads and writes share one handle. Wrapped in `execute()` API compatible with `@libsql/client` interface. Turso cloud path unchanged.
- Previous dual-connection architecture caused row-level corruption (column shift on UPDATE after ALTER TABLE). Fixed 2026-03-29.
- `initSchema` auto-adds missing columns on startup (`ensureCandidateColumns`). `CANDIDATE_COLUMNS` in `db.js` is the single source of truth.
- `@libsql/client` v0.17.2 has a known bug: `executeStmt()` uses `sqlStmt.raw(true)` to detect reader vs writer — `raw()` never throws, so `returnsData` always true. DML goes through reader path, `rowsAffected` always 0. The single-connection fix bypasses this entirely by using the raw `libsql` driver directly.

**Sourcing:**
- `scraper.js suggested` — finds real AliExpress homepage product cards, visits each product page, writes real `all_images` (JSON gallery array) + `variant_specifics` to DB
- `scraper.js wishlist` — operator-card extraction via `data-id="operator_<ID>"` from AliExpress wishlist SPA
- `alistream.js` — 24/7 Railway headless scraper (6 strategies, junk filters, gender detection, gallery scraping)

**Curation flow:**
- Suggested → Staging: approve transitions `stage = 'staged'`, clears `processing_status = NULL`
- Wishlist → Staging: same behavior, post-commit refetch via `load()` in IntakeGrid
- Staging → Processing: enqueues BullMQ job
- Ghost Logic worker: 3-stage pipeline, direct mode available with debug logging + 12-field verification

**Ghost Logic pipeline (verified):**
- Stage 1 (Photoroom): working — `bg_color` `#` prefix correct — throws on failure, no silent junk
- Stage 2 (Gemini 2.5 Flash Image): verified live — Tier 1 billing, studio lighting + contact shadow, retry on text-only and 429 (up to 3 attempts)
- Stage 3 (Claude): working — 2-word name + 1-sentence description on hero

**Multi-image gallery processing (fully implemented):**
- All gallery images scraped and stored in `all_images`
- Worker processes capped premium set: `MAX_STAGE1_IMAGES=3`, `MAX_STAGE2_IMAGES=3` (env-configurable)
- Overflow images (index >= MAX_STAGE1) dropped — no API quota burned on non-premium set
- Stage 1 failure throws cleanly → `processing_status = 'failed'` → retryable

**State exposure layer:**
- `PROCESSING_VISIBILITY`: requires `processing_started_at IS NOT NULL` for pending/processing items — excludes ~30 legacy stale-pending items
- `STAGING_VISIBILITY`: mirrors stale-pending exclusion, includes `processing_status = 'ready'` items (with READY badge)
- `PHOTO_SUITE_POOL`: `stage = 'staged' AND processing_status = 'ready' AND review_status IS NULL`
- `/api/photo-suite` base route returns pool_count, active_session, endpoints
- `/api/counts` aligned to visibility rules

**Frontend surfaces:**
- `/intake/*` — all sources, with post-commit refetch + optimistic removal + undo
- `/curation/staging` + detail — deduplication, junk filtering, processed image display
- `/curation/processing` — stale-pending items excluded
- `/review/photo-suite` — session flow (PhotoSuitePage.jsx is the routed component; PhotoSuite.jsx is dead code)
- `/review/approved` — grid + inline edit + actions + Deep Edit Drawer
- `/publish/launch` — placeholder
- `/publish/live` — placeholder

## Current Blocker

**DB page-level corruption:** data.db has page-level corruption from concurrent Python sqlite3 + libsql access. DB readable (897 rows) but integrity_check fails. 3 rows (1041, 1049, 1030) have corrupted stage values. Josh must run `repair-db-rebuild.js` after stopping server.

**Verified (2026-03-29):**
- Candidates 1034 and 1043 reprocessed cleanly under fixed single-connection architecture
- 5 additional candidates processed (1041, 1049, 1051, 1052, 1057) — all in Photo Suite pool with 3 processed images each
- 3 approved items (5, 6, 1043). Photo Suite pool: 5 items.
- Legacy data corruption audited: 2 rows (1043, 1048) repaired. Zero invalid stages, zero malformed timestamps, zero broken JSON remaining.
- Full system coherence audit: 33 API routes verified, staging count NULL bug fixed, 12 dead frontend files identified
- Browser-first UX remediation: broken intake images fixed (local-first imgUrl), gallery junk filtered (47-62→7-12 images), scraper output tightened

## Cleanup (Josh to run)

```bash
# FIRST: Stop the server, then repair DB
TURSO_DATABASE_URL= node repair-db-rebuild.js
# Rebuild client to pick up imgUrl + gallery filter changes
cd client && npm run build
# Delete dead files
rm _stage2_test.js
# Delete dead frontend code (12 files, 2655 lines)
rm client/src/api.js client/src/components/PhotoSuite.jsx client/src/components/LaunchTab.jsx
rm client/src/components/LiveTab.jsx client/src/components/SwipeTab.jsx client/src/components/PicksTab.jsx
rm client/src/components/EditSuite.jsx client/src/components/TabNav.jsx client/src/components/DeepEditDrawer.jsx
rm client/src/components/ImageEditor.jsx client/src/components/LaunchBucket.jsx client/src/components/ProductEditor.jsx
```

## Next Steps

### Immediate (Josh to run)
1. Stop server and run `repair-db-rebuild.js` (fixes 3 corrupted rows + VACUUM)
2. Rebuild client (`cd client && npm run build`) to pick up image + gallery fixes
3. Delete dead files (see Cleanup above)
4. Process ID 1035 (stuck pending — retry with `--direct 1035`)
5. Resubmit ID 1034 to processing (revision_needed state)
6. Re-scrape galleries for 1043/1048 if needed (both have `all_images = NULL` after repair)

### After verification
7. Photo Suite UX refinement
8. Build Launch page (publish workflow)
9. Build Live page (published products management)

### Later
10. End-to-end test through to Shopify
11. Naming/SKU generation system (Verdant 2345 Cloak / CLKVRD2345)
12. Visual polish: Approved/Launch/Live editorial presentation
13. Gallery interactions (drag-and-drop, fluid transitions)
14. Instagram content automation
15. Shopify Liquid theme deployment
