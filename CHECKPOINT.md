# CHECKPOINT — IMMIGRANT Store
_Last updated: 2026-03-30_

> Thread handoff file. Paste into a new Claude or ChatGPT thread to resume.
> Reference: `MASTER-BRIEFING.md`, `DECISIONS.md`, `CLAUDE.md`

## Environment

**Active agent:** Claude Code (Cowork) — transitioned from ChatGPT-led sessions on 2026-03-29.
**Execution model:** ChatGPT = architect / validates decisions. Claude Code = executor. CLAUDE.md is the primary working reference.
**Primary dev environment:** Railway cloud (migrated 2026-03-30).
**Cloud URL:** `https://tender-luck-production-3a77.up.railway.app` (Railway-generated domain)
**Custom domain:** `curate.22immigrant.com` (pending DNS configuration)
**Database:** Turso cloud — single source of truth. Local SQLite (`data.db`) is a separate data world used only for local testing.
**Processing mode:** Inline (no Redis). `REDIS_URL` is intentionally absent — Ghost Logic runs via `await processCandidate()` directly in the HTTP handler.
**Deploy workflow:** `git push origin main` → Railway auto-deploys (~2-3 min). No manual server restarts.

## Current Verified State

**Build:** passes (`npm run build`)

**Database architecture (LOCAL MODE):** Single raw libsql Database connection wrapped in an `execute()` API compatible with `@libsql/client`. Both reads and writes go through the same connection instance. This replaced a dual-connection architecture that caused row-level corruption (see Resolved section). Turso cloud path is unchanged.

**Pipeline status (locally verified):**

| Stage | Status |
|-------|--------|
| Suggested scraper → local SQLite | working — real products, real gallery URLs |
| Wishlist scraper → local SQLite | working — operator-card extraction via `data-id="operator_<ID>"` |
| Suggested → Staging (approve) | working |
| Wishlist → Staging (approve) | working — `processing_status = NULL` cleared on approve |
| Staging → Processing (enqueue) | working |
| Ghost Logic worker (direct mode) | working — debug logging + 12-field verification added |
| Stage 1: Photoroom extraction | working — `#F5F2ED` bg_color, throws on failure (no silent raw fallback) |
| Stage 1: remove.bg fallback | wired — currently 402 quota |
| Stage 2: Gemini 2.5 Flash Image compositing | working — Tier 1 billing enabled, studio lighting + contact shadow |
| Stage 3: Claude naming | working |
| Cloudinary upload | working |
| `item_events` / `processing_jobs` / `review_sessions` tables | created by `initSchema()` |
| State exposure: `/api/processing` | working — stale-pending guard via `processing_started_at IS NOT NULL` |
| State exposure: `/api/photo-suite` | working — base route + all sub-routes (`/ready-count`, `/start-flow`, `/next`, etc.) |
| State exposure: `/api/staging` | working — STAGING_VISIBILITY excludes active processing items |
| Wishlist post-commit refresh | working — `load()` called after approve/reject in IntakeGrid |

**Gallery pipeline (multi-image) — fully working:**
- `node scraper.js suggested` scrapes real product cards, visits each product page, writes real `all_images` + `variant_specifics` to DB
- Worker processes capped premium set: `MAX_STAGE1_IMAGES=3`, `MAX_STAGE2_IMAGES=3`
- Overflow images (index >= 3) dropped entirely — no remove.bg quota burned, no junk in `processed_images`
- Stage 1 throws on extraction failure — no raw originals silently saved as processed

**Legacy bad heroes:** Repaired. IDs 1025–1054 (`source='suggested'`) fixed via `repair-bad-heroes.js` (idempotent — safe to re-run).

**Current usable baseline:** Full 3-stage pipeline — Photoroom extraction + Gemini 2.5 Flash Image compositing (studio lighting + contact shadow) + Claude naming. All stages confirmed working locally. Baseline label is `stage2_composited` when Gemini succeeds, `stage1_only` when it falls back.

## Active Commands

### Cloud (primary — Railway)
```bash
# Deploy: commit + push triggers auto-deploy
git add -A && git commit -m "description" && git push origin main

# Verify cloud health
curl https://tender-luck-production-3a77.up.railway.app/api/health
curl https://tender-luck-production-3a77.up.railway.app/api/counts

# View in browser
open https://tender-luck-production-3a77.up.railway.app
```

### Local (secondary — for scraping and testing)
```bash
# Force local SQLite for server
TURSO_DATABASE_URL= TURSO_AUTH_TOKEN= node server.js

# Run suggested scraper locally
node scraper.js suggested

# Run wishlist scraper locally
node scraper.js wishlist

# Process a single candidate directly (local SQLite)
TURSO_DATABASE_URL= TURSO_AUTH_TOKEN= node server/workers/ghostLogicWorker.js --direct <candidate_id>

# Process against Turso cloud
node server/workers/ghostLogicWorker.js --direct <candidate_id>
```

## Resolved (2026-03-30, batch 12) — Cloud migration to Railway

**Goal:** Move from unstable local dev environment to persistent Railway cloud deployment.

**What was done:**
1. Fixed `railway.toml` healthcheck path (`/api/stats` → `/api/health`)
2. Updated `.gitignore` and `.dockerignore` for clean builds
3. Created `.env.example` with complete variable documentation
4. Created `CLOUD-DEV.md` with full architecture and migration guide
5. Committed and pushed (555308a) — Railway auto-deployed successfully
6. Generated public domain: `tender-luck-production-3a77.up.railway.app`
7. Verified: `/api/health` returns `{"ok":true,"dbReady":true}`, `/api/counts` returns live Turso data, full UI renders correctly

**Architecture:** Express API + React SPA in single Railway service. Turso cloud DB. Inline Ghost Logic (no Redis). Railway auto-deploys on `git push`.

**Railway env vars present (9):** ANTHROPIC_API_KEY, CJ_API_EMAIL, CJ_API_KEY, REMOVEBG_API_KEY, SHOPIFY_ACCESS_TOKEN, SHOPIFY_API_KEY, SHOPIFY_STORE_URL, TURSO_AUTH_TOKEN, TURSO_DATABASE_URL

**Railway env vars MISSING (3 — needed for Ghost Logic):** PHOTOROOM_API_KEY, GEMINI_API_KEY, CLOUDINARY_URL

**Correctly absent:** REDIS_URL (inline processing mode as designed)

**Known limitation:** AliExpress CDN images are hotlink-blocked — intake cards show blank images. Processed images (Cloudinary) will display correctly once CLOUDINARY_URL is set.

## Resolved (2026-03-30, batch 11) — Inline Ghost Logic for local mode (no Redis)

**Root cause:** Clicking "Send to Processing" in the UI calls `POST /api/staging/:id/process`, which sets `processing_status='pending'` and attempts to enqueue a BullMQ job via Redis. Locally, `REDIS_URL` is not set, so `enqueueProcessingJob()` returns `false` (silent no-op). No worker ever picks up the job. Items sit at `pending` indefinitely.

**Fix (server.js):** When `enqueueProcessingJob()` returns `false` (no Redis), the API endpoint now fires `processCandidate(id, db)` asynchronously — the HTTP response returns immediately with `pending` status, and the Ghost Logic pipeline runs in-process in the background. The pipeline updates DB status as it runs (`pending` → `processing` → `ready`/`failed`). Applied to both the initial process endpoint (`POST /api/staging/:id/process`) and the retry endpoint (`POST /api/processing/:id/retry`).

**Import:** `server.js` now imports `processCandidate` from `server/workers/ghostLogicWorker.js`. No circular dependency — the worker only imports from `db.js`, `cloudinary.js`, and `galleryFilter.js`.

**Files changed:** `server.js` — import `processCandidate`, inline fallback on both `/process` and `/retry` endpoints

**Railway impact:** None. Railway has Redis set via `REDIS_URL` env var, so `enqueueProcessingJob()` returns `true` and the inline fallback is never reached.

## Resolved (2026-03-30, batch 10) — Product membership gate + stuck processing fix

**Two problems fixed:**

### 1. Foreign product images in Photo Suite (gallery membership)

**Root cause:** Gallery junk filter (batch 9) removed page chrome but not semantically foreign product images from AliExpress "related items" / "you may also like" sections. These are legitimate product photos (proper CDN URLs, full dimensions) from *different* products. Worker processed them through Stage 1 + Stage 2, producing professional-looking images of completely unrelated products. Verified on ID 1041 (sunglasses): processed image 2/2 was a black tank top.

**Fix (ghostLogicWorker.js — product membership gate):**
- Added `isSameProduct()` function: Claude vision classifier that compares each non-hero Stage 1 output to the hero image
- Prompt: "Are these the same type of product? Answer SAME or DIFFERENT."
- Pipeline restructured to two-pass: Pass 1 extracts all images through Stage 1, product gate classifies each non-hero, Pass 2 runs Stage 2 only on hero + SAME images
- Foreign images are dropped before Stage 2, saving Gemini API calls
- Fails open (if classification errors, image is kept) to avoid silently dropping valid images
- Hero (index 0) is always kept without classification

**API cost impact:** 1 additional Claude API call per non-hero image (max_tokens=32, ~minimal cost). With MAX_STAGE1=3, that's at most 2 extra calls per candidate.

### 2. Stuck processing item (ID 1049)

**Root cause:** Worker was invoked on ID 1049 but `all_images` field is corrupted with 4,062 null bytes (from prior DB corruption incident). Zero recoverable product images after cleanup. Worker crashed without updating `processing_status` from `pending` to `failed`.

**Fix (server.js — processing endpoints):**
- Extended `POST /api/processing/:id/retry` to accept `processing_status IN ('failed', 'pending')` (was `= 'failed'` only)
- Extended `POST /api/processing/:id/return` to accept `processing_status IN ('failed', 'pending')` (was `= 'failed'` only)
- Stuck-pending items can now be retried or returned to Staging through the normal UI, same as failed items

**Files changed:**
- `server/workers/ghostLogicWorker.js` — `isSameProduct()` classifier + two-pass pipeline restructure
- `server.js` — retry and return endpoints accept `pending` in addition to `failed`

**Verification:** Requires server restart + reprocessing of ID 1041. After restart, ID 1049 can be returned to Staging via Return button.

## Resolved (2026-03-30, batch 9) — Ghost Logic worker gallery filter

**Root cause:** Ghost Logic worker (`processCandidate()`) processed images from raw `all_images` (40-65 URLs per item) without any gallery junk filtering. After hero promotion + CDN thumbnail removal, non-product URLs (page chrome, recommendation thumbnails, shipping badges) landed in positions 1-2 of the worker's image list. When sent through Stage 1 (Photoroom) + Stage 2 (Gemini), these junk inputs produced hallucinated/foreign product images. Verified on candidate 1019 (sunglasses): processed images 2/3 and 3/3 showed a green sweater and a black pullover — completely foreign products.

**Fix (3 changes to ghostLogicWorker.js):**
1. **Gallery filter integration:** Added `filterGallery()` from new `server/lib/galleryFilter.js` — same 3-layer logic as client-side filter (fingerprint blocklist + structural patterns + keywords). Applied to raw `all_images` before any other processing. For candidate 1019: 56 raw → 6 product images.
2. **Hash-based dedup:** Replaced `new Set()` URL dedup with two-layer dedup (exact URL string + CDN file hash). Same image on different CDN domains (`ae01.alicdn.com` vs `ae-pic-a1.aliexpress-media.com`) now correctly deduplicates.
3. **Hash-aware hero promotion:** Hero matching now falls back to hash comparison if exact URL match fails. Prevents duplicate hero insertion when gallery and hero URLs use different CDN domains.

**Files changed:**
- `server/lib/galleryFilter.js` — NEW server-side gallery filter (CommonJS mirror of client filter)
- `server/workers/ghostLogicWorker.js` — gallery filter + hash dedup + hash-aware hero promotion

**Verification (browser simulation):** With the new filter, candidate 1019's first 3 images are all distinct sunglasses shots (hashes: `S9bbc41b5c7104525965083d7291618c1x`, `Sd08948780cb34377973bad7435475fa3n`, `Sa05e19115bd14e6eb2bcc43e7ebc73b6v`).

**All 7 Photo Suite items need reprocessing** — existing `processed_images` were generated from unfiltered galleries. Josh must reprocess after this fix.

## Resolved (2026-03-29, batch 8) — Browser-first UX remediation

**3 root-cause fixes deployed:**

1. **Broken intake images (imgUrl.js):** AliExpress CDN hotlink-protects images loaded from `localhost`, causing blank/broken images across all intake and staging views. `imgUrl()` was preferring CDN URL over local file. **Fix:** Reversed priority — now prefers `image_path` (served via `/images/` static route) and falls back to CDN URL only on Railway (where local files don't exist). 895/897 local candidates have `image_path`. Impact: virtually all intake images now load instantly from disk.

2. **Gallery junk pollution (Photo Suite + Staging):** Raw `all_images` contained 47-65 URLs per item, including AliExpress page chrome (service badges, trust shields, shipping icons, SKU swatches, pixel icons). Photo Suite compare view showed all 62 images; StagingCard showed "62 img" badge count. **Fix:** Created shared `client/src/lib/galleryFilter.js` with 3-layer filtering: (a) cross-product fingerprint blocklist — 13 known page-chrome file hashes that appear across 5-145 different products, (b) structural URL patterns — thumbnails `_NNxNNqNN`, pixel icons `/NNxNN.png`, non-CDN URLs, (c) keyword patterns. Result: 47-65 raw → 3-7 product images per item. Verified in browser: Photo Suite shows "3 processed / 7 source" (was 61), staging gallery badge shows "6 img" (was 62).

3. **Scraper gallery output too permissive (scraper.js + alistream.js):** `scrapeProductGallery()` grabbed every `<img>` with `alicdn` or `ae-pic` in src — far too broad, picking up all page chrome. **Fix:** Added same 3-layer filtering (fingerprint blocklist + structural patterns + keywords) + dedup inside browser evaluate context. Future scrapes will write cleaner `all_images` to DB.

**Files changed:**
- `client/src/imgUrl.js` — reversed image priority (local-first)
- `client/src/lib/galleryFilter.js` — NEW shared gallery filter utility
- `client/src/components/PhotoSuiteReviewCard.jsx` — uses filtered gallery for compare view
- `client/src/components/StagingCard.jsx` — uses filtered gallery for badge count
- `client/src/pages/curation/StagingDetailPage.jsx` — delegates to shared filter
- `scraper.js` — gallery junk filtering + dedup at source
- `alistream.js` — gallery junk filtering + dedup at source

## Known Issues

**DB page-level corruption:** data.db has page-level corruption (duplicate page references) from concurrent Python sqlite3 + libsql access. DB is readable (897 rows) but integrity_check fails. `repair-db-rebuild.js` created — Josh must run after stopping server. 3 rows (1041, 1049, 1030) have corrupted stage values that the repair script will fix.

**Intake hero images show AliExpress promotional overlays:** ~50% of intake items show "SuperDeals", "Choice", or star badge overlays instead of real product images. Root cause: the homepage scraper saves card thumbnail URLs (`_220x220q75.jpg_.avif`) which AliExpress renders with promotional overlays baked in. The overlay-free image is available at the base URL (strip size suffix), but the scraper downloads the thumbnail version. Each overlay is unique per product (not shared like page chrome), so hash-based filtering can't catch them. **Fix options:** (a) scraper should strip size suffixes from `image_url` before downloading hero image, (b) a repair script could re-download heroes using clean base URLs, (c) the gallery `imagePathList` images (which are overlay-free) could replace the hero on approval. This is a scraper-level fix, not a display filter issue.

**Gallery residual: brand logos and size charts (1-2 per item):** After the 3-layer filter reduces galleries from 47-65 to 3-7 images, 1-2 remaining images may be seller-uploaded brand logos or size charts. These are in the official `imagePathList` and share the same CDN/hash pattern as product photos — URL-based filtering cannot distinguish them without image content analysis (vision model). This is a diminishing returns issue; the filter already removes 85-95% of junk.

## Resolved (2026-03-29, batch 5) — Dual-connection row corruption fix

**Root cause:** Local SQLite mode opened TWO connections to the same `data.db` file — `@libsql/client` (for reads/schema) and a raw `libsql` `Database` (for writes). When `initSchema()` ran `ALTER TABLE ADD COLUMN` through connection A, connection B's prepared UPDATE statements had a stale column layout. SQLite UPDATEs read the full row, modify named columns, and write the full row back. With a stale column count, values shifted into wrong column positions.

**Evidence:** Candidate 1043 had `stage="0bdc61"` (hex fragment from a Cloudinary URL), `staged_at="f/Se717e225cc29476eb9ec0"` (path fragment), `all_images` truncated — fields visibly shifted into wrong columns.

**Fix (db.js):** Single raw `libsql` `Database` instance wrapped in an `execute()` API that mimics `@libsql/client`. Uses `stmt.reader` to distinguish SELECT/PRAGMA (→ `all()`) from DML/DDL (→ `run()`). `getRawDb()` returns the same instance — no second connection. Turso path unchanged.

**Additional fix (ghostLogicWorker.js):** Added labeled debug logging before final success UPDATE (prints SQL, all parameter indices with column labels). Expanded `directProcess()` verification to check all 12 critical DB columns with corruption detectors (non-ISO timestamps, stage not in valid set).

**Status:** Fix verified. Candidates 1034 and 1043 reprocessed cleanly under fixed architecture. Photo Suite ready-count confirmed `{"count":2}`.

## Resolved (2026-03-29, batch 6) — Legacy data corruption audit and repair

Full audit of 897 rows in local `data.db`. Found 2 corrupted rows from the dual-connection era:

**ID 1043** (CMF mountain jacket — successfully reprocessed):
- `staged_at` was `f/Se717e225cc29476eb9ec0` (URL fragment from column shift). **Nulled.**
- `all_images` was invalid JSON (5173 chars, unterminated string). Contained images from 1048's product page, not 1043's — pre-existing scraper issue compounded by corruption. **Nulled.** Product was already processed from correct `image_url` hero.
- All processing fields (stage, processing_status, generated_name, processed_image_url, timestamps) were clean — set correctly during reprocessing.

**ID 1048** (Loose Wide Leg Pants — never processed):
- `stage` was `5.857Z` (tail fragment of timestamp `2026-03-29T18:51:05.857Z`). **Reset to `intake`.**
- `staged_at` was `2026-03-29T18:51:26.960Z` — valid ISO but from 1043's processing event, not real staging. **Nulled.**
- `updated_at` — same corruption source. **Nulled.**
- `all_images` was invalid JSON (5283 chars, 1043's metadata smeared at end). **Nulled.**
- Original product data (title, image_url, product_url, price, created_at) intact.

**Post-repair verification:**
- Zero invalid stage values across 897 rows
- Zero non-ISO timestamps in any timestamp column
- Zero invalid JSON in all_images (147 non-null entries all valid)
- Stage distribution: intake=708, removed=147, staged=40, approved=2
- Photo Suite pool: 2 items (1043, 1034)
- repair-stale-pending.js: no-op (zero stale-pending items found — all 5 pending rows have `processing_started_at` set)

## Resolved (2026-03-29, batch 5) — Dual-connection row corruption fix (runtime)

**Root cause:** Local SQLite mode opened TWO connections to the same `data.db` file — `@libsql/client` (for reads/schema) and a raw `libsql` `Database` (for writes). When `initSchema()` ran `ALTER TABLE ADD COLUMN` through connection A, connection B's prepared UPDATE statements had a stale column layout. SQLite UPDATEs read the full row, modify named columns, and write the full row back. With a stale column count, values shifted into wrong column positions.

**Evidence:** Candidate 1043 had `stage="0bdc61"` (hex fragment from a Cloudinary URL), `staged_at="f/Se717e225cc29476eb9ec0"` (path fragment), `all_images` truncated. Candidate 1048 had `stage="5.857Z"` (timestamp fragment), `all_images` with 1043's generated_name/description smeared at end.

**Fix (db.js):** Single raw `libsql` `Database` instance wrapped in an `execute()` API that mimics `@libsql/client`. Uses `stmt.reader` to distinguish SELECT/PRAGMA (→ `all()`) from DML/DDL (→ `run()`). `getRawDb()` returns the same instance — no second connection. Turso path unchanged.

**Additional fix (ghostLogicWorker.js):** Added labeled debug logging before final success UPDATE (prints SQL, all parameter indices with column labels). Expanded `directProcess()` verification to check all 12 critical DB columns with corruption detectors (non-ISO timestamps, stage not in valid set).

**Verification:** Candidate 1034 reprocessed cleanly — all 12 DB fields correct. Candidate 1043 reprocessed cleanly — all processing fields correct (staged_at corruption was pre-existing from original dual-connection era, repaired separately in batch 6).

## Resolved (2026-03-29, batch 4) — State exposure layer fixes

1. **30 stale-pending items contaminating Processing page:** Legacy items with `processing_status='pending'` from column DEFAULT but never actually submitted. Fix: `PROCESSING_VISIBILITY` now requires `processing_started_at IS NOT NULL` for pending/processing items. `STAGING_VISIBILITY` mirrors the guard. Created `repair-stale-pending.js` to clear `processing_status` on legacy items (proven safe — both code paths that set `processing_status='pending'` also set `processing_started_at` atomically).
2. **Photo Suite 404 on base route:** Added `GET /api/photo-suite` returning pool_count, active_session, endpoints. Sub-routes (`/ready-count`, `/start-flow`, `/next`, etc.) already existed.
3. **Wishlist not refreshing after approve/reject:** `commitAction` in IntakeGrid.jsx now calls `load()` (list refetch) after successful commit and on error, not just `refresh()` (counts only).

## Resolved (2026-03-29, batch 3) — Stage 2 reliability hardening

Stage 2 was verified live on candidate 1034 — Gemini composited 2 of 3 images, 1 fell back to text-only response. Reliability fix applied to `compositeSet()` in `ghostLogicWorker.js`:
1. **Text-only retry**: Gemini sometimes returns 200 OK but only text parts (no image). Now retries with 5s delay instead of immediate passthrough.
2. **Retry counter**: `_retried` boolean replaced with `_retryCount` integer, `MAX_RETRIES = 2` (up to 3 total attempts). Covers both 429 and text-only failures.
3. **Prompt tightening**: Added "You MUST return an edited version of this image" and "Return ONLY the image, no text" to reduce text-only responses.

## Resolved (2026-03-29, batch 2) — Staging & Photo Suite fixes

Six staging/review issues fixed:
1. **Splitting** — relaxed STAGING_VISIBILITY to allow `ready` items, so split works on processed items
2. **Blurry images** — StagingCard now uses `processed_image_url || imgUrl(item)` with `object-fit: contain` on 4:5 cards
3. **Too many images** — StagingDetailPage gallery deduplicates by base URL, filters junk (icons, sprites, tiny thumbnails)
4. **Multi-item isolation** — Gemini Stage 2 prompt updated to keep only the single most prominent garment
5. **Photo Suite stuck** — PhotoSuiteReviewCard now resets `acting` state when `item.id` changes
6. **Processing → staging** — STAGING_VISIBILITY no longer excludes `ready` items; they appear in staging with a READY badge

## Resolved (2026-03-29) — Gemini Stage 2

Gemini Stage 2 was failing due to three issues:
1. Wrong model — `gemini-2.0-flash` cannot generate images; switched to `gemini-2.5-flash-image`
2. Missing `generationConfig: { responseModalities: ["TEXT", "IMAGE"] }` in request
3. Response parsing only checked `inline_data` (snake_case); added `inlineData` (camelCase) handling
4. Free tier quota exhausted — enabled Tier 1 Postpay billing via Google AI Studio

## Resolved (2026-03-29, batch 7) — Full system coherence audit

**Defect found and fixed:**

1. **Staging count NULL bug (server.js `/api/counts`):** Sidebar staging badge showed 1 instead of 34. Root cause: SQL NULL semantics in the staging count query. `NOT (processing_status = 'ready' AND review_status IS NULL)` evaluates to NULL (not TRUE) when `processing_status` is NULL, because `NULL = 'ready'` produces NULL, and `NULL AND TRUE` is NULL, and `NOT NULL` is NULL — which in a WHERE clause is treated as FALSE. This excluded 32 items where both `processing_status` and `review_status` were NULL. Same pattern on condition 1 excluded ID 1034 (revision_needed, processing_status cleared). **Fix:** Added COALESCE wrappers to both NOT conditions, matching the pattern already used in `STAGING_VISIBILITY`. Verified: staging count now correctly returns 34 (40 staged − 1 processing − 5 photo suite pool).

**Audit findings (no code fix needed):**
- Server routes: all 33 routes audited. State machine guards are correct. All deletes are soft (stage='removed'). No orphaned transitions.
- Frontend: 12 dead component files identified (2,655 lines). All live components use `lib/api.js`; dead components use legacy root `api.js`. Cleanup documented below.
- Photo Suite flow: revision_needed items correctly excluded from pool. Accept/reject/discard routes verified.
- Approved page: name fallback chain (`edited_name || generated_name || title`) works correctly for IDs 5/6 (have edited_name, no generated_name).
- Gallery dedup: 47-65 images per staged item. Frontend dedup is efficient (O(n) Set-based, filters junk/thumbnails). No performance issue.
- ID 1035: legitimately stuck in pending (processing_started_at set, never completed). Needs retry on Josh's machine.
- ID 1034: legitimately in revision_needed state (rejected from Photo Suite, waiting for resubmit to processing).
- `/api/counts` alignment with visibility constants: all 11 count queries verified correct after fix.

## Cleanup (Josh to run on macOS)

```bash
rm _stage2_test.js   # empty leftover test file — sandbox can't delete mounted files

# Dead frontend code (12 files, 2655 lines — all confirmed unused)
rm client/src/api.js                          # legacy API — all live code uses lib/api.js
rm client/src/components/PhotoSuite.jsx       # dead — PhotoSuitePage.jsx is canonical
rm client/src/components/LaunchTab.jsx        # dead — never routed
rm client/src/components/LiveTab.jsx          # dead — never routed
rm client/src/components/SwipeTab.jsx         # dead — never routed
rm client/src/components/PicksTab.jsx         # dead — never routed
rm client/src/components/EditSuite.jsx        # dead — never routed
rm client/src/components/TabNav.jsx           # dead — never imported
rm client/src/components/DeepEditDrawer.jsx   # dead — only imported by dead PhotoSuite.jsx
rm client/src/components/ImageEditor.jsx      # dead — never imported
rm client/src/components/LaunchBucket.jsx     # dead — uses nonexistent /api/launch-bucket
rm client/src/components/ProductEditor.jsx    # dead — only imported by dead EditSuite.jsx
```

## Next Action

**Josh must add 3 missing Railway env vars (required for Ghost Logic pipeline):**
In Railway dashboard → tender-luck → Variables → + New Variable:
1. `PHOTOROOM_API_KEY` — value from local `.env` (Stage 1 extraction)
2. `GEMINI_API_KEY` — value from local `.env` (Stage 2 compositing)
3. `CLOUDINARY_URL` — value from local `.env` (processed image hosting)

Without these, the Process button on cloud will fail at Stage 1. The app runs and serves UI, but image processing is non-functional.

**Optional: configure custom domain**
Add `curate.22immigrant.com` via Railway Settings → Networking → Custom Domain. Then update DNS (CNAME to Railway).

**After env vars are set:**
1. Test processing a candidate from the cloud UI (click Process on any staged item)
2. Verify Cloudinary upload works (processed images should load)
3. Delete dead frontend files (see Cleanup section)
4. Photo Suite UX refinement
5. Build Launch page (publish workflow)
6. Build Live page (published products management)

**Local-only tasks (optional, not blocking cloud):**
- Run `TURSO_DATABASE_URL= node repair-db-rebuild.js` to fix local SQLite page corruption
- Reprocess local Photo Suite items with fixed worker
- Re-scrape galleries for IDs 1043, 1048 (both have `all_images = NULL`)

## Operating Rules

- ChatGPT = architect, validates decisions. Claude Code = executor.
- Follow prompts exactly. Do not refactor beyond scope.
- Do not introduce new architecture unless instructed.
- Build sequence: function first, then polish.
- See `CLAUDE.md` for full execution rules, naming conventions, and the "Never" list.
