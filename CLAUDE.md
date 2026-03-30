# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Execution Rules

- ChatGPT acts as architect and validates all decisions
- Claude executes code changes
- Never make assumptions — follow prompts exactly
- Do not refactor beyond scope
- Do not introduce new architecture unless explicitly instructed
- Build sequence: function first, then polish. Never spend time on visual refinement until the underlying pipeline is confirmed working.

## Core Vision

Immigrant Store is a fully automated, premium-feeling curation-to-commerce system for fashion and apparel products. The product is **not** meant to feel like a marketplace or generic dropshipping store — it should feel like a **luxury editorial retail system** with stylist-like guidance, premium image consistency, and soft, non-transactional UX.

The real system arc is:

**discovery → intake → curation → staging → processing → review → publish → distribution**

## Brand Identity

**Brand name:** IMMIGRANT (all caps in logo/brand marks)
**Shopify:** `22immigrant.myshopify.com`
**Canvas color:** `#F5F2ED` (bone/cream — used everywhere: product bg, UI backgrounds)
**Color palette:** bone, slate, moss, ink, earth, dust, clay, fog, rust
**Aesthetic reference:** FoundCo grid spec — 3-column, 40px gap, 4:5 ratio cards, `object-fit: contain` on `#F5F2ED` background

**Brand voice:** Sparse, confident, no hype. Copy examples: "In rotation", "Quietly considered", "Built to disappear into your wardrobe". Never "buy now", "sale", "limited time".

## Naming & SKU System

**Target product display name:** `{Adjective} {4-digit code} {Type}` — e.g., `Verdant 2345 Cloak`
**Target SKU format:** `{TYPE-3}{ADJ-3}{4-digit}` — e.g., `CLKVRD2345`
**Split children:** append `-1`, `-2` — e.g., `CLKVRD2345-1`
**Type examples:** Cloak, Wrap, Layer, Shell, Guard, Drape, Liner, Shroud

**Current operational truth:** Stage 3 (Claude Sonnet) currently generates 2-word lowercase names aligned to the brand palette ("bone", "slate", "moss" — never "white", "grey", "green") + 1-sentence description. The full `{Adjective} {4-digit code} {Type}` format is locked as the target but implementation is deferred until workflow stability is confirmed.

## Commands

### Local development (SQLite mode)
```bash
# Force local SQLite — dotenv does not overwrite shell-level env vars
TURSO_DATABASE_URL= TURSO_AUTH_TOKEN= node server.js   # Backend on :3000
cd client && npm run dev                                # Frontend on :5173
```

### Backend (root)
```bash
npm start                                              # API server (uses .env — likely Turso)
node db.js                                             # Initialize / migrate local SQLite schema
node scraper.js                                        # Scrape AliExpress orders (requires CDP Chrome)
node scraper.js suggested                              # Scrape homepage recommendations
node scraper.js wishlist                               # Scrape AliExpress wishlist
node alistream.js                                      # 24/7 continuous stream (Railway worker)
node server/workers/ghostLogicWorker.js --direct <id>  # Run Ghost Logic on one item
TURSO_DATABASE_URL= node migrate-canonical.js          # Canonical migration against local SQLite
node repair-bad-heroes.js                              # Repair bad legacy hero images (idempotent)
TURSO_DATABASE_URL= node repair-stale-pending.js       # Clear stale processing_status on legacy items (idempotent)
```

### Client
```bash
cd client && npm run dev    # Dev server on :5173 (proxies /api + /images → :3000)
npm run build               # Build React client to client/dist/
```

### Chrome for CDP scraping
```bash
open -a "Google Chrome" --args --remote-debugging-port=9222   # macOS — required before scraper.js
```

## Architecture

### Database (`db.js`)
Dual-mode: Turso cloud when `TURSO_DATABASE_URL` is set, otherwise local `data.db`.

**Local mode** uses a single raw `libsql` `Database` instance wrapped in an `execute()` API compatible with `@libsql/client`. Uses `stmt.reader` (native `statementIsReader`) to route SELECT/PRAGMA to `all()` and DML/DDL to `run()`. `getRawDb()` returns the same instance — no second connection. This replaced a dual-connection architecture (one `@libsql/client` for reads, one raw `Database` for writes) that caused row-level corruption: ALTER TABLE through connection A created columns invisible to connection B's prepared UPDATE statements, causing SQLite row reconstruction to shift values into wrong column positions.

**Turso mode** uses standard `@libsql/client` `createClient({ url, authToken })`. HTTP wire protocol. Unchanged.

**Known @libsql/client bug:** v0.17.2 `executeStmt()` uses `sqlStmt.raw(true)` to detect reader vs writer. `raw()` never throws on the raw driver, so `returnsData` is always true — DML goes through reader path, `rowsAffected` always 0. The single-connection architecture bypasses this entirely.

`initSchema()` creates all tables including canonical support tables (`item_events`, `processing_jobs`, `review_sessions`). `ensureCandidateColumns()` auto-migrates schema drift on every startup via `ALTER TABLE ADD COLUMN` — this is the single source of truth for the schema; add new columns to `CANDIDATE_COLUMNS` in `db.js`. All SQL avoids `PRAGMA`, `datetime()` defaults, and `executeMultiple` for Turso HTTP-wire compatibility.

**Local vs Turso are different data worlds.** Always confirm which DB the backend is using from startup logs. Use `TURSO_DATABASE_URL=` prefix to force local SQLite even when `.env` has Turso credentials.

### Canonical State Machine (`server.js`)
Every candidate has a `(stage, processing_status, review_status)` tuple:
- `stage`: `intake → staged → approved → launch_ready → published | removed`
- `processing_status`: `null → pending → processing → ready | failed`
- `review_status`: `null → accepted | revision_needed | discarded`

All mutations use guarded `UPDATE … WHERE id = ? AND stage = ?` — `rowsAffected = 0` means a state conflict, diagnosed via `diagnoseMutationFailure()`. Every confirmed transition appends to `item_events`.

**Visibility SQL constants** (defined in `server.js`, used in all surface queries):

`STAGING_VISIBILITY`:
```sql
stage = 'staged'
AND NOT (COALESCE(processing_status, 'none') IN ('pending', 'processing') AND processing_started_at IS NOT NULL)
```

`PROCESSING_VISIBILITY`:
```sql
stage = 'staged' AND (
  (processing_status IN ('pending', 'processing') AND processing_started_at IS NOT NULL)
  OR processing_status = 'failed'
)
```

`PHOTO_SUITE_POOL`:
```sql
stage = 'staged' AND processing_status = 'ready' AND review_status IS NULL
```

**`/api/counts` staging query** (separate from `STAGING_VISIBILITY` — adds Photo Suite exclusion):
```sql
stage = 'staged'
AND NOT (COALESCE(processing_status, 'none') IN ('pending', 'processing') AND processing_started_at IS NOT NULL)
AND NOT (COALESCE(processing_status, 'none') = 'ready' AND review_status IS NULL)
```
COALESCE is required in both NOT conditions. Without it, `NOT (NULL = 'ready' AND TRUE)` evaluates to NULL (not TRUE) due to SQL three-valued logic, silently excluding items where `processing_status` is NULL.

The `processing_started_at IS NOT NULL` guard distinguishes real pending jobs from ~30 legacy items that have `processing_status='pending'` from the column DEFAULT but were never submitted. Both code paths that legitimately set `processing_status='pending'` (`POST /api/staging/:id/process` and `POST /api/processing/:id/retry`) also set `processing_started_at` atomically. Items with `processing_status = 'ready'` are visible in BOTH Staging (with a READY badge) and the Photo Suite pool. The approve endpoint explicitly sets `processing_status = NULL` on intake→staged so new items land in Staging, not the processing queue.

### Canonical Data Model Fields
The canonical model added these columns to `candidates`:
`stage`, `review_status`, `review_session_id`, `parent_id`, `split_group_id`, `is_split_child`, `generated_name`, `generated_description`, `staged_at`, `processing_started_at`, `processing_completed_at`, `reviewed_at`, `approved_at`, `published_at`, `updated_at`

Support tables (must exist in local SQLite — `initSchema()` now creates them):
`processing_jobs`, `item_events`, `review_sessions`

Legacy rows scraped before the canonical model have `stage = NULL` and are invisible to the pipeline. Run `TURSO_DATABASE_URL= node migrate-canonical.js` to repair. The migration also remaps `source='aliexpress'` → `source='suggested'` and clears `processing_status='pending'` on intake/removed rows.

### Ghost Logic Pipeline (`server/workers/ghostLogicWorker.js`)
Post-pipeline sequencing: ingestion → quality filter → Photo Suite (Ghost Logic) → naming → review → publish

3-stage image processing:
1. **Stage 1** — Photoroom (primary) / remove.bg (fallback): extract product cutout onto `#F5F2ED`
   - Photoroom: `bg_color = "#F5F2ED"` (with `#`)
   - remove.bg: `bg_color = "F5F2ED"` (without `#`)
   - **Stage 1 throws on extraction failure — no raw AliExpress originals are silently saved as processed images**
2. **Stage 2** — Gemini 2.5 Flash Image: studio lighting + contact shadow. Billing enabled (Tier 1 Postpay). **Verified live** — candidate 1034 composited 2/3 images. Up to 3 total attempts (MAX_RETRIES=2) covering both 429 (20s delay) and text-only responses (5s delay). Falls through to Stage 1 output on failure (non-fatal passthrough).
   - Model: `gemini-2.5-flash-image` (not `gemini-2.0-flash` — the base model cannot generate images)
   - Request must include `generationConfig: { responseModalities: ["TEXT", "IMAGE"] }`
   - Response parsing handles both `inlineData` (camelCase) and `inline_data` (snake_case)
   - Prompt includes "You MUST return an edited version of this image" + "Return ONLY the image, no text"
   - Compositing prompt: *"Place this garment on a flat, infinite #F5F2ED background. Lighting: Soft, high-key studio light from the top-left. Shadow: Generate a subtle, realistic contact shadow beneath the item where it touches the ground. The shadow should be soft and diffuse. Ensure the garment's texture and color remain 100% true to the original. Crop: Center the item with 10% breathing room on all sides."*
3. **Stage 3** — Claude Sonnet: generate a 2-word product name (lowercase, palette-aligned — e.g. "bone", "slate", "moss") + 1-sentence description in brand voice. **The full `{Adjective} {4-digit code} {Type}` naming/SKU system is the target format but is not yet implemented in Stage 3** — deferred to post-workflow-stability refinement pass.

**Baseline labels** (tracked explicitly, not as failure state):
- `stage2_composited` — Stage 2 succeeded (current baseline when Gemini responds)
- `stage1_only` — Stage 2 fell back to Stage 1 output
- `degraded` — hero is still a raw AliExpress URL (pipeline failed to run)

**Worker debug logging:** Final success UPDATE in `processCandidate()` logs SQL + all parameter indices with column labels. `directProcess()` verification checks 12 critical columns with corruption detectors (non-ISO timestamps, stage not in valid set). This logging is retained as a diagnostic safety net.

Caps: `MAX_STAGE1_IMAGES = 3`, `MAX_STAGE2 = 3`. Overflow images are dropped, not processed.

**Photo Suite quality rules** (applied inside `processCandidate()`):
0. Gallery junk filter: `filterGallery()` from `server/lib/galleryFilter.js` removes page chrome, structural junk, non-CDN URLs BEFORE any other processing. Same 3-layer logic as client filter. Without this, Photoroom+Gemini hallucinate foreign products from junk inputs.
1. Hero promotion: `image_url` moved to index 0 of gallery (hash-aware — matches across CDN domains)
2. Hash-based dedup: same image on different CDN domains (`ae01.alicdn.com` vs `ae-pic-a1.aliexpress-media.com`) deduplicates by `/kf/` hash
3. Variant deprioritization: `variant_specifics` color-variant URLs pushed after non-variant alternates
4. CDN thumbnail filter: removes images with either dimension below 400px from non-hero slots
5. **Product membership gate** (between Stage 1 and Stage 2): Claude vision classifier compares each non-hero Stage 1 output to the hero. Images classified as DIFFERENT product type are dropped before Stage 2. Catches "related items" / "you may also like" product photos that pass the structural junk filter but belong to different products. Fails open on error (keeps image). Hero always kept without classification.

### Intake Sources
Valid sources: `suggested`, `watched`, `past_order`, `reverse_image`, `wishlist`. Served by `GET /api/intake/:source` querying `WHERE source = ? AND stage = 'intake'`. Scrapers must insert with `stage = 'intake'` explicitly — the table has no default for that column.

### Wishlist Scraping (`scraper.js`)
AliExpress wishlist (`/p/wish-manage/index.html`) is a React SPA that does **not** use `<a href="/item/...">` links. Extraction signals:
- Product ID: `data-id="operator_<ALI_PRODUCT_ID>"` on action overlay divs
- Title: `span[class*="sideTitleText"]`
- Image: CSS `background-image` on `div[class*="pictureUrl"]`
- Price: `div[class*="price--price"]` textContent (individual char spans — use textContent stripped to digits)

### Client (`client/src/`)
React 19 + React Router 7 SPA. Vite proxies `/api/` and `/images/` to `:3000`. Pages map to pipeline stages: Intake → Staging → Processing → Photo Suite → Approved → Launch → Live. `CountsContext` polls `/api/counts` for sidebar badge numbers. **Initial Suggestions** is the label for `source='suggested'`; **Wishlist** is `source='wishlist'`.

**Photo Suite routing:** `PhotoSuitePage.jsx` (in `pages/review/`) is the routed component at `/review/photo-suite` — it uses `lib/api.js` endpoints. `PhotoSuite.jsx` (in `components/`) is **dead code** referencing a nonexistent `/api/photo-suite/queue` endpoint — NOT routed in App.jsx.

**Dead code (pending deletion):** 12 files (2,655 lines) in `client/src/` are unused: `api.js` (legacy API helper), `PhotoSuite.jsx`, `LaunchTab.jsx`, `LiveTab.jsx`, `SwipeTab.jsx`, `PicksTab.jsx`, `EditSuite.jsx`, `TabNav.jsx`, `DeepEditDrawer.jsx`, `ImageEditor.jsx`, `LaunchBucket.jsx`, `ProductEditor.jsx`. All live components import from `lib/api.js`. See CHECKPOINT.md Cleanup section for deletion commands.

**IntakeGrid behavior:** Approve/reject uses optimistic removal with 5s undo window. After commit, calls `load()` (refetch list) + `refresh()` (update sidebar counts). Both called on success and error to stay in sync with server truth.

**Image display (`imgUrl.js`):** Prefers local `image_path` (served via `/images/` express.static route) over AliExpress CDN `image_url`. AliExpress CDN hotlink-protects images loaded from `localhost`, causing broken images in local dev. 895/897 candidates have `image_path`. Falls back to CDN URL on Railway where local files don't exist.

**Gallery filtering (`lib/galleryFilter.js`):** Shared utility for 3-layer gallery filtering: (1) cross-product fingerprint blocklist — 13 known page-chrome file hashes appearing in 5-145 products, (2) structural URL patterns — thumbnails, pixel icons, quality-suffixed variants, (3) keyword patterns. Reduces 47-65 raw images to 3-7 real product images per item. Used by PhotoSuiteReviewCard (compare view), StagingCard (badge count), and StagingDetailPage (gallery editor). Same blocklist + patterns applied at scraper level (scraper.js, alistream.js) before writing to DB.

### Queue (`server/lib/processingQueue.js`)
BullMQ on Redis (`ghost-logic-tasks` queue). Falls back gracefully when Redis unavailable — jobs stay as `processing_status = 'pending'` in DB, consumed via `--direct` mode.

### Ghost Edit / Deep Edit (`server.js` + client)
Ghost Edit is a per-card surgical edit flow — separate from the Photo Suite batch swipe. A ✦ Ghost Edit action per card in the Staging/My Picks view opens a Deep Edit drawer. Used for: name fix, gallery curation, variant split. Does not re-run the full processing queue. This is a locked workflow decision.

### SKU Splitter
Two-tap confirm pattern: first tap arms the split, second tap confirms (auto-disarms after 3s). On split:
- Target image removed from parent `all_images`
- Child row created with `variant_specifics` JSON (color property ID + sizes)
- Child: `is_split_child = 1`, `parent_id` set to parent row ID
- Split children SKU suffix: `2345-1`, `2345-2`

### AliExpress Scraping
`scraper.js` uses CDP (`http://localhost:9222`) against a real logged-in Chrome session. `alistream.js` runs headless Playwright for 24/7 ingestion on Railway with a 3-layer junk filter (title keywords → red banner pixel check → Claude vision classifier). Claude API (Sonnet) is used in three places: Stage 3 naming, gender detection in alistream junk filter, and vision-based junk classification.

### Deployment (Railway)
- **Web service**: `node server.js` — Express API + React static build from `client/dist/`
- **Worker service**: `node alistream.js` — continuous scraper
- **Database**: Turso (Railway filesystem is ephemeral — never use local SQLite on Railway)

Uses Turso (Railway filesystem is ephemeral). `server.js` connects to DB asynchronously after Express starts to survive Railway healthcheck timing. Native modules (`sharp`, `canvas`) declared as `optionalDependencies` so Railway build succeeds even if they fail to compile.

## Future-Facing (Do Not Build Unless Explicitly Instructed)

### Pulls System
Customer-facing pre-decision collection layer. Replaces cart as first customer interaction. A "Pull" is a saved shortlist — not a cart, not a wishlist. Language must stay non-transactional ("pull it", "saved", "in your pull"). Never implement Pulls directly into the active build state unless explicitly requested.

### Dual Swipe Layers
Internal curation swipe (current) + future customer-facing swipe. Customer layer is discovery, not purchase intent.

### Instagram Content Engine
Automated editorial content generation from curated products. Not in scope for Phase 1.

## Naming Conventions

- **Source values**: use only `suggested`, `wishlist`, `watched`, `past_order`, `reverse_image`. Do not resurrect `aliexpress` as an application-level source.
- **Stage values**: `intake`, `staged`, `removed`, and downstream review/publish stages. Stage is the source of truth — do not invent parallel workflow flags.
- **Components**: PascalCase, named by domain responsibility (`WishlistPage`, `IntakeGrid`, `GalleryEditor` — not `CardThing`, `Manager`).
- **Scripts**: imperative/descriptive (`migrate-canonical.js`, `repair-bad-heroes.js`).
- **Log style**: scoped and specific — `[ghost][1054] hero promoted`, `[ghost][1054] Gemini 429 retry`, `[ghost][1054] baseline stage1_only`. Avoid vague logs.

## The "Never" List

### DB / environment
- Never mix Turso and local SQLite mentally. Always confirm from startup logs.
- Never open two connections to the same local SQLite file. The single-connection architecture in db.js exists because dual handles caused row-level corruption via stale column layouts on UPDATE after ALTER TABLE.
- Never debug UI state without checking the API response first.
- Never assume the server is using local SQLite just because you want it to.
- Never assume old local data is canonical — it required migration.
- Never assume `processing_status='pending'` means a real job is running. Legacy items have pending from column DEFAULT but were never submitted. Check `processing_started_at IS NOT NULL` to distinguish.
- Never use bare `NOT (processing_status = 'value' AND ...)` in SQL WHERE clauses. When `processing_status` is NULL, the comparison returns NULL, and `NOT NULL` is NULL (excluded by WHERE). Always use `COALESCE(processing_status, 'none')` in NOT conditions.

### Backend / schema
- Never rely on migration-only tables existing in local SQLite. `initSchema()` must create canonical support tables.
- Never leave freshly approved intake items with `processing_status='pending'` — they route to Processing, not Staging.
- Never return 500 after a successful stage UPDATE just because event logging failed.
- Never forget that local legacy rows may use old source name `aliexpress`.
- Never add columns to `candidates` anywhere except the `CANDIDATE_COLUMNS` array in `db.js`.

### Scraping / ingestion
- Never assume AliExpress wishlist uses `/item/` anchors. It is JS-driven and operator-card based.
- Never trust legacy scraper hero selection blindly — validate against small-dimension URL patterns.
- Never treat small UI assets, logos, stars, or text sprites as product heroes.
- Never do a broad rebuild when a targeted repair script will safely fix a known bad batch.
- Never display raw `all_images` without filtering through `lib/galleryFilter.js`. AliExpress pages contain 40-65 images per product, most of which are UI junk.
- Never process raw `all_images` in the Ghost Logic worker without filtering through `server/lib/galleryFilter.js` first. Without filtering, Photoroom+Gemini turn page chrome/recommendation thumbnails into hallucinated foreign product images (verified: sunglasses listing produced sweater + pullover processed images).
- Never show CDN image counts to users (e.g. "62 img" badge). Always use filtered counts.

### Photo pipeline
- Never confuse provider-specific color formatting: Photoroom uses `#F5F2ED`, remove.bg uses `F5F2ED`.
- Never mark Stage 2 as working when it is only falling back to Stage 1 output.
- Never treat `stage1_only` as a mystery failure — it is the accepted baseline right now.
- Never silently save raw AliExpress originals as processed images — Stage 1 must throw on failure.
- Never skip the product membership gate between Stage 1 and Stage 2. AliExpress "related items" product photos pass the gallery junk filter but are from different products entirely. Without the gate, Photoroom+Gemini produce professional images of foreign products that contaminate Photo Suite.

### UX / product direction
- Never make the brand feel like generic dropshipping.
- Never use hard marketplace language where stylist/editorial language is intended.
- Never implement future-facing product ideas (e.g. Pulls, dual swipe, content engine) directly into the active build state unless explicitly requested.
- Never use promotional copy ("buy now", "sale", "limited time") — brand voice is sparse and confident.

## Current State

**Working:**
- Single-connection local SQLite architecture (db.js) — fixes dual-connection row corruption
- Full 3-stage Ghost Logic pipeline: Photoroom + Gemini 2.5 Flash Image + Claude naming
- Wishlist ingestion, rendering, Approve/Reject, and Staging routing (with post-commit refetch)
- Local canonical migration complete (suggested + wishlist coexist)
- Staging API returns staged items correctly (stale-pending items excluded)
- Processing API excludes legacy stale-pending items via `processing_started_at IS NOT NULL` guard
- Photo Suite API: base route + all sub-routes (`/ready-count`, `/start-flow`, `/next`, etc.)
- Legacy bad heroes for Suggested rows 1025–1054 repaired (`repair-bad-heroes.js`)
- `initSchema()` creates all canonical support tables (`item_events`, `processing_jobs`, `review_sessions`)
- Approve endpoint clears `processing_status = NULL` on intake→staged transition
- Worker debug logging: final UPDATE parameter tracing + 12-field corruption detection
- Local-first image display (imgUrl.js) — prefers image_path over CDN, fixes broken intake images
- Gallery junk filtering (client lib/galleryFilter.js + server/lib/galleryFilter.js) — 3-layer filter: fingerprint blocklist + structural patterns + keywords → 47-65 raw images reduced to 3-7 product images. Applied at both display layer (client) and processing layer (Ghost Logic worker).
- Product membership gate (ghostLogicWorker.js) — Claude vision classifier between Stage 1 and Stage 2. Compares each non-hero extracted image to hero. Drops foreign product images from "related items" sections that pass structural junk filter. Prevents Photo Suite contamination.
- Processing endpoints accept stuck-pending items — `/api/processing/:id/retry` and `/api/processing/:id/return` now handle `processing_status IN ('failed', 'pending')` instead of only `'failed'`
- Inline Ghost Logic for local mode — when Redis/BullMQ is unavailable (local dev), `POST /api/staging/:id/process` and `/api/processing/:id/retry` run the Ghost Logic pipeline directly in-process (async, non-blocking). No manual `--direct` needed. Railway unaffected (uses Redis).
- Scraper-level gallery filtering (scraper.js + alistream.js) — same 3-layer filter applied before DB write

**Verified on user's machine:**
- Candidate 1034 reprocessed cleanly under fixed single-connection architecture — all 12 DB fields correct
- Candidate 1043 reprocessed cleanly — all processing fields correct (legacy staged_at corruption repaired separately)
- Photo Suite ready-count endpoint returns `{"count":2}` (1034 + 1043)
- Legacy data corruption audit: 897 rows inspected, 2 corrupted rows (1043, 1048) repaired. Post-repair: zero invalid stages, zero malformed timestamps, zero invalid JSON.
- repair-stale-pending.js: confirmed no-op on local DB (zero stale-pending items)
- `_stage2_test.js` needs manual deletion (empty file, sandbox can't rm mounted files)
- Full system coherence audit completed (2026-03-29): 33 API routes verified, all state machine guards correct, all deletes are soft, staging count NULL bug fixed, 12 dead frontend files identified for cleanup
- 5 items processed through Ghost Logic (1041, 1049, 1051, 1052, 1057) — all in Photo Suite pool with 3 processed images each
- 3 approved items (5, 6, 1043) — IDs 5/6 have edited_name but no generated_name (UI handles correctly)
- Stage distribution: intake=707, removed=147, staged=40, approved=3
- Photo Suite pool: 5 items (1041, 1049, 1051, 1052, 1057)
- ID 1035: stuck pending (needs retry). ID 1034: revision_needed (correct workflow state, needs resubmit)

**Known constraints:**
- Stage 2 / Gemini 2.5 Flash Image is verified live (Tier 1 billing enabled). Baseline is `stage2_composited`. Gemini is non-deterministic — text-only responses occur occasionally, handled by retry (up to 3 attempts).
- Local environment is the active testing environment
- 670+ candidates in Turso cloud; local `data.db` is a separate data world (897 rows locally)
- Native `libsql` module required for local mode — cannot run in sandbox environments without matching architecture
- Candidates 1043 and 1048 have `all_images = NULL` after corruption repair — re-scrape galleries if needed
